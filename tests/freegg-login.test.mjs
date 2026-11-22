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

function defaultHandler(overrides = {}) {
  return (method, url) => {
    if (url.endsWith("/api/status")) {
      return { status: 200, data: { success: true, data: SITE } };
    }
    if (url.includes("/api/user/self")) {
      return {
        status: 200,
        data: {
          success: true,
          data: {
            id: 7,
            username: "tester",
            email: "tester@example.com",
            group: "default",
            quota: 1600000,
            used_quota: 280000,
            request_count: 42,
          },
        },
      };
    }
    return overrides[method + " " + url] ? overrides[method + " " + url](method, url) : { status: 404, data: { success: false, message: "not found" } };
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
  const ctx = createCtx({
    env: { ACCESS_TOKEN: "token-abc" },
    handler: defaultHandler(),
  });
  await main(ctx);
  const body = ctx.notifications[0].body;
  assert.match(body, /当前余额：\$3\.20/);
  assert.match(body, /累计消耗：\$0\.56/);
  assert.match(body, /累计调用：42 次/);
  assert.match(body, /认证方式：配置/);
  // 站点未开放签到时应如实说明，而不是当作失败
  assert.match(ctx.notifications[0].body + ctx.notifications[0].title, /未开放签到|巡检/);
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
        return {
          status: 200,
          data: { success: true, data: { id: 7, username: "tester", quota: 1600000, used_quota: 280000, request_count: 42 } },
        };
      }
      return { status: 404, data: { success: false } };
    },
  });
  await main(ctx);
  assert.equal(selfCalls, 2, "401 后续期并重试一次");
  const saved = JSON.parse(ctx.storage.get("freegg.egern.v1.default.session"));
  assert.equal(saved.accessToken, "fresh-token", "新令牌写回本机");
  assert.equal(saved.refreshCookie, "cookie-v2", "轮换后的刷新 Cookie 写回本机");
});

test("站点启用 Turnstile 时拒绝用账号密码登录", async () => {
  const ctx = createCtx({
    env: { USERNAME: "tester", PASSWORD: "secret" },
    handler: defaultHandler(),
  });
  await main(ctx);
  assert.match(ctx.notifications[0].body, /Turnstile/);
  assert.ok(
    !ctx.calls.some((call) => call.url.includes("/api/user/login")),
    "不应向登录接口发起必然失败的请求"
  );
});

test("未启用 Turnstile 时可用账号密码登录并保存会话", async () => {
  const ctx = createCtx({
    env: { USERNAME: "tester", PASSWORD: "secret" },
    handler: (method, url) => {
      if (url.endsWith("/api/status")) {
        return { status: 200, data: { success: true, data: { ...SITE, turnstile_check: false } } };
      }
      if (url.includes("/api/user/login")) {
        return {
          status: 200,
          data: { success: true, data: { access_token: "login-token", user: { id: 7, username: "tester" } } },
        };
      }
      if (url.includes("/api/user/self")) {
        return {
          status: 200,
          data: { success: true, data: { id: 7, username: "tester", quota: 1600000, used_quota: 280000, request_count: 42 } },
        };
      }
      return { status: 404, data: { success: false } };
    },
  });
  await main(ctx);
  const saved = JSON.parse(ctx.storage.get("freegg.egern.v1.default.session"));
  assert.equal(saved.accessToken, "login-token");
  assert.match(ctx.notifications[0].body, /认证方式：账号密码/);
});

test("站点开放签到时执行签到并回报奖励", async () => {
  const ctx = createCtx({
    env: { ACCESS_TOKEN: "token-abc" },
    handler: (method, url) => {
      if (url.endsWith("/api/status")) {
        return { status: 200, data: { success: true, data: { ...SITE, checkin_enabled: true, turnstile_check: false } } };
      }
      if (url.includes("/api/user/checkin") && method === "GET") {
        return {
          status: 200,
          data: {
            success: true,
            data: {
              enabled: true,
              min_quota: 5000,
              max_quota: 50000,
              stats: { checked_in_today: false, checkin_count: 0, total_checkins: 0, total_quota: 0, records: [] },
            },
          },
        };
      }
      if (url.includes("/api/user/checkin") && method === "POST") {
        return { status: 200, data: { success: true, data: { quota_awarded: 25000, checkin_date: "2026-11-22" } } };
      }
      if (url.includes("/api/user/self")) {
        return {
          status: 200,
          data: { success: true, data: { id: 7, username: "tester", quota: 1600000, used_quota: 280000, request_count: 42 } },
        };
      }
      return { status: 404, data: { success: false } };
    },
  });
  await main(ctx);
  assert.match(ctx.notifications[0].body, /签到成功/);
  assert.match(ctx.notifications[0].body, /本次奖励：\+\$0\.05/);
});

test("今日已签到时读取当月记录并标注今日奖励", async () => {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const ctx = createCtx({
    env: { ACCESS_TOKEN: "token-abc" },
    handler: (method, url) => {
      if (url.endsWith("/api/status")) {
        return { status: 200, data: { success: true, data: { ...SITE, checkin_enabled: true, turnstile_check: false } } };
      }
      if (url.includes("/api/user/checkin") && method === "GET") {
        return {
          status: 200,
          data: {
            success: true,
            data: {
              enabled: true,
              stats: {
                checked_in_today: true,
                records: [{ checkin_date: date, quota_awarded: 12000 }],
              },
            },
          },
        };
      }
      if (url.includes("/api/user/self")) {
        return {
          status: 200,
          data: { success: true, data: { id: 7, username: "tester", quota: 1600000, used_quota: 280000, request_count: 42 } },
        };
      }
      return { status: 404, data: { success: false } };
    },
  });
  await main(ctx);
  assert.match(ctx.notifications[0].body, /今日已签到/);
  assert.match(ctx.notifications[0].body, /今日奖励：\$0\.02（今日记录）/);
});

test("多账号分别巡检并汇总成一条通知", async () => {
  const ctx = createCtx({
    env: {
      FREEGG_ACCOUNTS: JSON.stringify([
        { username: "a@example.com", accessToken: "t1" },
        { username: "b@example.com", accessToken: "t2" },
      ]),
    },
    handler: (method, url) => {
      if (url.endsWith("/api/status")) return { status: 200, data: { success: true, data: SITE } };
      if (url.includes("/api/user/self")) {
        return {
          status: 200,
          data: { success: true, data: { id: 7, username: "a@example.com", quota: 1600000, used_quota: 0, request_count: 1 } },
        };
      }
      return { status: 404, data: { success: false } };
    },
  });
  await main(ctx);
  assert.equal(ctx.notifications.length, 1, "只发一条汇总通知");
  assert.match(ctx.notifications[0].title, /2 个账号/);
  assert.match(ctx.notifications[0].body, /账号 1/);
  assert.match(ctx.notifications[0].body, /账号 2/);
});
