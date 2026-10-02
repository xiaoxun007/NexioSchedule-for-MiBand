/**
 * 手机端 → 手表端 同步接口层
 *
 * 对端应用：手机端课程表（包名 com.haooz.chedule，组包见其 wearable/WatchPayload.kt）
 * 主通道：@system.interconnect（小米穿戴 MessageApi ↔ 手表 @system.interconnect）
 * 本地缓存：@system.storage —— 冷启动 / 断开手机后仍可查看上次同步的课表
 *
 * ---------------------------------------------------------------------------
 * 协议（以手机端 WatchPayload.buildWeekJson 为准）
 * ---------------------------------------------------------------------------
 * {
 *   "protocol": "nexio.schedule",
 *   "version": 1,                  // 手机端组包时的协议版本（1 或 2 都支持）
 *   "action": "replace",           // replace=整周覆盖 | upsert=按天合并 | clear=清空
 *   "sentAt": 1760000000000,
 *   "scheduleName": "默认课表",
 *   "week": { "0": [ ... ], ..., "6": [ ... ] },   // 键 0-6（手表域）或 1-7（手机域）都认
 *   "holidays": [                                  // HolidayManager.Entry[]
 *     { "date": "2026-10-01", "endDate": "2026-10-07", "name": "国庆节",
 *       "type": 0, "followWeek": -1, "followWeekday": -1, "custom": false },
 *     { "date": "2026-10-10", "endDate": "", "name": "补班",
 *       "type": 1, "followWeek": 6, "followWeekday": 1, "custom": false }
 *   ]
 * }
 *
 * 课程字段：{ id, name, startTime, endTime, periods, location, teacher }
 *
 * 星期编号的两个域不需要靠 version 判断（周一到周六 1-6 完全相同，只有周日不同）：
 *   手表域 0=周日..6=周六；手机域 1=周一..7=周日。
 * 单个键看到 0 或 7 就知道是周日，看到 1-6 就是周一到周六 —— 见 weekKeyToInternal。
 * 因此 version=1(0-6)、version=2(1-7)，甚至版本号变了但键沿用 0-6，都能正确解析，
 * 不会出现「周一~周六整体错位一天」。version 只用于日志诊断。
 * holidays[].followWeekday 为手机域 1-7（1=周一 .. 7=周日），0 与 7 都按周日容错处理。
 *
 * 手表端主动要数据（手机端 WearableScheduleSync 收到 request 就整周推送，
 * 它只校验 protocol / action，不校验 version）：
 * { "protocol": "nexio.schedule", "version": 2, "action": "request", "reason": "app-open" }
 *
 * 注意：interconnect 要求手表 rpk 与手机 App 包名、签名一致。
 */

import interconnect from '@system.interconnect'
import storage from '@system.storage'
import schedule from './schedule'

const PROTOCOL = 'nexio.schedule'
/** 向手机端发请求时带的协议版本（与最新手机端对齐；解析侧对 1/2/未知版本都兼容） */
const PROTOCOL_VERSION = 2
/** 支持的 wire 版本（仅用于日志：键的编号域由键自身决定，见 weekKeyToInternal） */
const SUPPORTED_WIRE_VERSIONS = [1, 2]
/**
 * 本地缓存的内部版本号：缓存里的 week 键已经归一化成手表域 0-6，
 * 读回时命中它就不再做 wire 换算（缓存是本模块自己写的，格式由本文件保证）。
 */
const CACHE_VERSION = 0
const STORAGE_KEY = 'nexio.schedule.payload'

const ACTION = {
  REPLACE: 'replace',
  UPSERT: 'upsert',
  CLEAR: 'clear',
  REQUEST: 'request',
  ACK: 'ack'
}

/** 手机端包名（interconnect 对端；两端 package 必须一致） */
const PEER_PACKAGE = 'com.haooz.chedule'

const listeners = []
let connect = null
let ready = false
let lastError = null
let cachedQuote = ''
/** 已应用的最新同步序号 */
let appliedRev = 0
/** 主动请求同步的最小间隔，避免 onShow/重试把通道刷爆 */
const REQUEST_MIN_GAP_MS = 15000
/** 本地数据超过这个时间就认为过期，页面 onShow 时主动向手机要一次 */
const STALE_MS = 5 * 60 * 1000
/** 请求后多久没收到数据就重试，以及最多重试几次 */
const RETRY_DELAY_MS = 4000
const MAX_RETRY = 2

/** 本地缓存时间戳（0 表示当前进程还没有可用缓存） */
let cachedAt = 0
/** 同步诊断（关于页「同步诊断」展示）：最近一次数据的来源、形态、时间 */
let lastSource = ''
let lastShape = ''
let lastAt = 0
/** 请求节流 / 重试状态 */
let lastRequestAt = 0
let retryTimer = null
let retryCount = 0
/** 最近一次成功收到并应用手机数据的时间（0 = 从未收到），入站静默看门狗用 */
let lastInboundAt = 0
/** 入站静默看门狗定时器句柄 */
let watchdogTimer = null

function notify() {
  for (let i = 0; i < listeners.length; i++) {
    try {
      listeners[i]()
    } catch (e) {
      console.log('[sync] listener error', e)
    }
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function parseMessage(raw) {
  if (raw == null) return null
  if (typeof raw === 'string') {
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch (e) {
      lastError = 'invalid json'
      return null
    }
  }
  // interconnect onmessage 回调可能包一层 { data: '...' }
  if (isPlainObject(raw) && typeof raw.data === 'string' && raw.protocol == null) {
    return parseMessage(raw.data)
  }
  return isPlainObject(raw) ? raw : null
}

/**
 * storage.get 的 success 按文档直接给字符串；
 * 部分实现会包一层 { key, value } / { data }，这里统一拆出来。
 */
function readStoredValue(data) {
  if (data == null) return ''
  if (typeof data === 'string') return data
  if (isPlainObject(data)) {
    if (typeof data.value === 'string') return data.value
    if (typeof data.data === 'string') return data.data
  }
  return ''
}

/**
 * week 键 → 手表内部 week key(0-6)。
 *
 * 手机域（1=周一..7=周日）与手表域（0=周日..6=周六）只在「周日」不同：
 * 周一到周六两个域都是 1-6，周日则是 0（手表域）或 7（手机域）。
 * 因此单个键本身就能自我描述，不需要依赖 version：
 *   0 或 7 → 周日(0)；1..6 → 原值；其余非法。
 * 这样 v1(0-6)、v2(1-7)，甚至 v2 沿用 0-6 键都能正确解析，
 * 且对已归一化的缓存数据是幂等的（0-6 再映射一次还是 0-6）。
 */
function weekKeyToInternal(key) {
  const n = parseInt(key, 10)
  if (isNaN(n)) return -1
  if (n === 0 || n === 7) return 0
  return n >= 1 && n <= 6 ? n : -1
}

/**
 * 由日期字符串推手表内部星期(0-6)，失败返回 -1。
 * 注意：ISO 纯日期串（如 "2026-10-08"）会被 Date 按 UTC 午夜解析，
 * 而 getDay() 按本地时区求值，负时区下会退回前一天。
 * 故这里显式按 YYYY-MM-DD 构造本地时间，与手机端「今日」页保持同一天。
 */
function internalWeekdayFromDate(dateStr) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(dateStr || ''))
  let d
  if (m) {
    d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
  } else {
    d = new Date(dateStr)
  }
  if (isNaN(d.getTime())) return -1
  return d.getDay()
}

function num(v) {
  const n = parseInt(v, 10)
  return isNaN(n) ? 0 : n
}

function normalizeCourse(item, index, dayKey) {
  if (!isPlainObject(item)) return null
  const name = item.name || item.courseName || item.title || ''
  if (!name) return null
  const startTime = item.startTime || item.start || ''
  const endTime = item.endTime || item.end || ''
  const startSection = num(item.startSection)
  const endSection = num(item.endSection)
  // 允许「只有节次、没有具体时间」的 v2 下发（时间由 times 表解析）
  if (!startTime && !endTime && !startSection && !endSection) return null

  const periods = item.periods || item.period || item.sectionText || ''
  const location = item.location || item.place || item.classroom || ''
  const teacher = item.teacher || item.instructor || ''
  const section = schedule.resolveSection(item.section, startTime)

  let id = item.id != null ? String(item.id) : ''
  if (!id) {
    id = dayKey + '-' + (startTime ? startTime.replace(':', '') : startSection) + '-' + index
  }

  const out = {
    id: id,
    name: name,
    startTime: startTime,
    endTime: endTime,
    periods: periods,
    location: location,
    teacher: teacher,
    section: section
  }
  if (startSection || endSection) {
    out.startSection = startSection
    out.endSection = endSection
  }
  if (item.isCustomTime != null || item.customStartTime || item.customEndTime) {
    out.isCustomTime = !!item.isCustomTime
    out.customStartTime = item.customStartTime || ''
    out.customEndTime = item.customEndTime || ''
  }
  // v2 可能在桶里带上每门课的周次规则（表示「没按当前周过滤」）
  if (
    item.weekType != null ||
    item.startWeek != null ||
    item.endWeek != null ||
    (Array.isArray(item.selectedWeeks) && item.selectedWeeks.length)
  ) {
    out.startWeek = num(item.startWeek)
    out.endWeek = num(item.endWeek)
    out.weekType = num(item.weekType)
    out.selectedWeeks = Array.isArray(item.selectedWeeks) ? item.selectedWeeks.slice() : []
  }
  return out
}

function normalizeCourseList(list, dayKey) {
  const out = []
  if (!Array.isArray(list)) return out
  for (let i = 0; i < list.length; i++) {
    const c = normalizeCourse(list[i], i, dayKey)
    if (c) out.push(c)
  }
  out.sort(function (a, b) {
    return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  })
  return out
}

/**
 * 校验并归一化手机端 payload
 * 成功返回 { ok: true, payload }；失败返回 { ok: false, error }
 */
function normalizePayload(raw) {
  const parsed = parseMessage(raw)
  if (!parsed) {
    return { ok: false, error: 'empty payload' }
  }
  /** 诊断用：手机原始 payload 里出现了哪些已知字段（v2 改结构时靠它一眼看出来） */
  const KNOWN_FIELDS = [
    'protocol', 'version', 'action', 'data', 'courses', 'settings', 'times', 'holidays',
    'week', 'days', 'teachingWeek', 'current_week', 'class_start_time', 'total_weeks', 'schedule_name'
  ]
  const present = []
  const unknownNames = []
  let unknownMore = false
  const parsedKeys = Object.keys(parsed)
  for (let i = 0; i < parsedKeys.length; i++) {
    if (KNOWN_FIELDS.indexOf(parsedKeys[i]) >= 0) {
      present.push(parsedKeys[i])
    } else if (unknownNames.length < 4) {
      unknownNames.push('+' + parsedKeys[i])
    } else {
      unknownMore = true
    }
  }
  const rawFields = present.concat(unknownNames).join(',') + (unknownMore ? ',…' : '')
  // v2 可能把内容包一层 data 对象：{protocol, version, action, data:{settings, times, courses, ...}}
  const msg = isPlainObject(parsed.data) ? Object.assign({}, parsed, parsed.data) : parsed
  if (msg.protocol && msg.protocol !== PROTOCOL) {
    return { ok: false, error: 'protocol mismatch: ' + msg.protocol }
  }
  // 版本只用于日志/诊断：week 键的编号域由键本身决定（见 weekKeyToInternal），
  // 因此版本升级/回退都不会导致周一~周六整体错位。
  const version = msg.version != null ? Number(msg.version) : PROTOCOL_VERSION
  if (SUPPORTED_WIRE_VERSIONS.indexOf(version) < 0 && version !== CACHE_VERSION) {
    console.log('[sync] unexpected protocol version ' + version + '，按键值自行解析')
  }

  const action = msg.action || ACTION.REPLACE
  const holidayList = normalizeHolidays(msg.holidays)
  const week = {}
  for (let i = 0; i < 7; i++) week[i] = []

  if (action === ACTION.CLEAR) {
    return {
      ok: true,
      shape: '清空 字段[' + rawFields + ']',
      payload: {
        protocol: PROTOCOL,
        version: CACHE_VERSION,
        action: ACTION.CLEAR,
        sentAt: msg.sentAt || Date.now(),
        savedAt: msg.savedAt || 0,
        quote: msg.quote || '',
        holidays: holidayList,
        week: week
      }
    }
  }

  // 整表模式：手机一次推「整学期课程 + 学期设置 + 节次时间」，
  // 由手环自己算教学周并按周次规则过滤（见 schedule.setFullSchedule）。
  if (Array.isArray(msg.courses)) {
    const st = isPlainObject(msg.settings) ? msg.settings : {}
    return {
      ok: true,
      shape:
        '整表 字段[' +
        rawFields +
        '] 课' +
        msg.courses.length +
        ' 周' +
        (st.current_week != null ? st.current_week : st.teachingWeek != null ? st.teachingWeek : '?') +
        '/' +
        (st.total_weeks != null ? st.total_weeks : '?') +
        ' 假' +
        holidayList.length,
      payload: {
        protocol: PROTOCOL,
        version: CACHE_VERSION,
        action: action,
        sentAt: msg.sentAt || Date.now(),
        savedAt: msg.savedAt || 0,
        quote: msg.quote || '',
        scheduleName: String(msg.schedule_name || msg.scheduleName || ''),
        holidays: holidayList,
        mode: 'full',
        courses: msg.courses,
        settings: st,
        times: isPlainObject(msg.times) ? msg.times : {}
      }
    }
  }

  // 按日期直推（方案 2）：days = 「日期 → 当天已解析好的课程」，
  // 手环纯映射渲染，不做周次/节次/假期任何推算。
  const daysArr = Array.isArray(msg.days) ? msg.days : null
  const datesMode =
    isPlainObject(msg.days) || (daysArr && daysArr.length > 0 && daysArr[0] && daysArr[0].date != null)
  if (datesMode) {
    const dayCount = daysArr ? daysArr.length : Object.keys(msg.days).length
    return {
      ok: true,
      shape:
        '按日期 字段[' +
        rawFields +
        '] 天' +
        dayCount +
        ' 周' +
        (msg.week != null ? msg.week : msg.teachingWeek != null ? msg.teachingWeek : '?') +
        ' 假' +
        holidayList.length,
      payload: {
        protocol: PROTOCOL,
        version: CACHE_VERSION,
        action: action,
        sentAt: msg.sentAt || Date.now(),
        savedAt: msg.savedAt || 0,
        quote: msg.quote || '',
        scheduleName: String(msg.schedule_name || msg.scheduleName || ''),
        holidays: holidayList,
        mode: 'dates',
        days: msg.days,
        week: msg.week != null ? msg.week : msg.teachingWeek
      }
    }
  }

  let hasWeekFields = false
  if (isPlainObject(msg.week)) {
    const keys = Object.keys(msg.week)
    for (let i = 0; i < keys.length; i++) {
      const key = String(keys[i])
      const day = weekKeyToInternal(key)
      if (day < 0) {
        return { ok: false, error: 'invalid weekday key: ' + key }
      }
      week[day] = normalizeCourseList(msg.week[key], String(day))
      for (let j = 0; j < week[day].length && !hasWeekFields; j++) {
        const c = week[day][j]
        if (c.weekType != null || c.startWeek != null || c.endWeek != null || (c.selectedWeeks && c.selectedWeeks.length)) {
          hasWeekFields = true
        }
      }
    }
  } else if (Array.isArray(msg.days)) {
    for (let i = 0; i < msg.days.length; i++) {
      const dayItem = msg.days[i] || {}
      const day =
        dayItem.weekday != null
          ? weekKeyToInternal(dayItem.weekday)
          : internalWeekdayFromDate(dayItem.date)
      if (day < 0) {
        return { ok: false, error: 'invalid day entry index ' + i }
      }
      week[day] = normalizeCourseList(dayItem.courses, String(day))
      for (let j = 0; j < week[day].length && !hasWeekFields; j++) {
        const c = week[day][j]
        if (c.weekType != null || c.startWeek != null || c.endWeek != null || (c.selectedWeeks && c.selectedWeeks.length)) {
          hasWeekFields = true
        }
      }
    }
  } else if (action !== ACTION.ACK) {
    return { ok: false, error: 'missing week/days/courses' }
  }

  let keysText = '-'
  if (isPlainObject(msg.week)) keysText = Object.keys(msg.week).sort().join(',')
  else if (Array.isArray(msg.days)) keysText = 'days:' + msg.days.length
  let courseCount = 0
  for (let i = 0; i < 7; i++) courseCount += week[i].length

  // 快照模式也带上周次信息（teachingWeek / current_week / total_weeks / class_start_time）：
  // 桶里若还带每门课的周次规则，手环会自己按周过滤（v2 常见做法）。
  const settings = {
    class_start_time: msg.class_start_time != null ? msg.class_start_time : msg.classStartTime,
    teachingWeek: msg.teachingWeek != null ? msg.teachingWeek : msg.current_week,
    total_weeks: msg.total_weeks != null ? msg.total_weeks : msg.totalWeeks,
    morning_sections: msg.morning_sections,
    afternoon_sections: msg.afternoon_sections,
    evening_sections: msg.evening_sections
  }

  return {
    ok: true,
    shape:
      '周表 字段[' +
      rawFields +
      '] 键[' +
      keysText +
      '] 课' +
      courseCount +
      ' 假' +
      holidayList.length +
      (hasWeekFields ? ' 含周次' : ' 已按周过滤'),
    payload: {
      protocol: PROTOCOL,
      version: CACHE_VERSION,
      action: action,
      sentAt: msg.sentAt || Date.now(),
      savedAt: msg.savedAt || 0,
      quote: msg.quote || '',
      holidays: holidayList,
      mode: 'weeks',
      week: week,
      settings: settings,
      times: isPlainObject(msg.times) ? msg.times : {}
    }
  }
}

/**
 * 归一化假期/调休（兼容 HolidayManager.Entry）：
 * [{date|start, endDate|end, name, type, followWeek, followWeekday}]
 * type: 0=假期(隐藏课程) 1=调休(改上 followWeekday 的课，followWeekday 为手机域 1-7)
 */
function normalizeHolidays(list) {
  const out = []
  if (!Array.isArray(list)) return out
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!isPlainObject(item)) continue
    const start = String(item.start || item.date || '')
    const end = String(item.end || item.endDate || start)
    if (!start) continue
    const type = item.type == null ? 0 : parseInt(item.type, 10)
    const weekday = item.followWeekday == null ? -1 : parseInt(item.followWeekday, 10)
    const week = item.followWeek == null ? -1 : parseInt(item.followWeek, 10)
    out.push({
      start: start,
      end: end || start,
      name: String(item.name || ''),
      type: type === 1 ? 1 : 0,
      followWeek: isNaN(week) ? -1 : week,
      followWeekday: isNaN(weekday) ? -1 : weekday
    })
  }
  return out
}

/** 写缓存：只保留有用字段并丢掉空白天，尽量小（storage 的 value 必须是字符串） */
function compactForCache(payload) {
  if (payload.mode === 'full') {
    return {
      protocol: PROTOCOL,
      version: CACHE_VERSION,
      action: payload.action || ACTION.REPLACE,
      savedAt: payload.savedAt || Date.now(),
      quote: payload.quote || '',
      scheduleName: payload.scheduleName || '',
      holidays: payload.holidays || [],
      mode: 'full',
      courses: payload.courses || [],
      settings: payload.settings || {},
      times: payload.times || {}
    }
  }
  if (payload.mode === 'dates') {
    return {
      protocol: PROTOCOL,
      version: CACHE_VERSION,
      action: payload.action || ACTION.REPLACE,
      savedAt: payload.savedAt || Date.now(),
      quote: payload.quote || '',
      scheduleName: payload.scheduleName || '',
      holidays: payload.holidays || [],
      mode: 'dates',
      days: payload.days || {},
      week: payload.week
    }
  }
  if (payload.mode === 'weeks') {
    const w = {}
    for (let i = 0; i < 7; i++) {
      const list = (payload.week && payload.week[i]) || []
      if (list.length) w[i] = list
    }
    return {
      protocol: PROTOCOL,
      version: CACHE_VERSION,
      action: payload.action || ACTION.REPLACE,
      savedAt: payload.savedAt || Date.now(),
      sentAt: payload.sentAt || 0,
      quote: payload.quote || '',
      holidays: payload.holidays || [],
      mode: 'weeks',
      week: w,
      settings: payload.settings || {},
      times: payload.times || {}
    }
  }
  const week = {}
  for (let i = 0; i < 7; i++) {
    const list = (payload.week && payload.week[i]) || []
    if (list.length) week[i] = list
  }
  return {
    protocol: PROTOCOL,
    version: CACHE_VERSION,
    action: payload.action || ACTION.REPLACE,
    savedAt: payload.savedAt || Date.now(),
    quote: payload.quote || '',
    holidays: payload.holidays || [],
    week: week
  }
}

function persist(payload, done) {
  const value = JSON.stringify(compactForCache(payload))
  // 文档：value 为空字符串等于删除该项，所以空内容不写
  if (!value || value === '{}') {
    if (done) done(null)
    return
  }
  try {
    storage.set({
      key: STORAGE_KEY,
      value: value,
      success: function () {
        cachedAt = payload.savedAt || Date.now()
        if (done) done(null)
      },
      fail: function (data, code) {
        lastError = 'storage.set fail ' + code
        if (done) done(lastError)
      }
    })
  } catch (e) {
    lastError = String(e)
    if (done) done(lastError)
  }
}

function applyPayload(payload) {
  cachedQuote = payload.quote || ''
  if (payload.action === ACTION.CLEAR) {
    schedule.replaceWeek({})
    schedule.clearWeekState()
    schedule.setHolidays([])
    schedule.setQuote(cachedQuote)
    return
  }
  if (payload.mode === 'full') {
    // 整表模式：手环自己算周次，快照数据清掉，避免两种模式混用
    schedule.replaceWeek({})
    schedule.setFullSchedule({
      courses: payload.courses || [],
      settings: payload.settings || {},
      times: payload.times || {}
    })
  } else if (payload.mode === 'weeks') {
    if (payload.action === ACTION.UPSERT) {
      schedule.clearWeekState()
      schedule.mergeWeek(payload.week || {})
    } else {
      // 桶里带周次字段 → 手环自己按周过滤；否则就是手机已过滤的纯快照
      schedule.setWeekSnapshot({
        week: payload.week || {},
        settings: payload.settings || {},
        times: payload.times || {},
        sentAt: payload.sentAt
      })
    }
  } else if (payload.mode === 'dates') {
    schedule.setDateSchedule({ days: payload.days || {}, week: payload.week })
  } else {
    schedule.clearWeekState()
    schedule.clearDateState()
    if (payload.action === ACTION.UPSERT) {
      schedule.mergeWeek(payload.week || {})
    } else {
      schedule.replaceWeek(payload.week || {})
    }
  }
  schedule.setHolidays(payload.holidays || [])
  schedule.setQuote(cachedQuote)
}

/**
 * 手机端消息统一入口（也可被调试工具直接调用）
 * @param {string|object} raw 手机推送
 * @returns {{ok:boolean, error?:string}}
 */
function handlePhoneMessage(raw) {
  const result = normalizePayload(raw)
  if (!result.ok) {
    lastError = result.error
    console.log('[sync] reject payload:', result.error)
    return result
  }
  appliedRev += 1
  const rev = appliedRev
  result.payload.savedAt = Date.now()
  lastSource = 'phone'
  lastShape = result.shape || ''
  lastAt = result.payload.savedAt
  // 归一化成功即回 ACK（无论数据是否重复）：手机端按收到的 sentAt 匹配确认
  if (connect) {
    connect.send({
      data: {
        protocol: PROTOCOL,
        version: PROTOCOL_VERSION,
        action: ACTION.ACK,
        rev: rev,
        sentAt: result.payload.sentAt || Date.now()
      },
      success: function () {},
      fail: function (d, c) {
        console.log('[sync] ack fail', c)
      }
    })
  }
  applyPayload(result.payload)
  lastInboundAt = Date.now()
  persist(result.payload, function () {
    if (rev === appliedRev) notify()
  })
  notify()
  console.log('[sync] applied rev=' + rev + ' ' + lastShape)
  return { ok: true, shape: lastShape }
}

function handleMessageEvent(evt) {
  if (!evt) return
  // 文档：connect.onmessage 回调参数 data 为 String，实际可能是 { data }
  const raw = evt.data != null ? evt.data : evt
  handlePhoneMessage(raw)
}

function bindConnect() {
  if (!connect) return
  connect.onmessage = handleMessageEvent
  connect.onopen = function (data) {
    ready = true
    lastError = null
    console.log('[sync] interconnect open, reconnected=', data && data.isReconnected)
    requestSync('reconnect')
  }
  connect.onclose = function (data) {
    ready = false
    lastError = (data && data.data) || 'closed'
    // 通道已断：清掉挂起的重试链，避免旧定时器在重连后误触发
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    retryCount = 0
    console.log('[sync] interconnect closed', lastError)
  }
  connect.onerror = function (data) {
    ready = false
    lastError = (data && (data.data || data.code)) || 'error'
    // 通道出错：同样清掉挂起的重试链并归零计数
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    retryCount = 0
    console.log('[sync] interconnect error', lastError)
  }
}

/**
 * 向手机端请求最新课表。
 * 手机端 WearableScheduleSync 收到 action=request 会立刻整包推送；
 * 若此时手机的监听器还没绑定好，请求会石沉大海 —— 所以这里带节流 + 自动重试。
 */
function requestSync(reason, force) {
  if (!connect) return
  const now = Date.now()
  if (!force && now - lastRequestAt < REQUEST_MIN_GAP_MS) {
    console.log('[sync] request throttled (' + (reason || 'manual') + ')')
    return
  }
  lastRequestAt = now
  const body = {
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    action: ACTION.REQUEST,
    reason: reason || 'manual',
    sentAt: now
  }
  connect.send({
    data: body,
    success: function () {
      console.log('[sync] request sent (' + body.reason + ')')
      scheduleRetry()
    },
    fail: function (data, code) {
      lastError = 'request fail ' + code
      console.log('[sync] request fail', lastError)
      scheduleRetry()
    }
  })
}

/** 请求发出后若迟迟没有新数据，最多重试 MAX_RETRY 次 */
function scheduleRetry() {
  if (retryTimer) return
  const revAtRequest = appliedRev
  retryTimer = setTimeout(function () {
    retryTimer = null
    if (appliedRev !== revAtRequest) {
      retryCount = 0
      return
    }
    if (retryCount >= MAX_RETRY) {
      console.log('[sync] retry give up, 手机端没回应')
      retryCount = 0
      return
    }
    retryCount += 1
    requestSync('retry' + retryCount, true)
  }, RETRY_DELAY_MS)
}

/**
 * 入站静默看门狗：通道标记就绪后，若曾经收到过数据却超过 60s 没有任何新数据进来，
 * 说明连接「假活」（onopen 触发但消息通道实际已断）。此时置就绪为假并重新请求一次。
 * 只在 lastInboundAt>0（曾有数据）时才判断，不误杀刚连上还没收到数据的正常通道；
 * 与 5 分钟的 STALE_MS/ensureFresh 互补，这里只针对假活通道、更激进。
 */
function startWatchdog() {
  if (watchdogTimer) return
  watchdogTimer = setInterval(function () {
    if (!ready || !lastInboundAt) return
    if (Date.now() - lastInboundAt <= 60000) return
    console.log('[sync] inbound silent >60s, watchdog re-request')
    ready = false
    requestSync('watchdog')
  }, 60000)
}

/**
 * 页面 onShow 调用：数据过期（或从未同步过）就主动向手机要一次。
 * 解决「手机上点推送手表没反应」里手表这一侧的问题：
 * 打开应用/从表盘回到应用时不再被动等，而是主动拉一次。
 */
function ensureFresh(reason) {
  const tag = reason || 'ensure-fresh'
  if (!lastAt || Date.now() - lastAt > STALE_MS) {
    retryCount = 0
    requestSync(tag, true)
    return true
  }
  // 数据还新，但通道没连上时也试一次（可能刚开机/刚重连）
  if (!ready) {
    requestSync(tag)
    return true
  }
  return false
}

/**
 * 启动同步通道：先恢复本地缓存，再监听手机消息
 * 有缓存时即使手机不在身边，页面也能显示上次同步的课表。
 */
function init() {
  // 入站静默看门狗：尽早启动，用于识别「假活」通道（重复 init 不会重复起定时器）
  startWatchdog()
  // 缓存必须先读：冷启动时不依赖任何连接状态
  try {
    storage.get({
      key: STORAGE_KEY,
      success: function (data) {
        const raw = readStoredValue(data)
        if (!raw) return
        // 手机已经推过数据（更新），不要用旧缓存覆盖
        if (appliedRev > 0) return
        const result = normalizePayload(raw)
        if (!result.ok) {
          lastError = 'cache rejected: ' + result.error
          console.log('[sync] cache rejected:', result.error)
          return
        }
        cachedAt = result.payload.savedAt || 0
        lastSource = 'cache'
        lastShape = result.shape || ''
        lastAt = cachedAt
        applyPayload(result.payload)
        notify()
        console.log('[sync] cache restored, savedAt=' + cachedAt + ' ' + lastShape)
      },
      fail: function (data, code) {
        lastError = 'storage.get fail ' + code
      }
    })
  } catch (e) {
    lastError = String(e)
  }

  if (connect) return
  try {
    connect = interconnect.instance()
    bindConnect()
    connect.getReadyState({
      success: function (data) {
        ready = !!(data && data.status === 1)
        if (ready) requestSync('app-open')
      },
      fail: function (data, code) {
        lastError = 'getReadyState fail ' + code
      }
    })
  } catch (e) {
    lastError = String(e)
    console.log('[sync] init fail', lastError)
  }
}

function teardown() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  if (connect) {
    try {
      connect.onmessage = null
      connect.onopen = null
      connect.onclose = null
      connect.onerror = null
    } catch (e) {
      // ignore
    }
    connect = null
  }
  ready = false
}

/**
 * 页面订阅数据变化，返回取消函数
 */
function onScheduleChange(fn) {
  if (typeof fn !== 'function') {
    return function () {}
  }
  listeners.push(fn)
  return function () {
    const idx = listeners.indexOf(fn)
    if (idx >= 0) listeners.splice(idx, 1)
  }
}

function getStatus() {
  return {
    ready: ready,
    lastError: lastError,
    peerPackage: PEER_PACKAGE,
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    cachedAt: cachedAt,
    hasCache: cachedAt > 0 || schedule.hasSyncedSchedule(),
    rev: appliedRev,
    lastSource: lastSource,
    lastShape: lastShape,
    lastAt: lastAt
  }
}

export default {
  ACTION: ACTION,
  PROTOCOL: PROTOCOL,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  SUPPORTED_WIRE_VERSIONS: SUPPORTED_WIRE_VERSIONS,
  PEER_PACKAGE: PEER_PACKAGE,
  init: init,
  teardown: teardown,
  requestSync: requestSync,
  ensureFresh: ensureFresh,
  handlePhoneMessage: handlePhoneMessage,
  normalizePayload: normalizePayload,
  onScheduleChange: onScheduleChange,
  getStatus: getStatus
}
