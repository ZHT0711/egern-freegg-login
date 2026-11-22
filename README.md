# FreeGG 每日额度 · Egern 模块

[FreeGG](https://freegg.app/) 是基于 [New API](https://github.com/QuantumNous/new-api) 搭建的 AI 网关站。本仓库提供一套 iPhone **Egern** 模块：每天自动完成一次「已登录访问」触发站点的**每日额度（Daily Allowance）**发放，再用服务端日志确认奖励是否真的到账，同时汇报余额、累计消耗与调用次数。

结构参考 [MaYIHEI/paperclip](https://github.com/MaYIHEI/paperclip/tree/main/app/agentrouter)（MIT）的 AgentRouter 模块：登录 → 查余额 → **查日志确认奖励**。区别在于确认环节——AgentRouter 找的是「每日签到成功」记录，FreeGG 找的是当天的额度发放日志。

---

## 奖励是怎么发的（这是本模块的核心）

FreeGG **没有**用 New API 的签到（`checkin_enabled = false`），而是单独做了「每日额度」：

> 管理端设置页原文：
> *Credit a fixed quota once per calendar day when a signed-in user opens the site*
> *Quota credited on the first visit of each day*

翻译过来就是：**已登录用户当天第一次访问站点时，服务端自动把固定额度打进钱包，一天只发一次**。

所以「每天退出重新登录一次就自动到账」的真实原因不是重登这个动作，而是重登**产生了一次新的「当天首次已登录访问」**。本模块每天定时做的就是这一发：用你的会话请求 `/api/user/self`（就是网页/App 打开时调的那个接口），触发发放，然后核对结果。

### 怎么确认奖励真的到账

不靠猜、不靠余额差估算，按两条独立证据判断：

1. **主证据：服务端日志** —— 拉 `/api/log/self`，找当天 `type = 4`（系统类）的额度记录，文案里带 allowance / 每日额度 / 额度发放 的那条，金额直接从文案里取；
2. **兜底：余额同比** —— 和上一次运行结束时的余额比，涨了才算到账。**如果中途用过量（累计消耗变了），差额不再等于发放额，脚本宁可不报也不误报。**

两条都没有 → 标题给「⚠️ 今日额度待确认」，并提示你退出重登一次再手动跑（而不是假装成功）。

---

## 站点现状（2026-11-22 实测）

| 项目 | 实测结果 | 影响 |
|------|----------|------|
| `checkin_enabled` | **false** | 站点没有签到功能，模块走「每日额度」而不是签到接口 |
| 每日额度 | **开启**（管理端 `daily_allowance_setting`） | 每天首次已登录访问自动发放固定额度到钱包 |
| `turnstile_check` | **true** | 登录/注册被 Cloudflare Turnstile 硬拦（上游中间件无跳过分支），**账号密码无法自动提交** |
| 访问令牌有效期 | **15 分钟** | 必须靠刷新 Cookie 续期，否则每天都「令牌失效」 |
| 刷新 Cookie 有效期 | **30 天**，每次续期都会**轮换** | 续期后必须把新 Cookie 写回，否则下次续期就废了 |

因此主路径是 **MITM 采集会话 + 自动续期**；账号密码登录只在站点关闭 Turnstile 时可用（脚本会先读 `/api/status` 自动判断，不能用就明确报错，不会静默失败）。

---

## 文件

| 文件 | 说明 |
|------|------|
| `freegg.module.yaml` | Egern 模块：定时任务 + 请求/响应采集 + MITM + 环境变量声明 |
| `freegg-login.js` | 定时脚本：触发每日额度、日志确认、余额汇报、多账号汇总 |
| `freegg-token.js` | 采集脚本：从登录/续期响应中抓取访问令牌与刷新 Cookie |
| `tests/` | Node 内置测试（`node --test tests/*.mjs`），18 项全绿 |

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
      CRON: "10 9 * * *"        # 每天 09:10
      SCRIPT_URL: "https://raw.githubusercontent.com/ZHT0711/egern-freegg-login/main/freegg-login.js"
      TOKEN_SCRIPT_URL: "https://raw.githubusercontent.com/ZHT0711/egern-freegg-login/main/freegg-token.js"
```

> 默认时间选 09:10（北京时间）是为了错开跨日边界：那一刻 UTC 已是新的一天，无论站点按 UTC 还是 UTC+8 算「日历日」，都不会漏发或重发。
> 模块文件里的 `SCRIPT_URL` 已指向本仓库 raw 地址，通常不用改；占位符采用官方写法（字符串加引号），**文件本身在任何时候都是合法 YAML**。

### 2. 开启 MITM 并信任证书

1. Egern 设置 → MITM → 开启；
2. 安装 CA 证书：**设置 → 通用 → 关于本机 → 证书信任设置**，把 Egern 的证书打开「完全信任」；
3. 只在需要采集令牌时开启 MITM。若你直接填 `ACCESS_TOKEN`（见第 4 步），可以关闭 MITM。

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

在 Egern 的脚本列表里手动运行「FreeGG 每日额度」，核对通知内容与网站一致。之后每天按 cron 自动执行。

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

额度已到账：

```
FreeGG
✅ 今日额度已到账
🎁 今日奖励：+$0.002
💳 当前余额：$3.20
📉 累计消耗：$0.56
⚡ 累计调用：42 次
👥 分组：default
🔑 认证方式：本机采集
```

日志暂时没有记录、但余额涨了（兜底判定）：

```
🎁 今日奖励：+$0.002（按余额同比推算）
```

没确认到发放（不会假装成功）：

```
⚠️ 今日额度待确认
🎁 今日奖励：未在钱包与日志中发现发放记录
已按「当天首次访问」触发过一次；若仍无记录，请在 App 内退出并重新登录一次，再手动运行本脚本核对。
```

说明：

- 余额按站点 `quota_per_unit` 换算（FreeGG 为 500000 额度 = $1），`quota_display_type` 为 `CNY` 时自动换成 ¥ 并套用汇率；
- 奖励金额优先取日志文案里的货币值（**不再做二次币种换算**），其次取日志的 `quota` 字段，都没有才退回余额同比；
- 同一天重复运行不会把同一次发放算成两次（本地记录当天已到账标记）。

---

## 已知限制

- **密码登录走不通**：站点开启 Turnstile，且上游 `middleware/turnstile-check.go` 没有任何跳过分支（token 从 `?turnstile=` 取、一次性、约 5 分钟过期）。这是站点策略，不是脚本缺陷。所以必须先在本机登录一次采集会话。
- **刷新 Cookie 30 天过期**：每 30 天内至少要手动登录一次重新采集（浏览器登录一次即可）。
- **「待确认」不等于失败**：如果当天额度已由你手动领取、或站点尚未配置额度、或本站尚未启用该功能，脚本都会显示「待确认」而不虚构奖励。
- iOS 后台限制：Egern 需在前台或系统给后台时间时才会触发 cron，建议每天第一次用时顺手打开一下 App。
- 采集模块会在本机保存会话令牌与刷新 Cookie，**不要把这些内容分享给别人**。

---

## 维护记录

| 日期 | 变更 |
|------|------|
| 2026-11-22 | v2.0.0：改用「每日额度」机制（当天首次已登录访问触发），新增服务端日志确认与余额同比兜底，18 项测试 |
| 2026-11-22 | 首版：巡检、签到（站点开放时）、会话自动续期、MITM 采集、多账号汇总通知 |

---

## 致谢

- 结构参考：[MaYIHEI/paperclip](https://github.com/MaYIHEI/paperclip/tree/main/app/agentrouter)（MIT）
- 站点源码：[QuantumNous/new-api](https://github.com/QuantumNous/new-api)

## License

MIT
