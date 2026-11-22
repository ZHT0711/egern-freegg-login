/**
 * FreeGG (New API) · 每日登录巡检与签到
 * v1.0.0 · 2026-11-22
 *
 * 站点：https://freegg.app （New API v1.0.0-rc.49）
 * 结构参考 MaYIHEI/paperclip/app/agentrouter（MIT）
 * 适配 Egern schedule 脚本：ctx.http / ctx.storage / ctx.notify / ctx.env
 *
 * ── 认证优先级 ────────────────────────────────────────────
 *   1) 账号配置里的 access_token
 *   2) 「FreeGG 令牌采集」模块在本机存下的会话令牌（可自动续期）
 *   3) 账号密码登录（仅当站点未启用 Turnstile 验证码时可用）
 *
 * ── 站点现状（2026-11-22 实测）────────────────────────────
 *   checkin_enabled = false  → 站点暂未开放签到
 *   turnstile_check = true   → 登录与签到均被 Cloudflare Turnstile 拦截，
 *                              账号密码无法自动提交
 *   因此本脚本以「令牌采集 + 自动续期」为主路径，密码登录作为兜底。
 */

const NAME = "FreeGG";
const DEFAULT_BASE = "https://freegg.app";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const TIMEOUT = 15000;
const STATUS_KEY = "freegg.egern.v1.status";
const SESSION_PREFIX = "freegg.egern.v1.";

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
  if (!accounts.length) {
    // 只装了采集模块、没在环境变量里填任何东西时，直接用本机存下的会话。
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

  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    debug(`开始账号 ${i + 1}/${accounts.length}`);
    try {
      results.push(await inspect(ctx, accounts[i], env, debug));
    } catch (error) {
      results.push({ ok: false, title: "❌ 运行失败", body: error.message, name: accounts[i].name || accounts[i].username });
    }
  }

  saveStatus(ctx, results);
  notifySummary(ctx, accounts, results);
}

// ── 单账号巡检 ───────────────────────────────────────────────
async function inspect(ctx, account, env, debug) {
  const base = normalizeBase(account.base || env.FREEGG_BASE || DEFAULT_BASE);
  const slot = slotOf(account, env);
  const sessionKey = `${SESSION_PREFIX}${slot}.session`;

  const site = await fetchSite(ctx, base, debug);
  debug(`站点=${site.system_name || NAME} 签到=${site.checkin_enabled === true} 验证码=${site.turnstile_check === true}`);

  const stored = ctx.storage.getJSON(sessionKey) || {};
  const headers = baseHeaders(base);
  let token = text(account.accessToken) || text(stored.accessToken);
  let source = account.accessToken ? "配置" : stored.accessToken ? "本机采集" : "";

  // ① 无凭据：尝试账号密码登录（Turnstile 开启时不可用）
  if (!token) {
    if (!account.username || !account.password) {
      throw new Error("缺少凭据：请填写 ACCESS_TOKEN，或先启用「FreeGG 令牌采集」模块在本机登录一次，或填写账号密码");
    }
    if (site.turnstile_check === true) {
      throw new Error("站点启用了 Turnstile 验证码，账号密码无法自动登录；请用「令牌采集」模块在本机登录一次，或在配置中填写 ACCESS_TOKEN");
    }
    const login = await loginWithPassword(ctx, base, account, headers, debug);
    token = login.accessToken;
    source = "账号密码";
    ctx.storage.setJSON(sessionKey, {
      accessToken: token,
      userId: login.userId,
      username: login.username,
      userAgent: UA,
      capturedAt: Date.now(),
      source,
    });
  }
  headers.Authorization = `Bearer ${token}`;
  if (stored.userId) headers["New-API-User"] = String(stored.userId);

  // ② 账户信息；令牌过期且本机有刷新 cookie 时自动续期
  let self = await request(ctx, "get", `${base}/api/user/self`, { headers, label: "账户信息", debug });
  if (self.status === 401 && stored.refreshCookie) {
    debug("访问令牌已过期，尝试用刷新 cookie 续期");
    const renewed = await renewSession(ctx, base, stored, debug);
    if (renewed) {
      headers.Authorization = `Bearer ${renewed.accessToken}`;
      stored.accessToken = renewed.accessToken;
      if (renewed.refreshCookie) stored.refreshCookie = renewed.refreshCookie;
      stored.capturedAt = Date.now();
      ctx.storage.setJSON(sessionKey, stored);
      self = await request(ctx, "get", `${base}/api/user/self`, { headers, label: "账户信息（续期后）", debug });
    }
  }
  if (self.status === 401) {
    throw new Error("访问令牌已失效，请重新用「令牌采集」模块登录一次，或更新 ACCESS_TOKEN");
  }
  if (self.status < 200 || self.status >= 300 || !isObject(self.data) || self.data.success !== true) {
    throw new Error(`账户信息查询失败：${apiMessage(self.data, self.status)}`);
  }
  const user = isObject(self.data.data) ? self.data.data : {};

  // ③ 签到
  const checkin = await runCheckin(ctx, base, headers, site, debug);

  // ④ 组装通知
  const lines = [];
  const quotaPerUnit = quotaUnitOf(site);
  lines.push(formatQuota("💳 当前余额", user.quota, site, quotaPerUnit));
  lines.push(formatQuota("📉 累计消耗", user.used_quota, site, quotaPerUnit));
  if (Number.isInteger(user.request_count) && user.request_count >= 0) {
    lines.push(`⚡ 累计调用：${user.request_count} 次`);
  }
  if (text(user.group)) lines.push(`👥 分组：${text(user.group)}`);
  if (text(user.email)) lines.push(`📧 邮箱：${maskEmail(text(user.email))}`);
  lines.push(`🔑 认证方式：${source}`);
  if (checkin.body) lines.push(checkin.body);

  return {
    ok: true,
    title: checkin.title,
    body: lines.join("\n"),
    name: text(user.username) || text(user.display_name) || text(account.username),
    reward: checkin.reward,
    balance: formatBalance(user.quota, site, quotaPerUnit),
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

// ── 密码登录（仅在站点未启用 Turnstile 时可用）────────────────
async function loginWithPassword(ctx, base, account, headers, debug) {
  const { status, data } = await request(ctx, "post", `${base}/api/user/login`, {
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
  const accessToken = text(payload.access_token);
  if (!accessToken) throw new Error("登录成功但未返回访问令牌，请在网站核对");
  const user = isObject(payload.user) ? payload.user : {};
  return { accessToken, userId: user.id, username: text(user.username) };
}

// ── 会话续期（刷新 cookie 每次都会轮换，必须回写）─────────────
async function renewSession(ctx, base, stored, debug) {
  const cookie = text(stored.refreshCookie);
  if (!cookie) return null;
  const { status, data, headers } = await request(ctx, "post", `${base}/api/user/auth/refresh`, {
    headers: {
      ...baseHeaders(base),
      Cookie: cookieHeader(cookie),
      "Content-Type": "application/json",
      "User-Agent": text(stored.userAgent) || UA,
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
  const accessToken = text(payload.access_token);
  if (!accessToken) return null;
  // 刷新 Cookie 每次续期都会轮换，必须把新值写回，否则下次续期就废了。
  const nextCookie = readRefreshCookie(headers);
  return { accessToken, refreshCookie: nextCookie };
}

// 从响应头里取出 new_api_refresh 的值；只保留键值本身，不带 Path/MaxAge 等属性。
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

// 存的是 Cookie 的值本身，发请求时补回键名。
function cookieHeader(value) {
  const raw = text(value);
  if (!raw) return "";
  return /^new_api_refresh=/i.test(raw) ? raw : `new_api_refresh=${raw}`;
}

// ── 签到 ─────────────────────────────────────────────────────
async function runCheckin(ctx, base, headers, site, debug) {
  if (site.checkin_enabled !== true) {
    return { title: "ℹ️ 站点未开放签到", body: "", reward: null };
  }
  const month = monthStr();
  const statusRes = await request(ctx, "get", `${base}/api/user/checkin?month=${month}`, {
    headers, label: "签到状态查询", debug,
  });
  if (statusRes.status < 200 || statusRes.status >= 300 || !isObject(statusRes.data)) {
    return { title: "⚠️ 签到待确认", body: `签到状态查询失败：${apiMessage(statusRes.data, statusRes.status)}`, reward: null };
  }
  if (statusRes.data.success !== true) {
    const message = apiMessage(statusRes.data, statusRes.status);
    if (/not enabled/i.test(message)) {
      return { title: "ℹ️ 站点未开放签到", body: "", reward: null };
    }
    return { title: "⚠️ 签到待确认", body: `签到状态查询未成功：${message}`, reward: null };
  }

  const payload = isObject(statusRes.data.data) ? statusRes.data.data : {};
  const stats = isObject(payload.stats) ? payload.stats : {};
  const today = todayStr();
  const records = Array.isArray(stats.records) ? stats.records : [];
  const todayRecord = records.find((item) => isObject(item) && text(item.checkin_date) === today);

  if (stats.checked_in_today === true) {
    const reward = todayRecord ? Number(todayRecord.quota_awarded) : null;
    return {
      title: "✅ 今日已签到",
      body: reward === null || !Number.isFinite(reward)
        ? "🎁 今日奖励：金额未返回，请在网站核对"
        : `🎁 今日奖励：${formatMoney(reward, site, quotaUnitOf(site), false)}（今日记录）`,
      reward,
    };
  }

  if (site.turnstile_check === true) {
    return {
      title: "⚠️ 需人工签到",
      body: "🎁 签到奖励：待领取\n站点启用了 Turnstile 验证码，自动签到会被拦截，请在网站手动签到。",
      reward: null,
    };
  }

  const post = await request(ctx, "post", `${base}/api/user/checkin`, {
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{}",
    label: "签到",
    debug,
  });
  if (post.status < 200 || post.status >= 300 || !isObject(post.data) || post.data.success !== true) {
    return { title: "⚠️ 签到待确认", body: `签到未成功：${apiMessage(post.data, post.status)}`, reward: null };
  }
  const result = isObject(post.data.data) ? post.data.data : {};
  const reward = Number(result.quota_awarded);
  return {
    title: "✅ 签到成功",
    body: Number.isFinite(reward)
      ? `🎁 本次奖励：${formatMoney(reward, site, quotaUnitOf(site), true)}`
      : "🎁 本次奖励：金额未返回，请在网站核对",
    reward: Number.isFinite(reward) ? reward : null,
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
  const slot = text(account.slot) || text(env.FREEGG_ACCOUNT_KEY) || "default";
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

function maskEmail(email) {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const name = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${maskName(name)}@${domain}`;
}

// ── 通知与状态 ───────────────────────────────────────────────
function notifySummary(ctx, accounts, results) {
  if (results.length === 1) {
    ctx.notify({ title: NAME, body: `${results[0].title}\n${results[0].body}` });
    return;
  }
  const body = results
    .map((result, index) => `账号 ${index + 1} · ${maskName(result.name || accounts[index].username)}\n${result.title}\n${result.body}`)
    .join("\n\n");
  ctx.notify({ title: `登录汇总（${results.length} 个账号）`, body });
}

function saveStatus(ctx, results) {
  const failed = results.find((result) => !result.ok);
  const state = failed ? "fail" : results.every((result) => /签到|巡检/.test(result.title)) ? "ok" : "ok";
  const message = failed
    ? failed.body
    : results.map((result) => result.title.replace(/^[^\p{L}]+/u, "")).join(" · ");
  try {
    ctx.storage.setJSON(STATUS_KEY, {
      v: 1,
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

function makeLogger(env) {
  const flag = text(env.FREEGG_DEBUG).toLowerCase();
  const enabled = flag === "1" || flag === "true" || flag === "yes";
  return (...parts) => {
    if (enabled) console.log(`[FreeGG] ${parts.join(" ")}`);
  };
}
