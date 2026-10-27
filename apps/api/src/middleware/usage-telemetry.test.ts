/**
 * Usage telemetry, driven through the REAL usage middleware wrapped around the
 * REAL rate limiter (the order `index.ts` mounts them in). The route behind
 * them enters the request context the way every key-auth door does
 * (`runWithCallingKey` + `runWithClientKey`, the entries MCP, Hub REST and
 * tRPC-with-a-key call), so the key id and conversation reach the count
 * through the same seam they do in production.
 *
 * Pinned (each against a looser implementation that would pass a shape test):
 *   - counts land per dimension (key, limiter key, client, conversation,
 *     class, outcome), and the client falls back to the conversation's harness;
 *   - a 429 the LIMITER answers (before auth) is counted, with the limiter key
 *     of the key's other rows and NO key id;
 *   - the flush batches: no write per request, ONE flush with every tuple.
 *
 * NOT covered here: the real door's auth (validateApiKey) — the seam is the
 * context entries it calls; the SQL of the flush (api-usage.pglite.test.ts).
 */
import { Hono, type MiddlewareHandler } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ApiUsageCounter,
  clientKeyForApiKey,
  runWithCallingKey,
  runWithClientKey,
  type ApiUsageRow,
} from "@synap/database";

const BUDGET = 3;
let rateLimitMiddleware: MiddlewareHandler;
let createUsageTelemetry: typeof import("./usage-telemetry.js").createUsageTelemetry;

beforeAll(async () => {
  process.env.DATABASE_URL ??=
    "postgresql://synap:test@localhost:5432/synap_test";
  const previous = process.env.RATE_LIMIT_CRUD_MAX;
  process.env.RATE_LIMIT_CRUD_MAX = String(BUDGET);
  ({ rateLimitMiddleware } = await import("./security.js"));
  ({ createUsageTelemetry } = await import("./usage-telemetry.js"));
  if (previous === undefined) delete process.env.RATE_LIMIT_CRUD_MAX;
  else process.env.RATE_LIMIT_CRUD_MAX = previous;
});

/** Key id per Bearer, as the key service would resolve it. */
const KEYS: Record<string, string> = {};

function makeApp(flushed: ApiUsageRow[][]) {
  const counter = new ApiUsageCounter();
  const telemetry = createUsageTelemetry({
    counter,
    flush: async (rows) => {
      flushed.push(rows);
    },
  });
  const app = new Hono();
  app.use("*", telemetry.middleware);
  app.use("*", rateLimitMiddleware);
  app.post("/mcp", (c) => {
    const bearer = (c.req.header("Authorization") ?? "").replace(
      /^Bearer /,
      ""
    );
    const keyId = KEYS[bearer];
    if (!keyId) return c.json({ error: "no key" }, 401);
    const conversation = c.req.header("X-Synap-Conversation");
    return runWithCallingKey(keyId, () =>
      runWithClientKey(clientKeyForApiKey({ id: keyId }, conversation), () =>
        c.json({ ok: true })
      )
    );
  });
  return { app, counter, telemetry };
}

let n = 0;
function newKey(): { bearer: string; id: string } {
  n += 1;
  const bearer = `synap_hub_live_usage_test_key_${n}_${Date.now()}`;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  KEYS[bearer] = id;
  return { bearer, id };
}

const call = (
  app: Hono,
  bearer: string,
  headers: Record<string, string> = {}
) =>
  app.request("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, ...headers },
  });

const CONV = "claude-code:8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";

describe("usage telemetry counts", () => {
  it("lands per dimension; the client falls back to the conversation's harness", async () => {
    const flushed: ApiUsageRow[][] = [];
    const { app, telemetry } = makeApp(flushed);
    const a = newKey();
    const b = newKey();

    // Two bridge calls on key A, one conversation.
    for (let i = 0; i < 2; i++) {
      const res = await call(app, a.bearer, {
        "X-Synap-Client": "synap-bridge/0.6.0",
        "X-Synap-Conversation": CONV,
      });
      expect(res.status).toBe(200);
    }
    // One stdio-bridge call on key A, same conversation: a different client.
    await call(app, a.bearer, {
      "X-Synap-Client": "synap-cli-mcp/1.13.0",
      "X-Synap-Conversation": CONV,
    });
    // Key B names no client: the conversation's harness is the client.
    await call(app, b.bearer, { "X-Synap-Conversation": CONV });
    // An unknown key: refused by the door (401), no key id, client unknown.
    await call(app, "synap_hub_live_unknown_key_for_usage_test");

    await telemetry.flushNow();
    expect(flushed).toHaveLength(1);
    const rows = flushed[0]!;
    const pick = (pred: (r: ApiUsageRow) => boolean) => rows.filter(pred);

    const bridge = pick((r) => r.client === "synap-bridge/0.6.0");
    expect(bridge).toHaveLength(1);
    expect(bridge[0]).toMatchObject({
      apiKeyId: a.id,
      conversationId: CONV,
      rlClass: "crud",
      outcome: "2xx",
      calls: 2,
    });
    expect(bridge[0]!.limiterKey).toMatch(/^key:[0-9a-f]{32}$/);

    const stdio = pick((r) => r.client === "synap-cli-mcp/1.13.0");
    expect(stdio).toHaveLength(1);
    expect(stdio[0]).toMatchObject({ apiKeyId: a.id, calls: 1 });
    expect(stdio[0]!.limiterKey).toBe(bridge[0]!.limiterKey);

    const harness = pick((r) => r.apiKeyId === b.id);
    expect(harness).toHaveLength(1);
    expect(harness[0]).toMatchObject({
      client: "claude-code",
      conversationId: CONV,
    });
    expect(harness[0]!.limiterKey).not.toBe(bridge[0]!.limiterKey);

    const refused = pick((r) => r.outcome === "4xx");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      apiKeyId: null,
      client: "unknown",
      conversationId: null,
    });
  });

  it("a 429 the limiter answers before auth is counted with its limiter key and no key", async () => {
    const flushed: ApiUsageRow[][] = [];
    const { app, telemetry } = makeApp(flushed);
    const k = newKey();
    const statuses: number[] = [];
    for (let i = 0; i < BUDGET + 2; i++) {
      statuses.push(
        (await call(app, k.bearer, { "X-Synap-Client": "synap-bridge/0.6.0" }))
          .status
      );
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);

    await telemetry.flushNow();
    const rows = flushed[0]!;
    const ok = rows.filter((r) => r.outcome === "2xx");
    const limited = rows.filter((r) => r.outcome === "429");
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ apiKeyId: k.id, calls: BUDGET });
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({
      apiKeyId: null,
      rlClass: "crud",
      client: "synap-bridge/0.6.0",
      calls: 2,
    });
    // The join: the refused calls carry the same limiter key as the key's own rows.
    expect(limited[0]!.limiterKey).toBe(ok[0]!.limiterKey);
  });

  it("the flush batches: nothing per request, one flush with every tuple", async () => {
    const flushed: ApiUsageRow[][] = [];
    const { app, telemetry, counter } = makeApp(flushed);
    const k = newKey();
    await call(app, k.bearer, { "X-Synap-Client": "synap-bridge/0.6.0" });
    await call(app, k.bearer, { "X-Synap-Client": "synap-cli/1.13.0" });
    expect(flushed).toHaveLength(0);
    expect(counter.size).toBe(2);

    expect(await telemetry.flushNow()).toBe(2);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.reduce((s, r) => s + r.calls, 0)).toBe(2);
    expect(counter.size).toBe(0);
    // Nothing new → no second write.
    expect(await telemetry.flushNow()).toBe(0);
    expect(flushed).toHaveLength(1);
    telemetry.stop();
  });

  it("a failed flush keeps its counts for the next one", async () => {
    let fail = true;
    const written: ApiUsageRow[][] = [];
    const counter = new ApiUsageCounter();
    const telemetry = createUsageTelemetry({
      counter,
      flush: async (rows) => {
        if (fail) throw new Error("db down");
        written.push(rows);
      },
    });
    const app = new Hono();
    app.use("*", telemetry.middleware);
    app.post("/mcp", (c) => c.json({ ok: true }));
    await app.request("/mcp", { method: "POST" });
    expect(await telemetry.flushNow()).toBe(0);
    fail = false;
    expect(await telemetry.flushNow()).toBe(1);
    expect(written[0]![0]!.calls).toBe(1);
    telemetry.stop();
  });
});
