/**
 * `/api/pod-rate-limits/*` through the REAL router with fake stores, and the
 * REAL edge limiter behind it: a budget the owner sets takes effect on the
 * next request, with no redeploy and no re-import.
 *
 * Negative control (re-run when touching this): drop the
 * `setRateLimitOverrides(clean)` call from the PUT route — "a budget set
 * here is enforced on the next request" must go RED.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createPodRateLimitsRouter,
  parseRateLimitsPatch,
  type PodRateLimitsDeps,
} from "./pod-rate-limits.js";
import {
  setRateLimitOverrides,
  type RateLimitBudgetView,
} from "../middleware/rate-limit-classes.js";

let rateLimitMiddleware: MiddlewareHandler;

beforeAll(async () => {
  process.env.DATABASE_URL ??=
    "postgresql://synap:test@localhost:5432/synap_test";
  ({ rateLimitMiddleware } = await import("../middleware/security.js"));
});

afterEach(() => {
  setRateLimitOverrides({});
});

function harness(opts: { admin: boolean; stored?: unknown; readFails?: boolean }) {
  let stored: unknown = opts.stored;
  const writes: unknown[] = [];
  const audits: string[] = [];
  const auth: MiddlewareHandler = async (c, next) => {
    c.set("userId" as never, "kratos-1" as never);
    await next();
  };
  const deps: PodRateLimitsDeps = {
    authenticate: [auth],
    resolveUserId: async () => "user-1",
    isPodAdmin: async () => opts.admin,
    readValuesRaw: async () => {
      if (opts.readFails) throw new Error("db down");
      return stored;
    },
    writeValues: async (next) => {
      writes.push(next);
      stored = next;
    },
    audit: async (e) => {
      audits.push(e.change);
    },
  };
  return { router: createPodRateLimitsRouter(deps), writes, audits };
}

const put = (values: unknown) => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ values }),
});

const budgetOf = (budgets: RateLimitBudgetView[], key: string) =>
  budgets.find((b) => b.key === key);

describe("GET /", () => {
  it("lists every budget with its value, source and default", async () => {
    const { router } = harness({ admin: false });
    const res = await router.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      budgets: RateLimitBudgetView[];
      canEdit: boolean;
    };
    expect(body.canEdit).toBe(false);
    expect(budgetOf(body.budgets, "RATE_LIMIT_CRUD_MAX")).toMatchObject({
      defaultValue: 500,
    });
    expect(budgetOf(body.budgets, "RATE_LIMIT_CRUD_READ_MAX")).toMatchObject({
      defaultValue: 3000,
    });
    expect(body.budgets.every((b) => b.value > 0)).toBe(true);
  });
});

describe("PUT /", () => {
  it("refuses a non-admin, and writes nothing", async () => {
    const { router, writes } = harness({ admin: false });
    const res = await router.request(
      "/",
      put({ RATE_LIMIT_CRUD_MAX: 3000 })
    );
    expect(res.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it("refuses an unknown key, zero, a fraction and a huge value", async () => {
    const { router } = harness({ admin: true });
    for (const values of [
      { RATE_LIMIT_NOPE: 10 },
      { RATE_LIMIT_CRUD_MAX: 0 },
      { RATE_LIMIT_CRUD_MAX: 1.5 },
      { RATE_LIMIT_CRUD_MAX: 2_000_000_000 },
      {},
    ]) {
      expect((await router.request("/", put(values))).status).toBe(400);
    }
  });

  it("a failed read of the stored values is a 503, never an overwrite", async () => {
    const { router, writes } = harness({ admin: true, readFails: true });
    const res = await router.request(
      "/",
      put({ RATE_LIMIT_CRUD_MAX: 3000 })
    );
    expect(res.status).toBe(503);
    expect(writes).toEqual([]);
  });

  it("merges into the stored values; null clears one", async () => {
    const { router, writes, audits } = harness({
      admin: true,
      stored: { RATE_LIMIT_CRUD_MAX: 900, RATE_LIMIT_IMPORT_MAX: 50 },
    });
    const res = await router.request(
      "/",
      put({ RATE_LIMIT_CRUD_READ_MAX: 6000, RATE_LIMIT_IMPORT_MAX: null })
    );
    expect(res.status).toBe(200);
    expect(writes).toEqual([
      { RATE_LIMIT_CRUD_MAX: 900, RATE_LIMIT_CRUD_READ_MAX: 6000 },
    ]);
    expect(audits).toEqual(["pod_rate_limits.changed"]);
    const body = (await res.json()) as { budgets: RateLimitBudgetView[] };
    expect(budgetOf(body.budgets, "RATE_LIMIT_CRUD_READ_MAX")).toMatchObject(
      { value: 6000, source: "pod" }
    );
    expect(budgetOf(body.budgets, "RATE_LIMIT_IMPORT_MAX")).toMatchObject({
      source: process.env.RATE_LIMIT_IMPORT_MAX ? "env" : "default",
    });
  });
});

describe("a budget set here is enforced on the next request", () => {
  it("lowers an agent key's write budget live, then clears it", async () => {
    const { router } = harness({ admin: true });
    const edge = new Hono();
    edge.use("*", rateLimitMiddleware);
    edge.post("/api/hub/*", (c) => c.json({ ok: true }));
    const key = `Bearer ${"synap_hub_live_budget_key_".padEnd(48, "y")}`;
    const write = () =>
      edge.request("/api/hub/entities", {
        method: "POST",
        headers: { authorization: key },
      });

    expect(
      (await router.request("/", put({ RATE_LIMIT_CRUD_MAX: 2 }))).status
    ).toBe(200);
    expect((await write()).status).toBe(200);
    expect((await write()).status).toBe(200);
    const limited = await write();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ class: "crud", limit: 2 });

    // Cleared: back to the default, with the bucket started afresh.
    expect(
      (await router.request("/", put({ RATE_LIMIT_CRUD_MAX: null }))).status
    ).toBe(200);
    expect((await write()).status).toBe(200);
  });
});

describe("parseRateLimitsPatch", () => {
  it("takes known keys with a positive integer or null", () => {
    expect(
      parseRateLimitsPatch({
        values: { RATE_LIMIT_CRUD_MAX: 10, RATE_LIMIT_AI_MAX: null },
      })
    ).toEqual({ RATE_LIMIT_CRUD_MAX: 10, RATE_LIMIT_AI_MAX: null });
    expect(parseRateLimitsPatch({ values: [] })).toBeNull();
    expect(parseRateLimitsPatch(null)).toBeNull();
  });
});
