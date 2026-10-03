# NexioSchedule for Redmi Watch 6（课程表手环端）

Redmi Watch 6 适配版课程表手环端——在小米手环/手表上显示手机推送的课程表。

## 项目定位

本项目 fork 自 [Alittlejelly/NexioSchedule-for-MiBand](https://github.com/Alittlejelly/NexioSchedule-for-MiBand)，
针对 **Redmi Watch 6（432×514）** 做屏幕适配与使用体验定制；上游负责协议兼容与基础功能，
本仓库在其之上叠加独立的定制层（补丁链方式维护，见文末「与上游关系」）。

## 与上游的定制差异

- **432×514 屏幕适配**：designWidth 与布局尺寸按 Redmi Watch 6 重排，铺满小屏
- **纯被动同步**：只等手机端推送，收到即回 ACK；不主动轮询、不重试，省电
- **时段分组圆角卡片**：课程列表按上午/下午/晚上分组成圆角卡片，易扫读
- **手势分区**：课表区左右滑切日期、顶部日期区右滑退出/左滑进关于页；坐标不可用时安全退化为全屏切日，绝不误退出
- **Tab 紧凑化**：悬浮 Tab 容器收窄、图标大小不变、点击热区不减
- **去打赏入口**：移除关于页打赏二维码
- **时钟最小定时**：页面定时器只刷本地时钟与诊断，省电
- **关于页诊断**：未连接手机时显示「手机未连接」状态

## 配套手机端

需配合 [xiaoxun007/NexioSchedule](https://github.com/xiaoxun007/NexioSchedule)（手机端 App）使用：
手机端点「推送到手环」或课表变更时自动推送到本手环端；手环回 ACK 后手机端给出
推送确认（Snackbar / 诊断）。两端共用同一签名证书与包名 `com.haooz.chedule`。

## 安装

从 [Releases](https://github.com/xiaoxun007/NexioSchedule-for-Redmiwatch6/releases) 下载
`NexioSchedule-rw6-v*.rpk`，经小米运动健康/小米 AIoT-IDE 开发者工具导入到 Redmi Watch 6。

## 版本规则

- Release tag = `v{上游versionName}-gh{n}`：同一上游版本下自增 gh 计数
- 上游发布新版本后 tag 前缀变化，gh 计数从 1 重新计
- versionCode = 上游 versionCode × 100 + gh{n}
- 资产名固定 `NexioSchedule-rw6-v{上游versionName}-gh{n}.rpk`

## 构建

```bash
npm ci
npx aiot build
```

产物在 `dist/` 下，签名使用仓库 `signing/` 内入库的 debug 证书（与手机端同证书 SHA1
`75:47:C9:F5:54:21:AF:C8:FC:F2:A8:71:1D:DC:3C:E4:29:98:FA:87`）。

## 已向上游贡献

以下改进已整理为面向上游的 Pull Request（见
[Alittlejelly/NexioSchedule-for-MiBand PR](https://github.com/Alittlejelly/NexioSchedule-for-MiBand/pulls)）：

- PR #1 feat(sync): 收到整包回 ACK，并在断连/出错时清理重试链
- PR #2 feat(ui): 课程列表按时段分组为圆角卡片
- PR #3 feat(gesture): 按区域分区分发滑动手势
- PR #4 feat(ui): 悬浮 Tab 栏紧凑化
- PR #5 refactor(sync): 纯被动接收模式

## 与上游关系（自动同步 + 补丁链）

本仓库由 GitHub Actions 每小时自动对齐上游 `main`：reset 到上游最新后，按序重放
`patches/` 下的定制补丁（rw6-adapt → sync-stability → group-card → passive-mode →
gesture-nav → remove-reward → tab-compact），再自动构建发布 `-gh{n}`。
`patches/`、`signing/`、本 README 在同步时受保护、不会被上游覆盖。
