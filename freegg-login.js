/**
 * FreeGG (New API) · 每日额度巡检
 * v2.0.0 · 2026-11-22
 *
 * ── 站点机制（实测 + 管理端文案确认）────────────────────────
 *   FreeGG 没有用 New API 的签到（checkin_enabled = false），
 *   而是「每日额度」Daily Allowance：
 *     管理端原文：Quota credited on the first visit of each day
 *                Credit a fixed quota once per calendar day when a
 *                signed-in user opens the site
 *   即：已登录用户当天**第一次访问站点**时，服务端自动把固定额度
 *   打进钱包。等价于「每天退出重新登录一次就自动到账」——
 *   重登只是产生了一次新的「当天首次已登录访问」。
 *
 * ── 实现思路 ────────────────────────────────────────────────
 *   照 MaYIHEI/paperclip/app/agentrouter（MIT）的链路：
 *     登录（或续期）→ 余额（/api/user/self）→ 日志确认（/api/log/self）
 *   区别在于确认环节：agentrouter 靠日志里「每日签到成功」的记录，
 *   这里靠当天 LogTypeSystem 的额度发放记录 + 余额同比，
 *   不按余额差猜测奖励金额。
 *
 * ── 认证优先级 ──────────────────────────────────────────────
 *   1) 配置里的 ACCESS_TOKEN
 *   2) 「FreeGG 令牌采集」模块在本机存下的会话（可自动续期）
 *   3) 账号密码登录（仅当站点关闭 Turnstile 验证码时可用）
 *
 * ── 站点现状（2026-11-22 实测）─────────────────────────────
 *   turnstile_check = true → 密码登录/注册被 Cloudflare Turnstile 拦截，
 *   上游 middleware/turnstile-check.go 无跳过分支，故密码登录只作为兜底，
 *   主路径是「本机采集的会话 + 自动续期」。
 */

const NAME = "FreeGG";
const VERSION = "2.0.0";
const DEFAULT_BASE = "https://freegg.app";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const TIMEOUT = 15000;
const SESSION_PREFIX = "freegg.egern.v1.";
const STATUS_KEY = "freegg.egern.v1.status";

export default async function (ctx) {
  const env = ctx.env || {};
  const debug = makeLogger(env);

  let accounts;
  try {
    accounts = readAccounts(env);
  } catch (error) {
    ctx.notify({ title: NAME, body: `⚠️ 配置有误：${error.message}`, sound: false });
    return;
  }

  // 只装了采集模块、环境变量留空时，直接用本机存下的会话。
  if (!accounts.length) {
    const slot = slotOf({}, env);
    const stored = ctx.storage.getJSON(`${SESSION_PREFIX}${slot}.session`);
    if (isObject(stored) && text(stored.accessToken)) {
      accounts = [{
        username: text(stored.username),
        password: "",
        accessToken: "",
        base: "",
        slot,
        name: text(stored.username) || "已登录账号",
      }];
    }
  }
  if (!accounts.length) {
    ctx.notify({
      title: NAME,
      body: "🚫 未配置账号\n请在模块设置里填写 ACCESS_TOKEN（推荐），或账号密码，或 FREEGG_ACCOUNTS 多账号 JSON。",
      sound: false,
    });
    return;
  }

  debug(`脚本版本 ${VERSION}，账号数 ${accounts.length}`);

  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    debug(`开始账号 ${i + 1}/${accounts.length}`);
    try {
      results.push(await inspectAccount(ctx, accounts[i], env, debug));
    } catch (error) {
      results.push({
        ok: false,
        title: "❌ 运行失败",
        body: error && error.message ? error.message : "未知错误",
        name: accounts[i].name || accounts[i].username,
      });
    }
  }

  saveStatus(ctx, results);
  notifySummary(ctx, accounts, results);
}

// ── 单账号巡检 ───────────────────────────────────────────────
async function inspectAccount(ctx, account, env, debug) {
  const base = normalizeBase(account.base || text(env.FREEGG_BASE) || DEFAULT_BASE);
  const slot = slotOf(account, env);
  const sessionKey = `${SESSION_PREFIX}${slot}.session`;
  const dailyKey = `${SESSION_PREFIX}${slot}.daily`;

  const site = await fetchSite(ctx, base, debug);
  debug(`站点=${site.system_name || NAME} 签到=${site.checkin_enabled === true} 验证码=${site.turnstile_check === true}`);

  const stored = ctx.storage.getJSON(sessionKey) || {};
  const headers = baseHeaders(base);
  let token = text(account.accessToken) || text(stored.accessToken);
  let source = account.accessToken ? "配置令牌" : stored.accessToken ? "本机采集" : "";
  let refreshCookie = text(stored.refreshCookie);
  let userId = stored.userId;

  // ① 完全没凭据时，尝试账号密码登录（Turnstile 开启则不可用）
  if (!token) {
    if (!account.username || !account.password) {
      throw new Error("缺少凭据：请填写 ACCESS_TOKEN，或先启用「FreeGG 令牌采集」模块在本机登录一次，或填写账号密码");
    }
    if (site.turnstile_check === true) {
      throw new Error("站点启用了 Turnstile 验证码，账号密码无法自动登录；请用「FreeGG 令牌采集」模块在本机登录一次，或在配置里填写 ACCESS_TOKEN");
    }
    const login = await loginWithPassword(ctx, base, account, headers, debug);
    token = login.accessToken;
    source = "账号密码";
    userId = login.userId;
    refreshCookie = login.refreshCookie || refreshCookie;
    persistSession(ctx, sessionKey, { accessToken: token, refreshCookie, userId, username: login.username, userAgent: UA });
  }

  // ② 当天首次「已登录访问」——这一发就是每日额度的触发点
  let self = await fetchSelf(ctx, base, token, userId, headers, debug);

  // 令牌过期（15 分钟有效期）：用刷新 Cookie 续期后重试一次
  if (self.status === 401) {
    if (!refreshCookie) {
      throw new Error("访问令牌已失效且没有刷新 Cookie，请用「FreeGG 令牌采集」模块重新登录一次，或更新 ACCESS_TOKEN");
    }
    debug("访问令牌已过期，用刷新 Cookie 续期");
    const renewed = await renewSession(ctx, base, refreshCookie, stored.userAgent || UA, debug);
    if (!renewed) {
      throw new Error("访问令牌已失效且自动续期失败，请用「FreeGG 令牌采集」模块重新登录一次");
    }
    token = renewed.accessToken;
    refreshCookie = renewed.refreshCookie || refreshCookie;
    source = `${source}（已续期）`;
    persistSession(ctx, sessionKey, {
      accessToken: token,
      refreshCookie,
      userId,
      username: text(stored.username),
      userAgent: text(stored.userAgent) || UA,
    });
    self = await fetchSelf(ctx, base, token, userId, headers, debug);
  }

  if (self.status === 401) {
    throw new Error("访问令牌被拒绝，请用「FreeGG 令牌采集」模块重新登录一次，或更新 ACCESS_TOKEN");
  }
  if (self.status < 200 || self.status >= 300 || !isObject(self.data) || self.data.success !== true) {
    throw new Error(`账户信息查询失败：${apiMessage(self.data, self.status)}`);
  }

  const user = isObject(self.data.data) ? self.data.data : {};
  const quota = toNumber(user.quota);
  const usedQuota = toNumber(user.used_quota);

  // ③ 日志确认：今天到底有没有额度发放记录（agentrouter 的核心做法）
  const daily = readDaily(ctx, dailyKey);
  const allowance = await findTodayAllowance(ctx, base, token, userId, headers, site, debug);
  debug(`今日额度日志=${allowance.found ? "有" : "无"} 金额=${allowance.quota}`);

  // ④ 余额同比：日志不可用时的兜底判据，不单独作为奖励金额依据
  const delta = computeDelta(daily, quota, usedQuota);

  // ⑤ 顺带处理签到（站点将来若开放也能用）
  const checkin = await runCheckin(ctx, base, token, userId, headers, site, debug);

  // ⑥ 结论
  let title;
  let rewardLine;
  if (allowance.found) {
    title = "✅ 今日额度已到账";
    rewardLine = `🎁 今日奖励：${formatAllowance(allowance, site, quotaUnitOf(site))}`;
  } else if (delta != null && delta > 0) {
    title = "✅ 今日额度已到账";
    rewardLine = `🎁 今日奖励：${formatMoney(delta, site, quotaUnitOf(site), true)}（按余额同比推算）`;
  } else {
    title = "⚠️ 今日额度待确认";
    rewardLine = "🎁 今日奖励：未在钱包与日志中发现发放记录\n" +
      "已按「当天首次访问」触发过一次；若仍无记录，请在 App 内退出并重新登录一次，再手动运行本脚本核对。";
  }

  // ⑦ 组装通知
  const lines = [];
  if (rewardLine) lines.push(rewardLine);
  lines.push(formatQuota("💳 当前余额", quota, site, quotaUnitOf(site)));
  lines.push(formatQuota("📉 累计消耗", usedQuota, site, quotaUnitOf(site)));
  if (Number.isInteger(user.request_count) && user.request_count >= 0) {
    lines.push(`⚡ 累计调用：${user.request_count} 次`);
  }
  if (text(user.group)) lines.push(`👥 分组：${text(user.group)}`);
  if (checkin.title) lines.push(checkin.title);
  if (checkin.body) lines.push(checkin.body);
  lines.push(`🔑 认证方式：${source}`);

  // 记下当天状态，避免同一天重复运行把同一次发放算成两次
  writeDaily(ctx, dailyKey, {
    date: todayStr(),
    quota,
    usedQuota,
    credited: allowance.found || (delta != null && delta > 0),
    at: Date.now(),
  });

  return {
    ok: true,
    title,
    body: lines.join("\n"),
    name: text(user.username) || text(user.display_name) || text(account.username),
    reward: allowance.found
      ? (allowance.money ? allowance.money.value : allowance.quota)
      : (delta != null && delta > 0 ? delta : null),
    balance: formatBalance(quota, site, quotaUnitOf(site)),
  };
}

// ── 站点配置 ─────────────────────────────────────────────────
async function fetchSite(ctx, base, debug) {
  const { status, data } = await request(ctx, "get", `${base}/api/status`, { label: "站点配置查询", debug });
  if (status < 200 || status >= 300 || !isObject(data) || !isObject(data.data)) {
    throw new Error(`站点配置查询失败：${apiMessage(data, status)}`);
  }
  return data.data;
}

// ── 账户信息（同时是每天的首次已登录访问）────────────────────
function fetchSelf(ctx, base, token, userId, headers, debug) {
  const h = { ...headers, Authorization: `Bearer ${token}` };
  if (userId) h["New-API-User"] = String(userId);
  return request(ctx, "get", `${base}/api/user/self`, { headers: h, label: "账户信息", debug });
}

// ── 密码登录（仅在站点未启用 Turnstile 时可用）────────────────
async function loginWithPassword(ctx, base, account, headers, debug) {
  const { status, data, headers: resHeaders } = await request(ctx, "post", `${base}/api/user/login`, {
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ username: account.username, password: account.password }),
    label: "登录",
    debug,
  });
  if (status === 429) throw new Error("登录被限流（HTTP 429），请稍后再试");
  if (status < 200 || status >= 300 || !isObject(data) || data.success !== true) {
    throw new Error(`登录失败：${apiMessage(data, status)}`);
  }
  const payload = isObject(data.data) ? data.data : {};
  const accessToken = text(payload.access_token) || text(payload.accessToken);
  if (!accessToken) throw new Error("登录成功但未返回访问令牌，请在网站核对");
  const user = isObject(payload.user) ? payload.user : {};
  return {
    accessToken,
    userId: Number.isInteger(user.id) ? user.id : undefined,
    username: text(user.username),
    refreshCookie: readRefreshCookie(resHeaders),
  };
}

// ── 会话续期（刷新 Cookie 每次都会轮换，必须回写）─────────────
async function renewSession(ctx, base, refreshCookie, userAgent, debug) {
  const cookie = text(refreshCookie);
  if (!cookie) return null;
  const { status, data, headers } = await request(ctx, "post", `${base}/api/user/auth/refresh`, {
    headers: {
      ...baseHeaders(base),
      Cookie: cookieHeader(cookie),
      "Content-Type": "application/json",
      "User-Agent": text(userAgent) || UA,
    },
    body: "{}",
    label: "会话续期",
    debug,
  });
  if (status < 200 || status >= 300 || !isObject(data) || data.success !== true) {
    debug(`续期失败：${apiMessage(data, status)}`);
    return null;
  }
  const payload = isObject(data.data) ? data.data : {};
  const accessToken = text(payload.access_token) || text(payload.accessToken);
  if (!accessToken) return null;
  return { accessToken, refreshCookie: readRefreshCookie(headers) };
}

// 从响应头里取出 new_api_refresh 的值；只保留键值本身，不带 Path/MaxAge。
function readRefreshCookie(headers) {
  if (!headers) return "";
  let raw = "";
  try {
    if (typeof headers.getAll === "function") raw = headers.getAll("set-cookie").join("\n");
    else raw = headers.get("set-cookie") || "";
  } catch (_) { raw = ""; }
  if (!raw) return "";
  const match = raw.match(/(?:^|[\n;,]\s*)new_api_refresh=([^;\s,]+)/i);
  return match ? match[1] : "";
}

// 存的是 Cookie 值本身，发请求时补回键名。
function cookieHeader(value) {
  const raw = text(value);
  if (!raw) return "";
  return /^new_api_refresh=/i.test(raw) ? raw : `new_api_refresh=${raw}`;
}

function persistSession(ctx, key, data) {
  try {
    ctx.storage.setJSON(key, {
      accessToken: text(data.accessToken),
      refreshCookie: text(data.refreshCookie),
      userId: data.userId,
      username: text(data.username),
      userAgent: text(data.userAgent) || UA,
      capturedAt: Date.now(),
    });
  } catch (_) { /* 存储不可用时忽略，不阻断本次运行 */ }
}

// ── 日志确认：当天有没有额度发放 ─────────────────────────────
async function findTodayAllowance(ctx, base, token, userId, headers, site, debug) {
  const h = { ...headers, Authorization: `Bearer ${token}` };
  if (userId) h["New-API-User"] = String(userId);

  const { status, data } = await request(ctx, "get", `${base}/api/log/self?p=1&page_size=30`, {
    headers: h,
    label: "使用日志查询",
    debug,
  });
  if (status < 200 || status >= 300 || !isObject(data) || data.success !== true) {
    debug(`日志查询不可用：${apiMessage(data, status)}`);
    return { found: false, quota: null, reason: apiMessage(data, status) };
  }
  const payload = isObject(data.data) ? data.data : {};
  const items = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.data) ? payload.data : [];
  if (!items.length) return { found: false, quota: null, reason: "日志为空" };

  const start = startOfToday();
  const now = Date.now();
  const candidates = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const at = toNumber(item.created_at);
    if (at == null) continue;
    const ms = at > 1e12 ? at : at * 1000;
    if (ms < start || ms > now + 60000) continue;
    const type = toNumber(item.type);
    const content = text(item.content);
    // LogTypeSystem = 4 是额度类系统日志；LogTypeTopup = 1 也计入到账
    const isSystem = type === 4 || type === 1;
    if (!isSystem) continue;
    const looksAllowance = /allowance|每日额度|额度.*(发放|到账|增加|入账)|daily\s+quota|credited/i.test(content);
    const quotaField = toNumber(item.quota);
    candidates.push({ ms, content, quotaField, looksAllowance, type });
  }
  if (!candidates.length) return { found: false, quota: null, reason: "今天没有额度类日志" };

  // 优先认明确写了 allowance 的那条，其次取当天额度为正的最新一条
  const matched = candidates.find((item) => item.looksAllowance)
    || candidates.slice().reverse().find((item) => item.quotaField != null && item.quotaField > 0)
    || null;
  if (!matched) return { found: false, quota: null, reason: "额度类日志里没有可用金额" };

  const parsed = parseMoney(matched.content);
  // 日志文案里的金额已经是货币值（如 $0.01），不能再按 quota_per_unit 换算；
  // 只有 quota 字段才是原始额度。两者分开带出去，避免二次换算。
  const quota = matched.quotaField != null && matched.quotaField > 0 ? matched.quotaField : null;
  debug(`额度日志内容：${matched.content.slice(0, 60)}`);
  return { found: true, quota, money: parsed, content: matched.content };
}

// 从日志文案里解析货币金额，例如 "Daily allowance credited: $0.002" / "每日额度 +￥0.01"
// 返回文案里实际使用的符号，展示时不再做二次币种换算。
function parseMoney(content) {
  const raw = text(content);
  if (!raw) return null;
  const match = raw.match(/([$＄¥￥¤])\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[2]);
  if (!Number.isFinite(value)) return null;
  return { value, symbol: match[1] === "＄" ? "$" : match[1] === "￥" ? "¥" : match[1] };
}

// ── 余额同比：日志缺失时的兜底 ───────────────────────────────
// 基线是上一次运行结束时的余额（通常是昨天），本次运行涨了的部分才算今日到账。
function computeDelta(daily, quota, usedQuota) {
  if (!isObject(daily)) return null;
  // 今天已经确认过一次到账，就不再重复计算，避免同一天多跑几次重复报奖励
  if (daily.credited === true && daily.date === todayStr()) return null;
  if (typeof daily.quota !== "number" || typeof quota !== "number") return null;
  // 累计消耗变了说明中途用过量，差额不再等于发放额，宁可不报也不误报
  if (typeof daily.usedQuota === "number" && typeof usedQuota === "number" && usedQuota !== daily.usedQuota) return null;
  const diff = quota - daily.quota;
  return diff > 0 ? diff : null;
}

// ── 签到（站点将来若开放也能用）──────────────────────────────
async function runCheckin(ctx, base, token, userId, headers, site, debug) {
  if (site.checkin_enabled !== true) return { title: "", body: "" };

  const h = { ...headers, Authorization: `Bearer ${token}` };
  if (userId) h["New-API-User"] = String(userId);

  const statusRes = await request(ctx, "get", `${base}/api/user/checkin?month=${monthStr()}`, {
    headers: h, label: "签到状态查询", debug,
  });
  if (statusRes.status < 200 || statusRes.status >= 300 || !isObject(statusRes.data) || statusRes.data.success !== true) {
    return { title: "", body: `⚠️ 签到状态查询失败：${apiMessage(statusRes.data, statusRes.status)}` };
  }
  const payload = isObject(statusRes.data.data) ? statusRes.data.data : {};
  const stats = isObject(payload.stats) ? payload.stats : {};
  if (stats.checked_in_today === true) {
    const records = Array.isArray(stats.records) ? stats.records : [];
    const today = records.find((item) => isObject(item) && text(item.checkin_date) === todayStr());
    const reward = today ? toNumber(today.quota_awarded) : null;
    return {
      title: "✅ 今日已签到",
      body: reward == null ? "" : `🎁 签到奖励：${formatMoney(reward, site, quotaUnitOf(site), false)}`,
    };
  }
  if (site.turnstile_check === true) {
    return { title: "⚠️ 需人工签到", body: "站点启用了 Turnstile 验证码，自动签到会被拦截，请在网站手动签到。" };
  }
  const post = await request(ctx, "post", `${base}/api/user/checkin`, {
    headers: { ...h, "Content-Type": "application/json" },
    body: "{}",
    label: "签到",
    debug,
  });
  if (post.status < 200 || post.status >= 300 || !isObject(post.data) || post.data.success !== true) {
    return { title: "⚠️ 签到待确认", body: `签到未成功：${apiMessage(post.data, post.status)}` };
  }
  const result = isObject(post.data.data) ? post.data.data : {};
  const reward = toNumber(result.quota_awarded);
  return {
    title: "✅ 签到成功",
    body: reward == null ? "" : `🎁 签到奖励：${formatMoney(reward, site, quotaUnitOf(site), true)}`,
  };
}

// ── HTTP ─────────────────────────────────────────────────────
function baseHeaders(base) {
  return {
    Accept: "application/json",
    "User-Agent": UA,
    Origin: base,
    Referer: `${base}/`,
  };
}

async function request(ctx, method, url, options = {}) {
  const { headers = {}, body, label = "请求", debug } = options;
  let response;
  try {
    response = await ctx.http[method](url, {
      headers,
      body,
      timeout: TIMEOUT,
      credentials: "omit",
    });
  } catch (error) {
    throw new Error(`${label}失败：${error && error.message ? error.message : "网络异常或超时"}`);
  }
  const status = response.status || 0;
  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }
  if (debug) debug(`${label} HTTP ${status}`);
  return { status, data, headers: response.headers || null };
}

// ── 账号解析 ─────────────────────────────────────────────────
function readAccounts(env) {
  const multi = text(env.FREEGG_ACCOUNTS);
  if (multi) {
    let parsed;
    try { parsed = JSON.parse(multi); }
    catch (_) { throw new Error("FREEGG_ACCOUNTS 格式错误，请填写 JSON 数组"); }
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error("FREEGG_ACCOUNTS 必须是非空 JSON 数组；使用单账号时请清空该输入框");
    }
    return parsed.map((item, index) => {
      if (!isObject(item)) throw new Error(`FREEGG_ACCOUNTS 第 ${index + 1} 项不是对象`);
      const username = text(item.username);
      const password = typeof item.password === "string" ? item.password : "";
      const accessToken = text(item.accessToken) || text(item.access_token);
      if (!username && !accessToken) {
        throw new Error(`FREEGG_ACCOUNTS 第 ${index + 1} 项缺少 username 或 accessToken`);
      }
      if (!accessToken && !password) {
        throw new Error(`FREEGG_ACCOUNTS 第 ${index + 1} 项缺少 password`);
      }
      return {
        username,
        password,
        accessToken,
        base: text(item.base),
        slot: text(item.slot),
        name: text(item.name) || username,
      };
    });
  }
  const accessToken = text(env.ACCESS_TOKEN);
  const username = text(env.USERNAME);
  const password = typeof env.PASSWORD === "string" ? env.PASSWORD : "";
  if (accessToken) return [{ username, password, accessToken, base: "", slot: "", name: username || "主账号" }];
  if (username && password) return [{ username, password, accessToken: "", base: "", slot: "", name: username }];
  return [];
}

function slotOf(account, env) {
  const slot = text(account && account.slot) || text(env.FREEGG_ACCOUNT_KEY) || "default";
  return /^[a-zA-Z0-9_-]{1,48}$/.test(slot) ? slot : "default";
}

// ── 格式化 ───────────────────────────────────────────────────
function quotaUnitOf(site) {
  const per = site && site.quota_per_unit;
  return typeof per === "number" && Number.isFinite(per) && per > 0 ? per : null;
}

function formatMoney(quota, site, quotaPerUnit, withPlus) {
  if (typeof quota !== "number" || !Number.isFinite(quota)) return "金额未返回";
  if (!quotaPerUnit) return `额度 ${quota}`;
  let value = quota / quotaPerUnit;
  let symbol = "$";
  if (site && site.quota_display_type === "CNY") {
    value *= typeof site.usd_exchange_rate === "number" && site.usd_exchange_rate > 0 ? site.usd_exchange_rate : 1;
    symbol = "¥";
  }
  const sign = withPlus && value > 0 ? "+" : "";
  return `${sign}${symbol}${value.toFixed(2)}`;
}

// 额度日志的展示：优先用日志文案里的货币金额（不做二次换算），
// 其次用日志的 quota 字段换算，都没有就如实说明。
function formatAllowance(allowance, site, quotaPerUnit) {
  if (allowance && allowance.money && Number.isFinite(allowance.money.value)) {
    return `+${allowance.money.symbol}${allowance.money.value.toFixed(2)}`;
  }
  if (allowance && allowance.quota != null) {
    return formatMoney(allowance.quota, site, quotaPerUnit, true);
  }
  return "已发放，金额未识别，请在网站核对";
}

function formatQuota(label, quota, site, quotaPerUnit) {
  if (typeof quota !== "number" || !Number.isFinite(quota)) return `${label}：未返回`;
  if (!quotaPerUnit) return `${label}（原始额度）：${quota}`;
  return `${label}：${formatMoney(quota, site, quotaPerUnit, false)}`;
}

function formatBalance(quota, site, quotaPerUnit) {
  if (typeof quota !== "number" || !Number.isFinite(quota)) return null;
  return quotaPerUnit ? formatMoney(quota, site, quotaPerUnit, false) : `额度 ${quota}`;
}

function maskName(name) {
  const value = text(name);
  if (!value) return "未命名";
  const base = value.includes("@") ? value.split("@")[0] : value;
  if (base.length > 4) return `${base.slice(0, 2)}***${base.slice(-2)}`;
  if (base.length > 1) return `${base.slice(0, 1)}***${base.slice(-1)}`;
  return "***";
}

// ── 通知与状态 ───────────────────────────────────────────────
function notifySummary(ctx, accounts, results) {
  if (results.length === 1) {
    ctx.notify({ title: NAME, body: `${results[0].title}\n${results[0].body}` });
    return;
  }
  const body = results
    .map((result, index) => `账号 ${index + 1} · ${maskName(result.name || (accounts[index] && accounts[index].username))}\n${result.title}\n${result.body}`)
    .join("\n\n");
  ctx.notify({ title: `每日额度巡检（${results.length} 个账号）`, body });
}

function saveStatus(ctx, results) {
  const failed = results.find((result) => !result.ok);
  const pending = results.find((result) => /待确认/.test(result.title));
  const state = failed ? "fail" : pending ? "pending" : "ok";
  const message = failed
    ? failed.body
    : results.map((result) => result.title.replace(/^[^\p{L}]+/u, "")).join(" · ");
  try {
    ctx.storage.setJSON(STATUS_KEY, {
      v: 2,
      t: Date.now(),
      name: NAME,
      s: state,
      msg: String(message).slice(0, 100),
    });
  } catch (_) { /* 存储不可用时忽略，不影响通知 */ }
}

// ── 工具 ─────────────────────────────────────────────────────
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function apiMessage(data, status) {
  if (isObject(data)) {
    const message = data.message ?? data.msg ?? data.error;
    if (typeof message === "string" && message) return message;
    if (isObject(message) && typeof message.message === "string" && message.message) return message.message;
    if (typeof data.code === "string" && data.code) return data.code;
  }
  return `HTTP ${status || "未知"}`;
}

function normalizeBase(base) {
  const value = text(base) || DEFAULT_BASE;
  return value.replace(/\/+$/, "");
}

function todayStr(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthStr(date = new Date()) {
  return todayStr(date).slice(0, 7);
}

function startOfToday(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function readDaily(ctx, key) {
  try {
    const value = ctx.storage.getJSON(key);
    return isObject(value) ? value : null;
  } catch (_) { return null; }
}

function writeDaily(ctx, key, value) {
  try { ctx.storage.setJSON(key, value); } catch (_) { /* 忽略 */ }
}

function makeLogger(env) {
  const flag = text(env.FREEGG_DEBUG).toLowerCase();
  const enabled = flag === "1" || flag === "true" || flag === "yes";
  return (...parts) => {
    if (enabled) console.log(`[FreeGG] ${parts.join(" ")}`);
  };
}
