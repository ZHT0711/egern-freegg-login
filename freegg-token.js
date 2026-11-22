/**
 * FreeGG (New API) · iPhone Egern 本机会话采集
 * v1.0.0 · 2026-11-22
 *
 * 用途：在本机登录 https://freegg.app 一次，抓取登录响应中的
 *       access_token 与 new_api_refresh 刷新 Cookie，存入本机，
 *       供 freegg-login.js 每日自动续期使用。
 *
 * 说明：站点 access_token 仅 15 分钟有效，刷新 Cookie 30 天有效且每次续期都会轮换，
 *       因此必须同时采集两者，并让主脚本在每次续期后回写新的 Cookie。
 *
 * 结构参考 MaYIHEI/paperclip/app/agentrouter 与同作者的 WorkBuddy 采集脚本（MIT）。
 * 用于 http_request / http_response，不会主动发请求或登录。
 */

const API_BASE = /^https:\/\/freegg\.app\/api\/user\//;
const LOGIN_PATH = /^https:\/\/freegg\.app\/api\/user\/(?:login|auth\/refresh)(?:\?|$)/;
const REFRESH_COOKIE = "new_api_refresh";

export default async function (ctx) {
  let originalBody = "";
  let consumed = false;
  try {
    const env = ctx.env || {};
    const slot = slotOf(env);
    const key = `freegg.egern.v1.${slot}.session`;
    const request = ctx.request;
    if (!request) {
      notify(ctx, "请把本脚本设为请求/响应采集脚本：开启模块后在同一台设备上登录 freegg.app 一次即可，无需手动运行。");
      return;
    }
    if (request.method === "OPTIONS" || !API_BASE.test(request.url)) return;
    if (ctx.response && !LOGIN_PATH.test(request.url)) return;

    if (ctx.response) {
      originalBody = await ctx.response.text();
      consumed = true;
    }

    const old = ctx.storage.getJSON(key) || {};
    const header = (name) => text(request.headers.get(name));
    const authHeader = header("Authorization").match(/^Bearer\s+(\S+)$/i);
    const incoming = {
      accessToken: authHeader ? authHeader[1] : "",
      refreshCookie: "",
      userId: old.userId,
      username: old.username,
      userAgent: header("User-Agent"),
    };

    if (ctx.response) {
      if (ctx.response.status < 200 || ctx.response.status >= 300) return;
      let body;
      try { body = JSON.parse(originalBody); } catch (_) { return; }
      if (!isObject(body) || body.success !== true || !isObject(body.data)) return;
      const data = body.data;
      const accessToken = text(data.access_token) || text(data.accessToken);
      if (!accessToken) return;
      const user = isObject(data.user) ? data.user : {};
      incoming.accessToken = accessToken;
      incoming.userId = Number.isInteger(user.id) ? user.id : incoming.userId;
      incoming.username = text(user.username) || incoming.username;
      const cookie = readRefreshCookie(ctx.response.headers);
      if (cookie) incoming.refreshCookie = cookie;
    }

    if (!incoming.accessToken) {
      console.log("[FreeGG Token] 当前请求未携带 Bearer，且响应里没有登录令牌，未保存。");
      return;
    }
    if (!incoming.refreshCookie) incoming.refreshCookie = text(old.refreshCookie);

    const unchanged =
      incoming.accessToken === text(old.accessToken) &&
      incoming.refreshCookie === text(old.refreshCookie) &&
      incoming.userId === old.userId;
    if (unchanged) {
      console.log("[FreeGG Token] 凭据未变化，跳过保存。");
      return;
    }

    ctx.storage.setJSON(key, {
      accessToken: incoming.accessToken,
      refreshCookie: incoming.refreshCookie,
      userId: incoming.userId,
      username: incoming.username,
      userAgent: incoming.userAgent || text(old.userAgent),
      capturedAt: Date.now(),
    });
    console.log("[FreeGG Token] 已在本机保存，槽位=" + slot + "，刷新 Cookie=" + (incoming.refreshCookie ? "有" : "无") + "。");
    notify(ctx, incoming.refreshCookie
      ? "登录令牌与刷新 Cookie 已保存，可自动续期。请手动运行一次 FreeGG 巡检核对结果。"
      : "登录令牌已保存，但未抓到刷新 Cookie；令牌 15 分钟后会过期，请在网站再次登录以补齐 Cookie。");
  } catch (_) {
    // 不输出异常对象、请求头或原始响应，避免令牌进入日志。
    console.log("[FreeGG Token] 采集未完成，请检查账号槽位设置和脚本存储。");
    notify(ctx, "令牌保存失败，请检查账号槽位和脚本存储；原请求/响应继续透传。");
  } finally {
    if (consumed) return { body: originalBody };
  }
}

// 从响应头里取出 new_api_refresh 的值；只保留键值本身，不保留 Path/MaxAge 等属性。
function readRefreshCookie(headers) {
  if (!headers) return "";
  let raw = "";
  try {
    if (typeof headers.getAll === "function") {
      raw = headers.getAll("set-cookie").join("\n");
    } else {
      raw = headers.get("set-cookie") || "";
    }
  } catch (_) {
    raw = "";
  }
  if (!raw) return "";
  const match = raw.match(new RegExp("(?:^|[\\n;,]\\s*)" + REFRESH_COOKIE + "=([^;\\s,]+)", "i"));
  return match ? match[1] : "";
}

function slotOf(env) {
  const slot = text(env.FREEGG_ACCOUNT_KEY) || "default";
  return /^[a-zA-Z0-9_-]{1,48}$/.test(slot) ? slot : "default";
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function notify(ctx, body) {
  try { ctx.notify({ title: "FreeGG · 令牌采集", body, sound: false }); }
  catch (_) { console.log("[FreeGG Token] 无法发送通知，请检查通知权限。"); }
}
