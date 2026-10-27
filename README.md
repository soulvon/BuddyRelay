<div align="center">

# 🦅 BuddyRelay — CodeBuddy CN 智能无感换号与号池增强套件

**面向腾讯 CodeBuddy CN 的无感切号引擎 · NTFS 会话零拷贝保活 · 额度自动守护 · 成长中心全生命周期自动化**

无感换号 · 会话保活 · 额度守护 · Cockpit 密文导入 · 每日签到调度 · 成长体系全自动收成

[![Version](https://img.shields.io/badge/version-0.1.0-blue?style=flat-square)](https://github.com/soulvon/BuddyRelay/releases/latest) [![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE) [![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20CodeBuddy%20CN-lightgrey?style=flat-square)]() [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/soulvon/BuddyRelay/pulls) [![Issues](https://img.shields.io/github/issues/soulvon/BuddyRelay?style=flat-square)](https://github.com/soulvon/BuddyRelay/issues)

</div>

---

## 💡 它解决什么问题？

腾讯 **CodeBuddy CN** 是国内主流的 AI 编程助手与云端 IDE，但实战中常常面临以下痛点：
1. **配额用尽换号成本极高**：算力点用完后，官方换号必须退出登录、关闭所有窗口、重新扫码并重启 IDE，**正在进行的长对话上下文直接中断丢失**；
2. **多账号会话数据天然隔离**：CodeBuddy 的历史记录与本地缓存按 `UID` 独立隔离存储（`CodeBuddyExtension\Data\<uid>`），手动换号后无法查看上一个账号下的历史会话（常见 5GB+ / 数十万个历史文件无法共享）；
3. **多账号维护繁重不堪**：拥有多个账号时，每天要逐个登录签到、接单、领奖、派宠物打工，繁琐重复的人工操作极大消耗开发者精力。

**BuddyRelay** 在 **不关窗口、不重启编辑器、不中断生成、历史会话绝对不丢** 的前提下，把进程级无感切号、NTFS 目录软链接穿透、实时额度守护、Cockpit 密文池导入与成长中心全自动收成整合成一套纯净、克制、高效的 IDE 增强套件。

---

## ⚡ 核心能力

### 🔄 1. 无感换号引擎 (Hot Account Switching)
- **进程级 Session 热覆盖** — 基于 Electron 主进程动态挂载技术（`AM` 构造器钩子与 `startByokWatcher` 轮询管道），无需重启 IDE 即可秒级平滑刷新全局身份令牌。
- **NTFS Directory Junction 零拷贝穿透** — 通过 Windows 底层目录联接技术，将不同 UID 的会话数据目录全部软链接至主目录，**实现 5.6GB+ / 28.8 万个历史会话文件零体积开销、全账号实时共享读取**。
- **历史记录过滤器穿透** — 自动清除 `codebuddy-sessions.vscdb` 中的 `userId` 强绑定限制，无论切到哪个号，所有的历史会话、Prompt 记忆完好无损。

### ⚡ 2. 额度阈值守护与自动无感轮换 (Auto Quota Guard)
- **双重口径精准对账** — 穿透腾讯底层配额接口（`/v2/billing/meter/get-user-resource`），精准聚合真实 spendable 的 `CycleCapacityRemainPrecise`，杜绝累积签到假数据干扰。
- **阈值监控自动换号** — 后台毫秒级守护，当当前活跃账号算力占比低于设定阈值（默认 `≤ 10%`）或撞上 `429 Rate Limit` 时，**毫秒级自动切换到号池内剩余算力最多的健康账号**，编程打字丝滑无感。
- **冷却防抖机制** — 配备 5 分钟智能防抖冷却窗口与并发加锁，杜绝多窗口频繁交叉切换。

### 📥 3. Cockpit Tools 密文池一键导入
- **AES-256-GCM 本地密文直读** — 深度兼容本机 Cockpit Tools 资产库（`%USERPROFILE%\.antigravity_cockpit`），直接在本地内存完成 PBKDF2 衍生密钥解密。
- **零扫码迁移** — 瞬间将已授权的所有可用账号导入号池，按 UID 智能去重，现有已登录账号不丢失。

### 🎁 4. 全生命周期成长中心自动化流水线
- **双源全量自动报名** — 智能拆分桌面端源与微信小程序专属源（自动注入 `X-Client-Platform: miniprogram`），一键为号池账号完成 20 项任务自动报名。
- **前置依赖自动自愈** — 检测到新号未领养 `first_buddy` 导致服务端报错时，全自动先执行领养协议，**秒领 +300 算力点与 +8 能量**，解开后续任务限制。
- **🐾 Buddy 出游打工赚钱** — 空闲宠物全自动派遣前往咖啡馆等地点打工（`buddy/travel/depart`），返航自动收取打工礼包与 **5~10 免费算力点**。
- **🔥 连登大额兑换与漏签自动补救** — 监控连登日历，达标（7天/14天/28天）自动兑换 **50~150 额外积分**；发现当月断签自动使用补登卡补齐。
- **⚡ 盲盒能量开箱** — 攒够 10 点能量全自动开出全新稀有专属 Buddy。
- **达标任务自动兑付** — 写代码自然触发的任务（如对话、模板、使用专家等），一旦服务端亮起 `completed`，脚本全自动调 claim 兑付入账。

### 📊 5. 资产全景看板与优雅交互 (Kite 式极简克制)
- **资产仪表盘** — 任务中心顶部实时可视化显示 Buddy 当前打工地点与返航倒计时、连签进度条、补登卡数量与盲盒能量余额。
- **Kite 原版折叠抽屉** — 收起时仅占 32px 紧凑单行，展开即享快捷工具栏（全选、反选、仅当前），多账号选择与下方任务列表实时联动、单选秒级切号。
- **独立生命周期进度模态框** — 长耗时批处理提供专属双阶段模态框：阶段一带有 Kite 进度条 + 毫秒级【停止执行】控制；阶段二提供结构化 4 格指标看板（到账积分、已领任务、新报任务、跳过/人工）与账号明细。
- **一键隐私模式** — 支持一键对姓名、邮箱、UID 进行星号脱敏掩蔽，保护录屏与分享隐私。

---

## 🛠️ 技术亮点与架构突破

| 攻克痛点 | 工业级解决方案 |
|---|---|
| **多账号会话数据天然隔离** | 突破 Electron 限制，采用 Windows NTFS Directory Junction 目录联接将各 UID 数据目录汇聚于主节点，达成 5.6GB+ 历史记录零拷贝瞬时穿透。 |
| **主进程认证拦截** | 精准锚定 `main.js` 中的 `AM` 核心构造器与 `startByokWatcher` 管道，规避重新加载窗口引起的编辑器界面重绘与会话重置。 |
| **HTTP 跨包数据乱码** | 彻底抛弃脆弱的字符串 chunk 拼接，重构为全链路二进制 `Buffer.concat` 拼装与 end 事件集中解码，彻底消灭 `\uFFFD` 乱码。 |
| **CSS 覆盖穿透与削顶** | 彻底废弃操作系统原生 checkbox 控件，自研极简 13×13px 纯扁平矢量复选框；显式声明 `:not([hidden])` 伪类，杜绝弹性布局穿透原生隐藏属性。 |
| **devloop 质量闭环** | 建立可机器验证的自动化门控拦截体系（`check_ui_guards` + `check_button_gates` + `check_icon_gates` + 真实端到端全链路测试），**51 项门控全绿**方可构建打包。 |

---

## 🚀 快速开始

### 方式一：VSIX 离线包图形化安装（推荐）

1. 前往本仓库 [Releases 页面](https://github.com/soulvon/BuddyRelay/releases/latest) 下载最新的 `buddy-relay-x.y.z.vsix`；
2. 打开 **CodeBuddy CN** 编辑器；
3. 进入左侧扩展面板（快捷键 `Ctrl+Shift+X`），点击右上角 `...` 菜单 ➔ 选择 **“从 VSIX 安装...” (Install from VSIX...)**；
4. 选择下载的 `.vsix` 文件完成安装；
5. 左侧活动栏将出现 **BuddyRelay** 图标，点击即可展开控制面板。

### 方式二：命令行一键安装

在终端执行：
```bash
buddycn --install-extension buddy-relay-0.1.0.vsix --force
```

---

## ⚙️ 配置说明

在 CodeBuddy 的设置（`settings.json`）中可以灵活调整调度参数：

| 配置项 | 类型 | 默认值 | 作用说明 |
|---|---|---|---|
| `buddyRelay.autoCheckin.dailyTime` | `string` | `"00:10"` | 每日自动签到时间（HH:mm，24 小时制） |
| `buddyRelay.autoCheckin.randomJitterMinutes` | `number` | `30` | 签到随机抖动窗口（分钟），错开整点模拟真人行为 |
| `buddyRelay.autoCheckin.perAccountDelaySeconds` | `number` | `15` | 多账号逐个签到之间的拟人化随机间隔上限（秒） |
| `buddyRelay.autoSwitch.enabled` | `boolean` | `true` | 是否启用额度见底自动无感换号 |
| `buddyRelay.autoSwitch.quotaThresholdPercent` | `number` | `10` | 活跃账号算力低于此百分比时自动切换备用账号 |
| `buddyRelay.autoSwitch.strategy` | `string` | `"highest_quota"` | 换号策略：`highest_quota`（高额度优先）、`lru`、`round_robin` |
| `buddyRelay.autoSwitch.cooldownMinutes` | `number` | `5` | 换号后的防抖冷却时长（分钟） |
| `buddyRelay.growthTasks.autoAfterCheckin` | `boolean` | `true` | 每日签到完成后自动跑一轮成长中心流水线 |

---

## 🔒 隐私与安全性保障

- **100% 本地运算**：BuddyRelay 没有任何中心化收集服务器，绝不向任何第三方域名发送您的代码、聊天记录或账号令牌；
- **凭据本地加密**：账号凭据全部保存在 VS Code 官方提供的受保护的 `globalState` 容器内（本地 `state.vscdb`）或本机的隔离配置中；
- **透明审计**：本工具完全开源，所有网络请求仅直连腾讯官方域名（`codebuddy.cn` / `copilot.tencent.com`），无任何后门与暗桩。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源发布。
欢迎提交 Issue 和 Pull Request 一起完善！
