# FreeGG 每日登录 · Egern 模块

[FreeGG](https://freegg.app/) 是基于 [New API](https://github.com/QuantumNous/new-api) 搭建的 AI 网关站。本仓库提供一套 iPhone **Egern** 模块：每天自动登录巡检，汇报余额、累计消耗与调用次数；站点开放签到时还会自动签到并回报奖励。

结构参考 [MaYIHEI/paperclip](https://github.com/MaYIHEI/paperclip/tree/main/app/agentrouter)（MIT）的 AgentRouter 登录签到模块。

---

## 站点现状（2026-11-22 实测）

先说清楚三件事，免得装完才发现对不上预期：

| 项目 | 实测结果 | 影响 |
|------|----------|------|
| `checkin_enabled` | **false** | 站点目前**没有开放签到**，模块会如实提示「站点未开放签到」，不会伪造奖励 |
| `turnstile_check` | **true** | 登录与签到都被 Cloudflare Turnstile 拦截，**账号密码无法自动提交**（Turnstile token 一次性、约 5 分钟过期，不适合定时任务） |
| 访问令牌有效期 | **15 分钟** | 必须靠刷新 Cookie 续期，否则每天都「令牌失效」 |
| 刷新 Cookie 有效期 | **30 天**，每次续期都会**轮换** | 续期后必须把新 Cookie 写回，否则下次续期就废了 |

因此本模块的主路径是 **MITM 采集会话令牌 + 自动续期**；账号密码登录仅在站点关闭 Turnstile 时才可用（脚本会自动判断，不可用了会明确报错而不是静默失败）。

---

## 文件

| 文件 | 说明 |
|------|------|
| `freegg.module.yaml` | Egern 模块：定时任务 + 请求/响应采集 + MITM + 环境变量声明 |
| `freegg-login.js` | 定时脚本：登录巡检、签到、通知 |
| `freegg-token.js` | 采集脚本：从登录/续期响应中抓取访问令牌与刷新 Cookie |
| `tests/` | Node 内置测试（`node --test tests/`），9 项全绿 |

---

## 使用步骤

### 1. 添加模块

主配置里引用：

```yaml
modules:
  - url: "https://raw.githubusercontent.com/ZHT0711/egern-freegg-login/main/freegg.module.yaml"
    update_interval: 3600
```

模块参数（可选，不填就用默认值）：

```yaml
    compat_arguments:
      CRON: "30 8 * * *"        # 每天 08:30
      SCRIPT_URL: "https://raw.githubusercontent.com/ZHT0711/egern-freegg-login/main/freegg-login.js"
      TOKEN_SCRIPT_URL: "https://raw.githubusercontent.com/ZHT0711/egern-freegg-login/main/freegg-token.js"
```

> 模块文件里的 `SCRIPT_URL` 默认值已指向本仓库的 raw 地址，通常不需要改。占位符采用官方写法：字符串字段加引号、数字字段不加引号，**模块文件本身在任何时候都是合法 YAML**。

### 2. 开启 MITM 并信任证书

1. Egern 设置 → MITM → 开启；
2. 安装 CA 证书：**设置 → 通用 → 关于本机 → 证书信任设置**，把 Egern 的证书打开「完全信任」；
3. 只在需要采集令牌时开启 MITM。若你打算直接填 `ACCESS_TOKEN`（见第 4 步），可以关闭 MITM。

### 3. 在同一台设备上登录一次，采集会话

1. 保持 Egern 服务运行；
2. 在**同一台 iPhone** 的浏览器里打开 <https://freegg.app/>，用 GitHub 或账号密码登录；
3. 登录成功后应收到通知「登录令牌与刷新 Cookie 已保存」。

这一步同时抓到两样东西：

- `data.access_token` —— 访问令牌（15 分钟有效，脚本会自动续期）
- `new_api_refresh` Cookie —— 刷新令牌（30 天有效，脚本每次续期后自动回写新值）

### 4. 在模块设置页填写参数

模块设置页会自动生成下列输入框：

| 参数 | 必填 | 说明 |
|------|------|------|
| `ACCESS_TOKEN` | 否 | 访问令牌。一般不用填——采集模块会自动存好；只有想临时顶替时才用 |
| `USERNAME` / `PASSWORD` | 否 | 账号密码。**站点启用 Turnstile 时不可用**，脚本会明确提示 |
| `FREEGG_ACCOUNTS` | 否 | 多账号 JSON，填写后优先使用（见下） |
| `FREEGG_BASE` | 否 | 站点地址，默认 `https://freegg.app`，换其它 New API 站时改这里 |
| `FREEGG_ACCOUNT_KEY` | 否 | 本地账号槽位，默认 `default`。不同槽位独立存会话 |
| `FREEGG_DEBUG` | 否 | 调试模式，打开后输出请求状态与判定过程 |

填完保存。

### 5. 手动运行一次核对

在 Egern 的脚本列表里手动运行「FreeGG 每日登录」，核对通知内容与网站一致。之后每天按 cron 自动执行。

---

## 多账号

在 `FREEGG_ACCOUNTS` 里粘贴 JSON 数组（每个账号也可以指定 `slot` 与 `base`）：

```json
[
  {"username": "主号", "accessToken": "…", "slot": "main"},
  {"username": "小号", "accessToken": "…", "slot": "main2"}
]
```

- 各账号逐个执行，某个失败会继续后面的账号；
- 最后**只发一条汇总通知**，按「账号 1、账号 2……」分段显示，账号名做掩码处理；
- `slot` 决定该账号用哪个本地会话（与采集模块的 `FREEGG_ACCOUNT_KEY` 对应）。

密码里的双引号和反斜杠要按 JSON 规则转义。格式错误会直接提示，不会退回单账号或跳过错误项。

---

## 通知效果

单账号示例（金额与次数仅供展示）：

```
FreeGG
ℹ️ 站点未开放签到
💳 当前余额：$3.20
📉 累计消耗：$0.56
⚡ 累计调用：42 次
👥 分组：default
🔑 认证方式：本机采集
```

站点开放签到后：

```
FreeGG
✅ 签到成功
💳 当前余额：$3.25
📉 累计消耗：$0.56
⚡ 累计调用：42 次
👥 分组：default
🔑 认证方式：本机采集
🎁 本次奖励：+$0.05
```

- 余额按站点 `quota_per_unit` 换算（FreeGG 为 500000 额度 = $1），`quota_display_type` 为 `CNY` 时自动换成 ¥ 并套用汇率；
- 奖励金额来自签到接口返回的 `quota_awarded`，取不到就提示到网站核对，不按余额变化估算，也不把未知金额显示成 0；
- 今日已签到时显示「🎁 今日奖励：$0.02（今日记录）」，表示这是今天已领的那笔，不是本次又领了一次。

---

## 已知限制

- **站点未开放签到**（`checkin_enabled = false`），模块目前只能做巡检；站点开放后无需改脚本即可自动签到。
- **Turnstile 无法绕过**。账号密码登录只在站点关闭验证码时可用，这是站点策略，不是脚本缺陷。
- **刷新 Cookie 30 天过期**，且每 30 天至少要手动登录一次重新采集（浏览器登录一次即可）。
- iOS 后台限制：Egern 需在前台或系统给后台时间时才会触发 cron，建议每天第一次用时顺手打开一下 App。
- 采集模块会在本机保存会话令牌与刷新 Cookie，**不要把这些内容分享给别人**。

---

## 维护记录

| 日期 | 变更 |
|------|------|
| 2026-11-22 | 首版：巡检、签到（站点开放时）、会话自动续期、MITM 采集、多账号汇总通知 |

---

## 致谢

- 结构参考：[MaYIHEI/paperclip](https://github.com/MaYIHEI/paperclip/tree/main/app/agentrouter)（MIT）
- 站点源码：[QuantumNous/new-api](https://github.com/QuantumNous/new-api)

## License

MIT
