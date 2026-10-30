<div align="center">

# 🚀 BuddyRelay

### CodeBuddy / WorkBuddy 多账号管理与无感切号扩展

**切号不关窗口 · 不重启编辑器 · 历史会话完全互通 · 一键签到 · 一键做任务**

[![Version](https://img.shields.io/badge/version-0.5.10-blue?style=flat-square)](https://github.com/soulvon/BuddyRelay/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)]()
[![GitHub release](https://img.shields.io/github/v/release/soulvon/BuddyRelay?color=orange&style=flat-square)](https://github.com/soulvon/BuddyRelay/releases)
[![Open VSX Downloads](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fopen-vsx.org%2Fapi%2Fsoulvon%2Fbuddy-relay&query=%24.downloadCount&label=openvsx%20downloads&color=orange&style=flat-square)](https://open-vsx.org/extension/soulvon/buddy-relay)

[📥 下载安装](#-下载与安装) •
[🖼️ 界面预览](#️-界面预览) •
[⚡ 解决什么问题](#-它解决什么问题) •
[📊 版本支持矩阵](#-版本支持矩阵) •
[✨ 核心能力](#-核心能力) •
[🖥️ 平台适配](#-平台适配) •
[⚙️ 配置说明](#-配置说明) •
[❓ 常见问题 FAQ](#-常见问题-faq) •
[💬 社区交流与支持](#-社区交流与支持)

<br>

**无需频繁重新扫码，也无需在换号时中断正在进行的会话。**

BuddyRelay 是一款面向 **CodeBuddy CN** 与 **WorkBuddy** 系列 IDE 的多账号管理扩展。通过进程级会话更新与跨账号目录软链接映射，实现**切号不关窗口、不重启编辑器、历史会话完全互通**，并提供**一键签到、一键做任务**、额度阈值守护与自动无感轮换。

</div>

---

## 📥 下载与安装

扩展包开箱即用，支持通过编辑器图形界面或命令行一键安装：

👉 **[下载 BuddyRelay 最新发布包（GitHub Releases）](https://github.com/soulvon/BuddyRelay/releases/latest)**

### 方式一：扩展面板安装（推荐）

1. 下载最新版 `buddy-relay-0.5.10.vsix`；
2. 打开 **CodeBuddy CN** 或 **WorkBuddy** 编辑器；
3. 进入左侧扩展面板（快捷键 `Ctrl+Shift+X` / macOS `Cmd+Shift+X`）；
4. 点击面板右上角 `...` 菜单 ➔ 选择 **“从 VSIX 安装...” (Install from VSIX...)**；
5. 选中下载的文件，安装完成后左侧活动栏即可看到 **BuddyRelay** 图标。

### 方式二：命令行安装

```bash
buddycn --install-extension buddy-relay-0.5.10.vsix --force
```

---

## 🖼️ 界面预览

全图形化沉浸操作，涵盖**多账号卡片流**、**实时算力看板**、**多种导入途径**与**全自动任务中心**：

### 1. 账号管理卡片流与配额仪表盘
> 核心特性：**切号不关窗口 · 不重启编辑器 · 历史会话完全互通**  
> 支持一键隐私脱敏、状态栏金币图标 🪙 实时显示、算力余额精准双包对账与低额度智能告警。

<div align="center">
  <img src="https://raw.githubusercontent.com/soulvon/BuddyRelay/main/resources/preview-dashboard.webp" width="480" alt="BuddyRelay 账号池与配额仪表盘">
</div>

---

### 2. 多源便捷账号导入
> 支持官方 OAuth 网页/扫码登录、**Cockpit Tools 本地 AES-256-GCM 密文池一键迁移**、本地已登录会话直读与 JSON 批量导入。

<div align="center">
  <img src="https://raw.githubusercontent.com/soulvon/BuddyRelay/main/resources/preview-import.webp" width="480" alt="BuddyRelay 添加账号模态框">
</div>

---

### 3. 全生命周期成长体系自动化
> 核心特性：**一键签到 · 一键做任务**  
> 任务中心顶部直观展示宠物打工地点、出游倒计时与连签天数；自动双源报名、前置依赖自愈、打工收成与达标奖励自动打捞入袋。

<div align="center">
  <img src="https://raw.githubusercontent.com/soulvon/BuddyRelay/main/resources/preview-tasks.webp" width="480" alt="BuddyRelay 成长体系自动化与出游看板">
</div>

---

## 📊 版本支持矩阵

BuddyRelay 针对腾讯生态内的不同分支版本进行了适配与梳理：

| 功能特性 | CodeBuddy CN (国内版) | WorkBuddy (国内版) | CodeBuddy AI / WorkBuddy AI (国际版) |
| :--- | :---: | :---: | :---: |
| **切号不关窗口、不重启编辑器** | ✅ 完整支持 | ✅ 完整支持 | ✅ 完整支持 |
| **历史会话完全互通 (零拷贝穿透)** | ✅ 完整支持 | ✅ 完整支持 | ✅ 完整支持 |
| **一键签到 (定点拟人化调度)** | ✅ 完整支持 | ✅ 完整支持 | ➖ 官方未上线签到活动 |
| **一键做任务 (全自动接单与打捞)** | ✅ 完整支持 | ✅ 完整支持 | ➖ 官方未上线成长活动 |
| **额度实时监控与自动切号** | ✅ 完整支持 | ✅ 完整支持 | ✅ 完整支持 |
| **Cockpit / JSON 多源导入** | ✅ 完整支持 | ✅ 完整支持 | ✅ 完整支持 |
| **GitHub 在线更新自动检测** | ✅ 完整支持 | ✅ 完整支持 | ✅ 完整支持 |

---

## ⚡ 它解决什么问题

| 你遇到的问题 | 默认情况 / 手动处理 | BuddyRelay 的处理方式 |
| :--- | :--- | :--- |
| **配额耗尽换号中断** | 官方换号需退出、关闭窗口、重启 IDE，当前长会话直接丢失 | **切号不关窗口、不重启编辑器**：内存更新会话状态，无需重绘窗口，上下文完好保留 |
| **历史记录跨号隔离** | 会话按 UID 独立分目录存储，换号后无法查看上一个号的历史 | **历史会话完全互通**：底层自动建立数据目录链接，历史会话跨号实时零拷贝互通 |
| **日常重复人工维护** | 每天要挨个账号登录去签到、接单、领奖、派宠物打工 | **一键签到、一键做任务**：后台定时拟人化签到，全自动接单、出游打工、连登兑换 |
| **额度何时耗尽未知** | 每次需手动打开网页后台查算力，写着写着突然撞上额度断点 | **实时双模看板**：状态栏与侧栏卡片直读实时算力余额，额度见底自动切号 |
| **手动发版更新繁琐** | 每次出新版本都要重新手动去网页翻找下载 | **自动更新检查**：后台静默检测 GitHub Release，弹窗一键下载安装并重载 |
| **直播录屏泄露隐私** | 账号名称、邮箱与 UID 完整暴露在屏幕上 | **全链路隐私脱敏**：侧栏、状态栏与切号菜单敏感信息瞬间星号脱敏掩蔽 |

---

## ✨ 核心能力

### 🔄 1. 无感切号与会话保留
- **平滑切号**：在侧栏卡片流或右下角状态栏一键选择账号，**切号不关窗口、不重启编辑器**，即时生效；
- **切换回执确认**：每条切号指令均由宿主写回执确认（Patch v5 回执闭环），成功才报成功，失败给出宿主侧真实原因，杜绝"假切换"；
- **跨平台目录链接**：Windows 采用免管理员权限的 NTFS Directory Junction，macOS/Linux 采用标准 POSIX 目录软链接（`ln -s`），**历史会话完全互通**；
- **历史记录过滤穿透**：解除本地会话数据库中的账号强绑定限制，无论切换至哪个账号，历史记录完好无损。

### 🪟 2. 多窗口同步与账号互斥
- **号池跨窗口实时同步**：账号池落盘于共享号池文件（`%APPDATA%\CodeBuddy CN\buddy-relay\pool.json`），任一窗口导入/删除/切号，其余窗口免重启实时跟随；
- **跨窗口账号锁**：每个窗口为当前账号持心跳锁，卡片直观标注"他窗占用"，崩溃残留锁自动清理；
- **自动切号防抢号**：自动轮换候选自动排除其他窗口正持有的账号，杜绝双窗口抢号横跳。

### ⚡ 3. 额度监控与自动守护（探针预检 + 频率熔断）
- **配额直读对账**：穿透底层计量接口，精准查询基础体验包与活动赠送包的真实可用算力；
- **候选探针预检**：自动切号前打入轻量健康度探针，自动识别并跳过已失效或在冷却中的账号；
- **切号频率熔断保护**：60 秒内切号超过 5 次自动触发熔断冷却，防止号池大面积受限时陷入死循环；
- **智能防抖冷却**：设置自定义冷却窗口与并发保护，杜绝多窗口频繁交叉切换。

### 📥 4. 账号资产出入闭环与分组管理
- **号池备份与导出**：支持一键导出为标准 JSON 备份，提供「完整凭证模式」与「脱敏安全模式」；
- **单号凭证提取**：卡片一键复制 AccessToken 密钥，方便外部脚本挂载与凭证流转；
- **失效号原地重授**：Token 过期账号提供原地唤起浏览器 OAuth 重新授权，凭证原地刷新自愈，无需删号重录；
- **自定义业务标签 (Tags)**：支持自定义标签（如主力/挂机/出海），顶部标签栏动态提取并支持一键多维筛选；
- **卡片备注备忘 (Notes)**：支持为每个账号记录独立备注说明，一目了然；
- **多渠道导入**：官方 OAuth、Cockpit Tools 密文解密导入与 JSON 文本/文件导入。

### 📋 5. 算力流水对账与事件审计
- **快照差值测算 (Delta Snapshot)**：周期对账精准捕获会话与代码补全的真实算力净消耗；
- **全生命周期审计**：详细记录每日定时签到到账、宠物出游打工到账、手动切号与自动切号事件；
- **侧栏今日流水面板**：侧栏底部常驻展开收起流水抽屉，今日新增、净消耗与切号明细清晰可视。

### 🎁 6. 每日任务自动化（一键签到 · 一键做任务）
- **一键签到**：支持每日定点自动签到（带随机抖动与拟人化账号间隔），杜绝断签；
- **一键做任务**：自动双源任务接单、前置依赖自动自愈、宠物出游打工、连登礼包兑换与达标奖励自动打捞；
- **状态全景看板**：任务中心顶部直观展示宠物打工地点、出游倒计时、连签进度条与盲盒能量。

### 🔄 7. 自动检查与一键更新
- **GitHub 自动检测**：扩展启动后静默比对 GitHub Releases 最新版本号；
- **更新日志智能摘要**：弹窗直接展示本次发布的核心更新要点，支持在编辑器内以 Markdown 预览完整更新说明；
- **多维操作选项**：提供「立即更新」、「查看完整日志」、「仅下载安装包」等灵活操作；
- **手动检查命令**：设置面板提供常驻版本号展示与「检查更新」快捷按钮。

---

## 🖥️ 平台适配

| 平台 | 适配状态 | 底层链接实现 | 默认数据路径 |
| :--- | :--- | :--- | :--- |
| **🪟 Windows** | 完整支持 | NTFS Directory Junction | `%APPDATA%\CodeBuddy CN` |
| **🍏 macOS** | 完整支持 | POSIX Symlink (`ln -s`) | `~/Library/Application Support/CodeBuddy CN` |
| **🐧 Linux** | 完整支持 | POSIX Symlink (`ln -s`) | `~/.config/CodeBuddy CN` |

---

## ⚙️ 配置说明

可在 CodeBuddy 的 `settings.json` 中按需微调以下参数：

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `buddyRelay.autoCheckin.dailyTime` | `string` | `"00:10"` | 每日自动签到时间（HH:mm，24 小时制） |
| `buddyRelay.autoCheckin.randomJitterMinutes` | `number` | `30` | 随机抖动时间窗口（分钟），错开整点更像真人 |
| `buddyRelay.autoCheckin.perAccountDelaySeconds` | `number` | `15` | 多账号签到之间的随机间隔上限（秒） |
| `buddyRelay.autoSwitch.enabled` | `boolean` | `true` | 是否启用额度见底自动切号 |
| `buddyRelay.autoSwitch.quotaThresholdPercent` | `number` | `10` | 触发自动切号的剩余百分比阈值 |
| `buddyRelay.autoSwitch.strategy` | `string` | `"highest_quota"` | 切号策略：`highest_quota` / `lru` / `round_robin` |
| `buddyRelay.autoSwitch.cooldownMinutes` | `number` | `5` | 切号后的防抖冷却时长（分钟） |
| `buddyRelay.growthTasks.autoAfterCheckin` | `boolean` | `true` | 每日签到后是否自动执行成长中心流水线 |
| `buddyRelay.update.autoCheck` | `boolean` | `true` | 启动时是否自动检查 GitHub 最新发布版本 |
| `buddyRelay.update.autoInstall` | `boolean` | `false` | 发现新版本时是否自动静默安装（无需二次确认） |

---

## ❓ 常见问题 (FAQ)

<details>
<summary><b>Q1: 切换账号需要重启编辑器或重新打开窗口吗？</b></summary>
<br>
<b>不需要。</b>BuddyRelay 采用进程级会话更新机制，点击切换后即时生效，正在编辑的文件与正在进行的 AI 对话均不会丢失，做到<b>切号不关窗口、不重启编辑器</b>。
</details>

<details>
<summary><b>Q2: 为什么切换账号后能看到之前账号的历史记录？</b></summary>
<br>
因为扩展通过底层目录链接技术将不同 UID 的历史存储节点汇聚映射，同时穿透了客户端原本针对单 UID 的过滤限制，实现<b>历史会话完全互通</b>。
</details>

<details>
<summary><b>Q3: 国际版（CodeBuddy AI / WorkBuddy AI）支持签到和成长任务吗？</b></summary>
<br>
国际版完整支持多账号号池管理、无感切号、会话保留与额度监控。但由于腾讯官方仅在境内国内版上线了签到积分与 Buddy 加油站活动，因此国际版账号不参与签到和成长中心任务。
</details>

<details>
<summary><b>Q4: 插件是如何存储账号 Token 的？是否安全？</b></summary>
<br>
<b>完全安全。</b>账号凭据存储在 VS Code 原生隔离的 <code>globalState</code> 本地持久化数据库中，所有网络请求仅直连腾讯官方域名（<code>codebuddy.cn</code> / <code>copilot.tencent.com</code>），绝不向任何第三方服务器上传敏感数据。
</details>

<details>
<summary><b>Q5: 成长任务点击「一键完成」提示进行中是什么意思？</b></summary>
<br>
部分任务（如使用模板、和 AI 对话等）属于客户端行为任务，需在日常写代码时自然触发。脚本会自动完成接单与前置自愈，一旦你在使用中达成目标，脚本会自动打捞并兑付奖励。
</details>

---

## 🔒 隐私与安全性保障

- **100% 纯本地运行**：没有任何中心化后端服务器，无任何 telemetry 收集；
- **凭据本地隔离**：令牌均保存在本地磁盘受保护容器内；
- **代码完全开源**：透明接受社区审查，无任何后门与暗桩。

---

## 💬 社区交流与支持

如果 BuddyRelay 为你节省了重复切号与维护账号的精力，欢迎进群交流多账号管理与 CodeBuddy 的使用心得。

<div align="center">

| 💬 QQ 交流群（1075342078） | ☕ 微信赞赏（请作者喝杯咖啡） |
| :---: | :---: |
| <img src="https://raw.githubusercontent.com/soulvon/BuddyRelay/main/resources/qq-group-qrcode.webp" width="180" alt="BuddyRelay QQ 交流群二维码"> | <img src="https://raw.githubusercontent.com/soulvon/BuddyRelay/main/resources/wechat-reward.webp" width="180" alt="微信赞赏码"> |
| 验证信息请注明 "BuddyRelay" | 感谢你的支持与鼓励！ |

</div>

---

## 🧰 同系列作品（同一作者的 AI 工具箱）

| 项目 | 简介 | 适合谁 |
| :--- | :--- | :--- |
| [🚀 **AnyBridge**](https://github.com/soulvon/AnyBridge) ![Downloads](https://img.shields.io/github/downloads/soulvon/AnyBridge/total?color=orange) | BYOK 模型接入工作台：统一管理 16+ AI 编程智能体（Cursor / Windsurf / Devin / Claude Code / Codex / CodeBuddy 等）的模型渠道，本地代理接管 + 配置直写，支持第三方中转站与本地聚合网关 | 想给封闭 IDE 接自定义模型的人 |
| [🪁 **Kite**](https://github.com/soulvon/Kite) ![Downloads](https://img.shields.io/github/downloads/soulvon/Kite/total?color=orange) | Windsurf / Devin 多账号号池与 AI IDE 增强套件：多账号共享号池、额度监控、额度耗尽自动切换、多实例分身、界面增强 | Windsurf / Devin 重度用户 |
| [🔍 **devin-search-mcp**](https://github.com/soulvon/devin-search-mcp) ![npm Downloads](https://img.shields.io/npm/dt/devin-search-mcp?color=orange) | 把 Devin 原生全网实时搜索与网页正文提取抽成标准 MCP：1 秒级响应、零模型额度消耗，`npx -y devin-search-mcp` 直装 | Cursor / Claude Code / Claude Desktop 用户 |

> 全部开源 · 本地优先 · 持续维护 —— 前往 [作者主页](https://github.com/soulvon) 查看全部项目。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源发布。
