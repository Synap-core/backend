/**
 * Every messaging WRITE needs `hub-protocol.write`.
 *
 * Only `/messaging/inbound` checked a scope; the `app.openapi` writes (send an
 * external message, overwrite the connector DSN/apiKey, delete accounts and
 * channels, import a thread, …) ran for a read-only key.
 *
 * The scanned set is DERIVED from the routes `registerMessagingRoutes`
 * registers — a new write route joins by existing, and fails here until it has
 * a fixture (a valid request, so the validator cannot answer 400 first and
 * make the row pass vacuously). Reachability is asserted both ways: a
 * read-only key never reaches the handler body; a write key does.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reached } = vi.hoisted(() => ({ reached: vi.fn() }));

/** Any touch of the database or the connector means the handler body ran. */
const probe = (name: string): unknown =>
  new Proxy(() => undefined, {
    get: (_t, prop) => {
      if (prop === "then") return undefined; // not a thenable
      reached(`${name}.${String(prop)}`);
      throw new Error(`reached ${name}.${String(prop)}`);
    },
    apply: () => {
      reached(name);
      throw new Error(`reached ${name}()`);
    },
  });

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: probe("db"),
    upsertServiceSecret: probe("upsertServiceSecret"),
    getServiceSecret: probe("getServiceSecret"),
    ensureExternalChannel: probe("ensureExternalChannel"),
  };
});
vi.mock("../../../connectors/index.js", () => ({
  getMessagingConnector: probe("getMessagingConnector"),
}));
vi.mock("../../../connectors/external-dispatch.js", () => ({
  sendExternalMessage: probe("sendExternalMessage"),
}));
vi.mock("../../../services/connector-import-bridge.js", () => ({
  pullToImport: probe("pullToImport"),
}));
vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  return {
    ...actual,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    resolveActingContext: probe("resolveActingContext"),
  };
});

const { registerMessagingRoutes } = await import("./messaging.js");
import type { HubHono, HubVariables } from "./_shared.js";

const ID = "00000000-0000-4000-8000-000000000001";

/** "METHOD /registered/:path" → a request the route's validator accepts. */
const FIXTURES: Record<string, { url: string; body?: unknown }> = {
  "POST /messaging/inbound": {
    url: "/messaging/inbound",
    body: { provider: "email", messageId: "m1", externalId: "x1", text: "hi" },
  },
  "POST /messaging/accounts/sync": { url: "/messaging/accounts/sync" },
  "POST /messaging/service-config/migrate": {
    url: "/messaging/service-config/migrate",
  },
  "POST /messaging/service-config": {
    url: "/messaging/service-config",
    body: { dsn: "https://attacker.example", apiKey: "k" },
  },
  "DELETE /messaging/accounts/:accountId": { url: "/messaging/accounts/a1" },
  "POST /messaging/channels/connect": {
    url: "/messaging/channels/connect",
    body: { externalThreadId: "t1", accountId: "a1", provider: "WHATSAPP" },
  },
  "DELETE /messaging/channels/:channelId": {
    url: `/messaging/channels/${ID}`,
  },
  "POST /messaging/channels/:channelId/mark-read": {
    url: `/messaging/channels/${ID}/mark-read`,
  },
  "POST /messaging/conversations/:threadId/import": {
    url: "/messaging/conversations/t1/import",
    body: { accountId: "a1" },
  },
  "POST /messaging/conversations/:threadId/send": {
    url: "/messaging/conversations/t1/send",
    body: { accountId: "a1", body: "hello" },
  },
};

function app(scopes: string[]) {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", async (c, next) => {
    c.set("userId", "owner");
    c.set("scopes", scopes);
    await next();
  });
  registerMessagingRoutes(hub);
  return hub;
}

function writeRoutes(): string[] {
  const seen = new Set<string>();
  for (const r of app([]).routes) {
    if (r.method === "GET" || r.method === "ALL") continue;
    if (!r.path.startsWith("/messaging/")) continue;
    seen.add(`${r.method} ${r.path}`);
  }
  return [...seen].sort();
}

async function call(route: string, scopes: string[]) {
  const [method] = route.split(" ");
  const f = FIXTURES[route];
  return app(scopes).request(f.url, {
    method,
    headers: { "content-type": "application/json" },
    ...(f.body !== undefined ? { body: JSON.stringify(f.body) } : {}),
  });
}

beforeEach(() => reached.mockClear());

describe("messaging writes — hub-protocol.write", () => {
  const routes = writeRoutes();

  it("scans the registered write routes (non-vacuity), each with a fixture", () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
    expect(routes).toContain("POST /messaging/conversations/:threadId/send");
    expect(routes.filter((r) => !FIXTURES[r])).toEqual([]);
  });

  it.each(routes)(
    "%s → 403 for a read-only key, handler never runs",
    async (route) => {
      const res = await call(route, ["hub-protocol.read"]);
      expect(res.status).toBe(403);
      expect(reached).not.toHaveBeenCalled();
    }
  );

  it.each(routes)(
    "%s → a write key reaches the handler (fixture is valid)",
    async (route) => {
      await call(route, ["hub-protocol.read", "hub-protocol.write"]);
      expect(reached).toHaveBeenCalled();
    }
  );
});
