<div align="center">

# BuddyRelay

**CodeBuddy CN 多账号管理与无感切号扩展**

平滑切号 · 会话保留 · 额度监控 · 每日签到 · 任务打捞

[![Version](https://img.shields.io/badge/version-0.1.0-blue?style=flat-square)](https://github.com/soulvon/BuddyRelay/releases/latest) [![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE) [![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)]()

</div>

---

## 解决问题

在使用 CodeBuddy CN 时，多账号切换通常需要重新扫码、重启编辑器，容易打断正在进行的会话上下文。

BuddyRelay 提供了开箱即用的账号池管理能力：
- **切号保留会话**：通过主进程会话更新与软链接映射，切换账号时无需重启编辑器；
- **历史记录互通**：将各 UID 的历史记录目录汇聚，避免切换后无法查看历史会话；
- **额度监控与自动换号**：实时查看算力剩余，支持在额度见底时自动切换备用账号；
- **日常任务自动化**：支持每日定时签到、任务接单、出游收成与达标领奖。

---

## 核心功能

### 1. 账号管理与无感切换
- **快捷切号**：在侧栏卡片流或状态栏一键切换账号，即时生效；
- **会话持久化**：底层建立目录映射（Windows 采用 Junction，macOS/Linux 采用标准 Symlink），历史会话跨账号可见；
- **隐私模式**：支持一键脱敏账号名称与 UID，方便演示与截图。

### 2. 额度监控与自动守护
- **配额直读**：实时查询各账号基础体验包与活动赠送包剩余；
- **见底自动切号**：当前账号额度低于设定阈值（默认 10%）或遇到 429 时，自动轮换至额度最高的健康账号。

### 3. 多种导入途径
- **OAuth 扫码登录**：调用官方授权页扫码添加；
- **Cockpit Tools 导入**：自动读取本机 `.antigravity_cockpit` 已授权凭据并导入；
- **JSON 批量导入**：支持直接粘贴账号配置文本。

### 4. 每日任务自动化
- **定时签到**：支持每日定点自动签到（带随机抖动与账号间隔）；
- **成长中心流水线**：自动完成双源任务报名、宠物出游打工、连登兑换与达标奖励打捞；
- **状态看板**：任务中心顶部直观展示宠物打工状态、倒计时与连签天数。

---

## 平台支持

| 平台 | 适配状态 | 目录链接实现 | 备注 |
|---|---|---|---|
| **Windows** | 完整支持 | NTFS Directory Junction | 无需管理员权限 |
| **macOS** | 完整支持 | POSIX Symlink (`ln -s`) | 适配 `~/Library/Application Support` |
| **Linux** | 完整支持 | POSIX Symlink (`ln -s`) | 适配 `~/.config` 与 `~/.local/share` |

---

## 快速开始

1. 前往 [Releases](https://github.com/soulvon/BuddyRelay/releases/latest) 下载 `buddy-relay-0.1.0.vsix`；
2. 在 CodeBuddy CN 扩展面板中点击右上角 `...` ➔ **从 VSIX 安装...**；
3. 安装后点击左侧活动栏的 **BuddyRelay** 图标展开面板；
4. 点击「添加账号」，通过 OAuth 授权或 Cockpit 导入账号即可。

也可通过命令行安装：
```bash
buddycn --install-extension buddy-relay-0.1.0.vsix --force
```

---

## 配置项

可在 CodeBuddy 的 `settings.json` 中配置以下选项：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `buddyRelay.autoCheckin.dailyTime` | `"00:10"` | 每日自动签到时间（HH:mm） |
| `buddyRelay.autoCheckin.randomJitterMinutes` | `30` | 随机抖动时间窗口（分钟） |
| `buddyRelay.autoCheckin.perAccountDelaySeconds` | `15` | 多账号签到随机间隔上限（秒） |
| `buddyRelay.autoSwitch.enabled` | `true` | 是否启用额度见底自动切号 |
| `buddyRelay.autoSwitch.quotaThresholdPercent` | `10` | 触发自动切号的剩余百分比阈值 |
| `buddyRelay.autoSwitch.strategy` | `"highest_quota"` | 切号策略：`highest_quota` / `lru` / `round_robin` |
| `buddyRelay.growthTasks.autoAfterCheckin` | `true` | 签到后是否自动执行成长任务 |

---

## 隐私与安全

- **纯本地运行**：不设置中转服务器，网络请求仅直连官方接口（`codebuddy.cn` / `copilot.tencent.com`）；
- **凭据隔离**：账号令牌保存在 VS Code 原生 `globalState` 容器内。

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
