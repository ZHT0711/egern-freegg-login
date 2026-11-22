import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "..", "freegg-login.js"), "utf8");
const { default: main } = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

const SITE = {
  system_name: "FreeGG",
  checkin_enabled: false,
  turnstile_check: true,
  quota_per_unit: 500000,
  quota_display_type: "USD",
  usd_exchange_rate: 7.3,
  display_in_currency: true,
};

function pad(n) { return String(n).padStart(2, "0"); }
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// 今天某时刻的秒级时间戳
function todayAt(hour = 9) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function createCtx({ env = {}, storage = {}, handler }) {
  const store = new Map(Object.entries(storage));
  const calls = [];
  const notifications = [];
  const ctx = {
    env,
    calls,
    notifications,
    storage: {
      get: (key) => (store.has(key) ? store.get(key) : null),
      set: (key, value) => store.set(key, value),
      getJSON: (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
      setJSON: (key, value) => store.set(key, JSON.stringify(value)),
      delete: (key) => store.delete(key),
    },
    notify: (options) => notifications.push(options),
    http: {
      get: async (url, options) => {
        calls.push({ method: "GET", url, options });
        return respond(handler("GET", url, options));
      },
      post: async (url, options) => {
        calls.push({ method: "POST", url, options });
        return respond(handler("POST", url, options));
      },
    },
  };
  return ctx;
}

function respond(result) {
  const { status = 200, data = {}, headers = null } = result || {};
  return {
    status,
    headers: {
      get: (name) => (headers && headers[name.toLowerCase()] ? headers[name.toLowerCase()] : null),
      getAll: (name) => (headers && headers[name.toLowerCase()] ? [headers[name.toLowerCase()]] : []),
    },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function selfBody(quota, usedQuota = 280000) {
  return {
    status: 200,
    data: {
      success: true,
      data: { id: 7, username: "tester", email: "tester@example.com", group: "default", quota, used_quota: usedQuota, request_count: 42 },
    },
  };
}

function logBody(items) {
  return { status: 200, data: { success: true, data: { items, total: items.length, page: 1, page_size: 30 } } };
}

function defaultHandler(overrides = {}) {
  return (method, url) => {
    const key = method + " " + url;
    if (overrides[key]) return overrides[key](method, url);
    if (url.endsWith("/api/status")) return { status: 200, data: { success: true, data: SITE } };
    if (url.includes("/api/user/self")) return selfBody(1600000);
    if (url.includes("/api/log/self")) return logBody([]);
    return { status: 404, data: { success: false, message: "not found" } };
  };
}

test("未配置账号时给出明确提示", async () => {
  const ctx = createCtx({ env: {}, handler: defaultHandler() });
  await main(ctx);
  assert.equal(ctx.notifications.length, 1);
  assert.match(ctx.notifications[0].body, /未配置账号/);
});

test("多账号 JSON 格式错误时报错而不是静默跳过", async () => {
  const ctx = createCtx({ env: { FREEGG_ACCOUNTS: "{oops" }, handler: defaultHandler() });
  await main(ctx);
  assert.match(ctx.notifications[0].body, /FREEGG_ACCOUNTS 格式错误/);
});

test("使用 ACCESS_TOKEN 巡检并汇报余额与消耗", async () => {
  const ctx = createCtx({ env: { ACCESS_TOKEN: "token-abc" }, handler: defaultHandler() });
  await main(ctx);
  const body = ctx.notifications[0].body;
  assert.match(body, /当前余额：\$3\.20/);
  assert.match(body, /累计消耗：\$0\.56/);
  assert.match(body, /累计调用：42 次/);
  assert.match(body, /认证方式：配置令牌/);
});

test("access_token 只放在 Bearer 头里，不写进日志或通知", async () => {
  const ctx = createCtx({ env: { ACCESS_TOKEN: "super-secret-token" }, handler: defaultHandler() });
  await main(ctx);
  const selfCall = ctx.calls.find((c) => c.url.includes("/api/user/self"));
  assert.equal(selfCall.options.headers.Authorization, "Bearer super-secret-token");
  assert.ok(!ctx.notifications[0].body.includes("super-secret-token"), "通知里不应出现令牌明文");
});

test("日志里有今日额度发放记录时判定已到账并带出金额", async () => {
  const ctx = createCtx({
    env: { ACCESS_TOKEN: "token-abc" },
    handler: defaultHandler({
      "GET https://freegg.app/api/log/self?p=1&page_size=30": () =>
        logBody([
          { type: 2, content: "模型调用", quota: -1200, created_at: todayAt(10) },
          { type: 4, content: "Daily allowance credited: $0.0020", quota: 1000, created_at: todayAt(9) },
        ]),
    }),
  });
  await main(ctx);
  const n = ctx.notifications[0];
  assert.match(n.body, /今日额度已到账/);
  assert.match(n.body, /今日奖励：\+\$0\.00/);
});

test("中文额度日志同样能识别", async () => {
  const ctx = createCtx({
    env: { ACCESS_TOKEN: "token-abc" },
    handler: defaultHandler({
      "GET https://freegg.app/api/log/self?p=1&page_size=30": () =>
        logBody([{ type: 4, content: "每日额度发放 $0.0100", quota: 5000, created_at: todayAt(8) }]),
    }),
  });
  await main(ctx);
  assert.match(ctx.notifications[0].body, /今日额度已到账/);
  assert.match(ctx.notifications[0].body, /今日奖励：\+\$0\.01/);
});

test("昨天的发放记录不算今天到账", async () => {
  const yesterday = todayAt(9) - 86400;
  const ctx = createCtx({
    env: { ACCESS_TOKEN: "token-abc" },
    handler: defaultHandler({
      "GET https://freegg.app/api/log/self?p=1&page_size=30": () =>
        logBody([{ type: 4, content: "Daily allowance credited: $0.0020", quota: 1000, created_at: yesterday }]),
    }),
  });
  await main(ctx);
  assert.match(ctx.notifications[0].body, /今日额度待确认/);
});

test("没有额度日志时用余额同比兜底", async () => {
  const ctx = createCtx({
    env: { ACCESS_TOKEN: "token-abc" },
    storage: {
      "freegg.egern.v1.default.daily": JSON.stringify({
        date: "2000-01-01",
        quota: 1599000,
        usedQuota: 280000,
        credited: false,
      }),
    },
    handler: defaultHandler(),
  });
  await main(ctx);
  const n = ctx.notifications[0];
  assert.match(n.body, /今日额度已到账/);
  assert.match(n.body, /按余额同比推算/);
});

test("同一天重复运行不会把同一次发放重复计算", async () => {
  const ctx = createCtx({
    env: { ACCESS_TOKEN: "token-abc" },
    storage: {
      "freegg.egern.v1.default.daily": JSON.stringify({
        date: todayStr(),
        quota: 1599000,
        usedQuota: 280000,
        credited: true,
      }),
    },
    handler: defaultHandler(),
  });
  await main(ctx);
  assert.match(ctx.notifications[0].body, /今日额度待确认/);
});

test("中途用过量时不按余额差误报奖励", async () => {
  const ctx = createCtx({
    env: { ACCESS_TOKEN: "token-abc" },
    storage: {
      "freegg.egern.v1.default.daily": JSON.stringify({
        date: "2000-01-01",
        quota: 1000000,
        usedQuota: 100000, // 与本次 self 的 280000 不同
        credited: false,
      }),
    },
    handler: defaultHandler(),
  });
  await main(ctx);
  assert.match(ctx.notifications[0].body, /今日额度待确认/);
});

test("访问令牌过期时用刷新 Cookie 续期并重试", async () => {
  let selfCalls = 0;
  const ctx = createCtx({
    env: {},
    storage: {
      "freegg.egern.v1.default.session": JSON.stringify({
        accessToken: "stale-token",
        refreshCookie: "cookie-v1",
        userId: 7,
        username: "tester",
      }),
    },
    handler: (method, url) => {
      if (url.endsWith("/api/status")) return { status: 200, data: { success: true, data: SITE } };
      if (url.includes("/api/user/auth/refresh")) {
        return {
          status: 200,
          data: { success: true, data: { access_token: "fresh-token", user: { id: 7, username: "tester" } } },
          headers: { "set-cookie": "new_api_refresh=cookie-v2; Path=/api/user/auth; HttpOnly" },
        };
      }
      if (url.includes("/api/user/self")) {
        selfCalls += 1;
        if (selfCalls === 1) return { status: 401, data: { code: "AUTH_TOKEN_EXPIRED", message: "Unauthorized" } };
        return selfBody(1600000);
      }
      if (url.includes("/api/log/self")) return logBody([]);
      return { status: 404, data: { success: false } };
    },
  });
  await main(ctx);
  assert.equal(selfCalls, 2, "401 后续期并重试一次");
  const saved = JSON.parse(ctx.storage.get("freegg.egern.v1.default.session"));
  assert.equal(saved.accessToken, "fresh-token", "新令牌写回本机");
  assert.equal(saved.refreshCookie, "cookie-v2", "轮换后的刷新 Cookie 写回本机");
  assert.match(ctx.notifications[0].body, /认证方式：本机采集（已续期）/);
});

test("续期请求把 Cookie 值补回键名", async () => {
  const ctx = createCtx({
    env: {},
    storage: {
      "freegg.egern.v1.default.session": JSON.stringify({ accessToken: "stale", refreshCookie: "cookie-v1", userId: 7 }),
    },
    handler: (method, url) => {
      if (url.endsWith("/api/status")) return { status: 200, data: { success: true, data: SITE } };
      if (url.includes("/api/user/auth/refresh")) {
        return { status: 200, data: { success: true, data: { access_token: "fresh" } }, headers: { "set-cookie": "new_api_refresh=c2" } };
      }
      if (url.includes("/api/user/self")) {
        const auth = ctx.calls.filter((c) => c.url.includes("/api/user/self")).length;
        if (auth === 0 || ctx.calls.filter((c) => c.url.includes("/api/user/self"))[0].options.headers.Authorization === "Bearer stale") {
          return { status: 401, data: { success: false } };
        }
        return selfBody(1600000);
      }
      if (url.includes("/api/log/self")) return logBody([]);
      return { status: 404, data: { success: false } };
    },
  });
  await main(ctx);
  const refresh = ctx.calls.find((c) => c.url.includes("/api/user/auth/refresh"));
  assert.equal(refresh.options.headers.Cookie, "new_api_refresh=cookie-v1");
});

test("站点启用 Turnstile 时拒绝用账号密码登录", async () => {
  const ctx = createCtx({ env: { USERNAME: "tester", PASSWORD: "secret" }, handler: defaultHandler() });
  await main(ctx);
  assert.match(ctx.notifications[0].body, /Turnstile/);
  assert.ok(!ctx.calls.some((call) => call.url.includes("/api/user/login")), "不应向登录接口发起必然失败的请求");
});

test("未启用 Turnstile 时可用账号密码登录并保存会话", async () => {
  const ctx = createCtx({
    env: { USERNAME: "tester", PASSWORD: "secret" },
    handler: (method, url) => {
      if (url.endsWith("/api/status")) return { status: 200, data: { success: true, data: { ...SITE, turnstile_check: false } } };
      if (url.includes("/api/user/login")) {
        return { status: 200, data: { success: true, data: { access_token: "login-token", user: { id: 7, username: "tester" } } } };
      }
      if (url.includes("/api/user/self")) return selfBody(1600000);
      if (url.includes("/api/log/self")) return logBody([]);
      return { status: 404, data: { success: false } };
    },
  });
  await main(ctx);
  const saved = JSON.parse(ctx.storage.get("freegg.egern.v1.default.session"));
  assert.equal(saved.accessToken, "login-token");
  assert.match(ctx.notifications[0].body, /认证方式：账号密码/);
});

test("站点开放签到时额外执行签到并回报奖励", async () => {
  const ctx = createCtx({
    env: { ACCESS_TOKEN: "token-abc" },
    handler: (method, url) => {
      if (url.endsWith("/api/status")) return { status: 200, data: { success: true, data: { ...SITE, checkin_enabled: true, turnstile_check: false } } };
      if (url.includes("/api/user/checkin") && method === "GET") {
        return { status: 200, data: { success: true, data: { enabled: true, stats: { checked_in_today: false, records: [] } } } };
      }
      if (url.includes("/api/user/checkin") && method === "POST") {
        return { status: 200, data: { success: true, data: { quota_awarded: 25000, checkin_date: todayStr() } } };
      }
      if (url.includes("/api/user/self")) return selfBody(1600000);
      if (url.includes("/api/log/self")) return logBody([]);
      return { status: 404, data: { success: false } };
    },
  });
  await main(ctx);
  assert.match(ctx.notifications[0].body, /签到成功/);
  assert.match(ctx.notifications[0].body, /签到奖励：\+\$0\.05/);
});

test("未开放签到时不发多余的签到请求", async () => {
  const ctx = createCtx({ env: { ACCESS_TOKEN: "token-abc" }, handler: defaultHandler() });
  await main(ctx);
  assert.ok(!ctx.calls.some((c) => c.url.includes("/api/user/checkin")), "checkin_enabled=false 时不应请求签到接口");
});

test("多账号分别巡检并汇总成一条通知", async () => {
  const ctx = createCtx({
    env: { FREEGG_ACCOUNTS: JSON.stringify([{ username: "a@example.com", accessToken: "t1" }, { username: "b@example.com", accessToken: "t2" }]) },
    handler: defaultHandler(),
  });
  await main(ctx);
  assert.equal(ctx.notifications.length, 1, "只发一条汇总通知");
  assert.match(ctx.notifications[0].title, /2 个账号/);
  assert.match(ctx.notifications[0].body, /账号 1/);
  assert.match(ctx.notifications[0].body, /账号 2/);
});

test("单个账号失败不影响其它账号", async () => {
  const ctx = createCtx({
    env: { FREEGG_ACCOUNTS: JSON.stringify([{ username: "a@example.com", accessToken: "bad" }, { username: "b@example.com", accessToken: "good" }]) },
    handler: (method, url) => {
      if (url.endsWith("/api/status")) return { status: 200, data: { success: true, data: SITE } };
      if (url.includes("/api/user/self")) {
        const auth = ctx.calls.filter((c) => c.url.includes("/api/user/self")).slice(-1)[0];
        if (auth.options.headers.Authorization === "Bearer bad") return { status: 401, data: { message: "Unauthorized" } };
        return selfBody(1600000);
      }
      if (url.includes("/api/log/self")) return logBody([]);
      return { status: 404, data: { success: false } };
    },
  });
  await main(ctx);
  const body = ctx.notifications[0].body;
  assert.match(body, /运行失败/);
  assert.match(body, /当前余额：\$3\.20/);
});
