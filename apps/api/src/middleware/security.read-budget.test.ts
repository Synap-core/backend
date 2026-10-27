/**
 * BEHAVIOURAL guard for the `crud` read budget (`crud_read`).
 *
 * The defect this pins: reads and writes of one key shared ONE `crud` budget
 * (500 per 15 min). Four agents on one key, mostly reading (get_session,
 * get_entities, get_proposal), were 429'd three times on 2026-10-27. Reads
 * now spend their own bucket; writes keep theirs, so a runaway writer still
 * stops at the write budget.
 *
 * Negative control (re-run when touching this): make `isCrudRead` in
 * `security.ts` return false — "reads go on past the write budget" and "a
 * read-only MCP tool call is a read" must go RED.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import {
  isCrudReadPath,
  isMcpReadBody,
} from "./rate-limit-classes.js";

const WRITE_BUDGET = 3;
const READ_BUDGET = 6;
let rateLimitMiddleware: MiddlewareHandler;

let n = 0;
/** A fresh key per test: the limiter's store is module-level. */
const nextKey = () =>
  `Bearer ${`synap_hub_test_key_${(n += 1)}_`.padEnd(48, "x")}`;

function makeApp() {
  const app = new Hono();
  app.use("*", rateLimitMiddleware);
  app.get("/api/hub/*", (c) => c.json({ ok: true }));
  app.post("/api/hub/*", (c) => c.json({ ok: true }));
  // Reads its body again, as the MCP handler does: the edge must leave it.
  app.post("/mcp", async (c) => {
    const body = (await c.req.json()) as { method?: string };
    return c.json({ method: body.method });
  });
  return app;
}

const get = (app: Hono, key: string) =>
  app.request("/api/hub/entities", { headers: { authorization: key } });
const post = (app: Hono, key: string) =>
  app.request("/api/hub/entities", {
    method: "POST",
    headers: { authorization: key, "content-type": "application/json" },
    body: "{}",
  });
const mcp = (app: Hono, key: string, body: unknown) => {
  const text = JSON.stringify(body);
  return app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: key,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
    },
    body: text,
  });
};
const toolCall = (name: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: {} },
});

describe("crud read budget", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgresql://synap:test@localhost:5432/synap_test";
    const budgets = {
      RATE_LIMIT_CRUD_MAX: String(WRITE_BUDGET),
      RATE_LIMIT_CRUD_READ_MAX: String(READ_BUDGET),
      RATE_LIMIT_CRUD_IP_CEILING: "1000",
    };
    const previous = Object.fromEntries(
      Object.keys(budgets).map((k) => [k, process.env[k]])
    );
    Object.assign(process.env, budgets);
    ({ rateLimitMiddleware } = await import("./security.js"));
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("reads go on past the write budget, up to the read budget", async () => {
    const app = makeApp();
    const key = nextKey();
    for (let i = 0; i < READ_BUDGET; i += 1) {
      expect((await get(app, key)).status).toBe(200);
    }
    const limited = await get(app, key);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      class: "crud_read",
      limit: READ_BUDGET,
    });
  });

  it("writes still stop at the write budget", async () => {
    const app = makeApp();
    const key = nextKey();
    for (let i = 0; i < WRITE_BUDGET; i += 1) {
      expect((await post(app, key)).status).toBe(200);
    }
    const limited = await post(app, key);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      class: "crud",
      limit: WRITE_BUDGET,
    });
  });

  it("a key that spent its reads can still write, and the reverse", async () => {
    const app = makeApp();
    const reader = nextKey();
    for (let i = 0; i < READ_BUDGET; i += 1) await get(app, reader);
    expect((await get(app, reader)).status).toBe(429);
    expect((await post(app, reader)).status).toBe(200);

    const writer = nextKey();
    for (let i = 0; i < WRITE_BUDGET; i += 1) await post(app, writer);
    expect((await post(app, writer)).status).toBe(429);
    expect((await get(app, writer)).status).toBe(200);
  });

  it("a read-only MCP tool call is a read, and its body still reaches the handler", async () => {
    const app = makeApp();
    const key = nextKey();
    for (let i = 0; i < READ_BUDGET; i += 1) {
      const res = await mcp(app, key, toolCall("synap_get_entity"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ method: "tools/call" });
    }
    expect((await mcp(app, key, toolCall("synap_get_entity"))).status).toBe(
      429
    );
  });

  it("a write MCP tool call spends the write budget", async () => {
    const app = makeApp();
    const key = nextKey();
    for (let i = 0; i < WRITE_BUDGET; i += 1) {
      expect(
        (await mcp(app, key, toolCall("synap_create_entity"))).status
      ).toBe(200);
    }
    const limited = await mcp(app, key, toolCall("synap_create_entity"));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ class: "crud" });
  });
});

describe("isCrudReadPath", () => {
  it("reads: GET, HEAD and OPTIONS on the Hub and the MCP door", () => {
    expect(isCrudReadPath("/api/hub/entities", "GET")).toBe(true);
    expect(isCrudReadPath("/api/hub-protocol/sessions/x", "HEAD")).toBe(true);
    expect(isCrudReadPath("/api/hub/trpc/entities.list", "GET")).toBe(true);
    expect(isCrudReadPath("/mcp", "OPTIONS")).toBe(true);
  });

  it("not reads: writes, and GETs outside the Hub", () => {
    expect(isCrudReadPath("/api/hub/entities", "POST")).toBe(false);
    expect(isCrudReadPath("/api/hub/entities/x", "DELETE")).toBe(false);
    expect(isCrudReadPath("/trpc/entities.list", "GET")).toBe(false);
    expect(isCrudReadPath("/api/hubby", "GET")).toBe(false);
  });
});

describe("isMcpReadBody", () => {
  const readOnly = new Set(["synap_get_entity"]);

  it("reads: a read-only tool, the protocol's read methods, notifications", () => {
    expect(isMcpReadBody(toolCall("synap_get_entity"), readOnly)).toBe(true);
    for (const method of ["initialize", "tools/list", "resources/read"]) {
      expect(isMcpReadBody({ method }, readOnly)).toBe(true);
    }
    expect(
      isMcpReadBody({ method: "notifications/initialized" }, readOnly)
    ).toBe(true);
  });

  it("writes: other tools, unknown tools, odd bodies, a batch with one write", () => {
    expect(isMcpReadBody(toolCall("synap_create_entity"), readOnly)).toBe(
      false
    );
    expect(isMcpReadBody(toolCall("no_such_tool"), readOnly)).toBe(false);
    expect(isMcpReadBody({ method: "tools/call" }, readOnly)).toBe(false);
    expect(isMcpReadBody(null, readOnly)).toBe(false);
    expect(isMcpReadBody([], readOnly)).toBe(false);
    expect(
      isMcpReadBody(
        [toolCall("synap_get_entity"), toolCall("synap_create_entity")],
        readOnly
      )
    ).toBe(false);
  });
});
