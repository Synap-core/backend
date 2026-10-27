/**
 * BEHAVIOURAL guard: an answer from `synap_ask` spends the AI budget.
 *
 * `synap_ask` declares `readOnlyHint`, but an answer (detail full or brief)
 * runs a model. Counted as a read it bought 3000 model calls per key per
 * 15 min (founder, 2026-10-27: "make it the right budget"). With
 * `detail: "sources"` no model runs: that stays a read. The Hub's answer door
 * (`/knowledge/answer`) is the AI budget too; its retrieval doors are reads.
 *
 * Negative control (re-run when touching this): in `security.ts`
 * `crudRequestKind`, return "write" where `classifyMcpBody` says "ai" — "an
 * answer from synap_ask stops at the AI budget, with a hint" must go RED.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import {
  classifyMcpBody,
  classifyRateLimitPath,
  isCrudReadPath,
} from "./rate-limit-classes.js";

const AI_BUDGET = 2;
const WRITE_BUDGET = 3;
const READ_BUDGET = 6;
let rateLimitMiddleware: MiddlewareHandler;

let n = 0;
/** A fresh key per test: the limiter's store is module-level. */
const nextKey = () =>
  `Bearer ${`synap_hub_ask_key_${(n += 1)}_`.padEnd(48, "z")}`;

function makeApp() {
  const app = new Hono();
  app.use("*", rateLimitMiddleware);
  app.post("/mcp", async (c) => {
    const body = (await c.req.json()) as { method?: string };
    return c.json({ method: body.method });
  });
  return app;
}

const ask = (app: Hono, key: string, args: Record<string, unknown>) => {
  const text = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "synap_ask", arguments: { query: "who is Ada?", ...args } },
  });
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

describe("synap_ask budget", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgresql://synap:test@localhost:5432/synap_test";
    const budgets = {
      RATE_LIMIT_AI_MAX: String(AI_BUDGET),
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

  it("an answer from synap_ask stops at the AI budget, with a hint", async () => {
    const app = makeApp();
    const key = nextKey();
    for (let i = 0; i < AI_BUDGET; i += 1) {
      expect((await ask(app, key, {})).status).toBe(200);
    }
    const limited = await ask(app, key, { detail: "brief" });
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ class: "ai_interactive", limit: AI_BUDGET });
    expect(String(body.hint)).toMatch(/detail:'sources'/);
    expect(String(body.hint)).toMatch(/synap_get_entity/);
  });

  it("synap_ask with detail:'sources' is a read, past the AI budget", async () => {
    const app = makeApp();
    const key = nextKey();
    for (let i = 0; i < READ_BUDGET; i += 1) {
      expect((await ask(app, key, { detail: "sources" })).status).toBe(200);
    }
    const limited = await ask(app, key, { detail: "sources" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ class: "crud_read" });
  });
});

describe("the Hub's knowledge doors", () => {
  it("the answer door is the AI budget; the retrieval doors are reads", () => {
    for (const p of [
      "/api/hub/knowledge/answer",
      "/api/hub-protocol/knowledge/answer",
    ]) {
      expect(classifyRateLimitPath(p, "POST")).toBe("ai_interactive");
    }
    for (const p of ["/api/hub/knowledge/search", "/api/hub/knowledge/ask"]) {
      expect(classifyRateLimitPath(p, "POST")).toBe("crud");
      expect(isCrudReadPath(p, "POST")).toBe(true);
    }
    expect(isCrudReadPath("/api/hub/entities", "POST")).toBe(false);
  });
});

describe("classifyMcpBody", () => {
  const readOnly = new Set(["synap_get_entity", "synap_ask"]);
  const call = (name: string, args: Record<string, unknown> = {}) => ({
    method: "tools/call",
    params: { name, arguments: args },
  });

  it("synap_ask: an answer is ai; sources or compare is a read", () => {
    expect(classifyMcpBody(call("synap_ask"), readOnly)).toBe("ai");
    expect(classifyMcpBody(call("synap_ask", { detail: "full" }), readOnly)).toBe(
      "ai"
    );
    expect(
      classifyMcpBody(call("synap_ask", { detail: "sources" }), readOnly)
    ).toBe("read");
    expect(classifyMcpBody(call("synap_ask", { compare: true }), readOnly)).toBe(
      "read"
    );
  });

  it("a batch: any write is a write, else any ai is ai", () => {
    expect(
      classifyMcpBody(
        [call("synap_get_entity"), call("synap_ask")],
        readOnly
      )
    ).toBe("ai");
    expect(
      classifyMcpBody([call("synap_ask"), call("synap_create_entity")], readOnly)
    ).toBe("write");
  });
});
