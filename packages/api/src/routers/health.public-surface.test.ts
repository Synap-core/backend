/**
 * `health.*`: what an anonymous caller may read (audit pod-routers F12,
 * pod-doors F4), through the REAL procedures and their REAL floors.
 *
 * Before the fix every procedure was `publicProcedure`: anyone read the pod's
 * events per day and entity count (`metrics`), the migration ledger
 * (`migrations`), and from `ready` the failed-job counts, the embedding
 * pipeline, the catalog sync sources and a raw database error message.
 *
 * The `/trpc` session gate is the first wall (`apps/api/src/trpc-session-gate
 * .test.ts`); this file proves the second one, the procedure floor.
 *
 * Real: publicProcedure / protectedProcedure / podAdminProcedure, the router.
 * Stubbed: the database (`sql`, `db.execute`, the catalog stamps), pg-boss,
 * and the pod-admin predicate (`isPodAdmin`: ADMIN is one, MEMBER is not).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  dbDown: false,
  executes: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const sql = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (h.dbDown) {
      return Promise.reject(new Error("connect ECONNREFUSED 10.0.0.9:5432"));
    }
    if (text.includes("as healthy")) return Promise.resolve([{ healthy: 1 }]);
    if (text.includes("__drizzle_migrations")) {
      return Promise.resolve([
        { id: 1, hash: "abc", created_at: "2026-10-01" },
      ]);
    }
    return Promise.resolve([{ count: 6815 }]);
  };
  const db = {
    execute: async () => {
      h.executes++;
      return [{ failed: 3, past_due: 0, last: null }];
    },
  };
  return {
    ...actual,
    sql,
    db,
    getCatalogSyncStamps: async () => ({
      "https://cp.example::workspace": { lastStatus: "ok" },
    }),
  };
});
vi.mock("@synap/jobs", () => ({ getBoss: () => ({}) }));
vi.mock("../utils/workspace-role.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isPodAdmin: vi.fn(async (userId: string) => userId === "admin"),
  };
});

import { healthRouter } from "./health.js";

const anonymous = () =>
  healthRouter.createCaller({ authenticated: false } as never);
const signedIn = (userId: "admin" | "member") =>
  healthRouter.createCaller({ authenticated: true, userId } as never);

beforeEach(() => {
  h.dbDown = false;
  h.executes = 0;
});

describe("health: anonymous callers", () => {
  it("alive answers", async () => {
    expect((await anonymous().alive()).status).toBe("ok");
  });

  it("ready says ready/degraded and the hard checks, nothing more", async () => {
    const ready = await anonymous().ready();
    expect(Object.keys(ready).sort()).toEqual([
      "checks",
      "status",
      "timestamp",
    ]);
    expect(ready.status).toBe("ready");
    // It reads no soft signal: the pgboss / entity_vectors scans are not run
    // for an anonymous probe.
    expect(h.executes).toBe(0);
  });

  it("ready never echoes a database error to an anonymous caller", async () => {
    h.dbDown = true;
    const ready = await anonymous().ready();
    expect(ready.status).toBe("degraded");
    expect(ready.checks.database).toBe("unhealthy");
    expect(JSON.stringify(ready)).not.toContain("ECONNREFUSED");
  });

  it("metrics, migrations and readyDetails are refused", async () => {
    await expect(anonymous().metrics()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(anonymous().migrations()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(anonymous().readyDetails()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("health: signed-in callers", () => {
  it("a pod user reads metrics (the browser's pod health widget)", async () => {
    const metrics = await signedIn("member").metrics();
    expect(metrics.totalEntities).toBe(6815);
  });

  it("a pod user who is not an admin cannot read the internals", async () => {
    await expect(signedIn("member").migrations()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(signedIn("member").readyDetails()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("a pod admin reads the full readiness and the migration ledger", async () => {
    h.dbDown = true;
    const details = await signedIn("admin").readyDetails();
    expect(details.signals.jobQueue).toEqual({ failed: 3, pastDue: 0 });
    expect(details.signals.catalogSync).toHaveProperty(
      "https://cp.example::workspace"
    );
    expect(details.details.database).toContain("ECONNREFUSED");
    h.dbDown = false;
    expect((await signedIn("admin").migrations()).total).toBe(1);
  });
});
