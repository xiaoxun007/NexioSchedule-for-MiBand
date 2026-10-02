# NexioSchedule-for-MiBand

Nexio 课程表的 **小米手环版**，基于 Vela 快应用（aiot-toolkit）开发，可在手环 / 手表端查看课程表。

已适配设备：小米手环 10 Pro（336×480）、**Redmi Watch 6（432×514，2.07″ 方形 AMOLED，本工程 `designWidth=432`）**；212×520 胶囊屏（手环 10/11）由 `../MI Band` 分支单独构建。

原作者仓库（手机端）：[HaoZai000/NexioSchedule](https://github.com/HaoZai000/NexioSchedule)

## 功能

- 手环端课程表展示（首页 / 关于 / 打赏三个视图）
- 通过 `system.interconnect` 与手机端同步课程数据，兼容手机端多种下发格式：
  - 按日期直推（`days`，手环纯映射渲染，可显示任意日期）
  - 整表（`courses` + `settings` + `times`）
  - 按周分桶（`week`，星期编号 0-6 或 1-7，可带每门课的周次规则）
- 教学周、单双周 / 选周、节次时间、假期与调休一律以手机下发数据为准，手环不自行推算
- 本地存储（`system.storage`）缓存课表：断开手机或冷启动后仍可查看
- 打开应用时按需向手机拉取一次，请求无响应会自动重试
- 首页显示「· 第 N 周」，关于页提供「同步诊断」（数据来源 / 收到次数 / 最近的数据格式）
- 关于页提供打赏入口（`/common/reward_qr.png`），打赏页可向右侧滑返回

## 项目结构

```
src/                 # 应用源码
  app.ux             # 应用入口
  pages/index/       # 主页面（首页 / 关于 / 打赏 三个视图，靠 isHome / isAbout / isReward 切换）
  common/            # 工具与资源（schedule / sync / util / reward_qr.png）
  manifest.json      # 应用配置
tools/               # 辅助脚本
  check-wearable-sync.mjs   # 与手机端通讯的回归检查（不需要设备）
  create_github_release.py  # 发布 GitHub Release 并上传 rpk
  release-body.md           # 上一步使用的 Release 说明
release/             # 随仓库发布的 rpk（两个分辨率）
CHANGELOG.md         # 更新日志
```

> 胶囊屏版本 `../MI Band` 的 `node_modules` 是一个指向本工程 `node_modules` 的 junction，
> 借此共用同一套 aiot-toolkit。**请不要删除本工程的 `node_modules`**，否则那边也构建不了。

## 开发环境

- Node.js
- [aiot-toolkit](https://www.npmjs.com/package/aiot-toolkit)（小米 Vela 快应用工具链）

```bash
npm install
npm run server   # 本地预览（watch）
npm run build    # 构建
npm run release  # 发布构建
```

## 测试

与手机端的通讯逻辑有回归检查（纯 Node，不需要设备，也不依赖 aiot-toolkit）：

```bash
node tools/check-wearable-sync.mjs                      # 协议 / 周次 / 调休 / 缓存
node tools/check-wearable-sync.mjs 我的课表.json         # 追加真实课表的端到端校验
```

覆盖：按周分桶（键 0-6 / 1-7）、整表、按日期直推、`data` 包裹、周次规则
（`selectedWeeks` / 单双周 / 周次范围）、假期隐藏、调休按 `followWeek` 补课、
时间与节次解析、冷启动缓存回放。

## 发布

```bash
npm run release                                                   # 生成 dist/com.haooz.chedule.release.<版本>.rpk
cp dist/com.haooz.chedule.release.<版本>.rpk "release/Nexio 课程表（小米手环10Pro）.rpk"
python tools/create_github_release.py <版本>                        # 建 Release 并上传两个 rpk
```

`release/` 下两个 rpk 随版本更新（胶囊屏那份由 `../MI Band` 构建后复制过来）。

## 签名说明

签名证书与私钥位于 `sign/` 目录（**已从仓库排除，请勿提交**）。

- `sign/debug/`   — 调试签名
- `sign/release/` — 发布签名

如需重新生成签名文件，可参考 `tools/extract-sign.ps1`。

## 版本

当前版本见 `src/manifest.json`（versionName / versionCode），历史见 [CHANGELOG.md](./CHANGELOG.md)。

## License

请遵循原作者仓库的许可协议。
