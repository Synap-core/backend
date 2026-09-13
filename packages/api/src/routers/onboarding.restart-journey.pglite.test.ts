/**
 * `onboarding.restartJourney` driven through the REAL procedure on PGlite:
 * a COMPLETED pod journey restarts to active with empty progress — the
 * transition `startJourney` still refuses.
 *
 * Real: the router, `saveJourney` (advisory lock, row lock, upsert),
 * `assertJourneyTransition`, `restartJourneyProgress`, `mergeJourneyProgress`.
 * Stubbed: `getDb` → a PGlite drizzle over the `onboarding_journeys` table,
 * whose DDL is generated from the Drizzle definition (+ its unique index).
 *
 * NOT covered: workspace/project lenses (their access reads need more tables).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, {
    schema: { onboardingJourneys: actual.onboardingJourneys as never },
  });
  return { ...actual, getDb: async () => h.db };
});

// podProcedure's read-only guard reads `sync_generation` on the real pool; the
// split-brain state is not what this test is about.
vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { onboardingJourneys } from "@synap/database";
import { onboardingRouter } from "./onboarding.js";

const USER = "user-1";
const OTHER = "user-2";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|timestamp|date|varchar)/;

/** A column default derived from the Drizzle definition (the procedure's
 *  inserts rely on them: `id`, `offered_at`, `created_at`). */
function defaultFor(
  c: { hasDefault: boolean; default?: unknown },
  type: string
): string {
  if (!c.hasDefault) return "";
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  if (c.default === undefined) return "";
  const literal =
    typeof c.default === "string" ? c.default : JSON.stringify(c.default);
  return ` default '${literal.replace(/'/g, "''")}'`;
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string) =>
  onboardingRouter.createCaller({ authenticated: true, userId } as never);

const POD = { lens: { kind: "pod" as const } };

async function seedCompleted(userId: string) {
  await q(
    `insert into onboarding_journeys (id, user_id, lens_kind, lens_key, template_version, status, progress, evidence, offered_at, started_at, completed_at, created_at, updated_at)
     values ($1, $2, 'pod', 'pod', '1', 'completed', $3::jsonb, $4::jsonb, now(), '2026-09-01T00:00:00Z', now(), now(), now())`,
    [
      randomUUID(),
      userId,
      JSON.stringify({
        currentActionId: "connect",
        completedActionIds: ["tools", "connect"],
        values: { tools: [{ name: "Notion", key: "notion", state: "wanted" }] },
      }),
      JSON.stringify({
        meaningfulEntityIds: [],
        completedCriteria: ["pod-setup-steps-completed"],
        firstValueAt: "2026-09-02T00:00:00.000Z",
      }),
    ]
  );
}

async function rowOf(userId: string) {
  const { rows } = await q<{
    status: string;
    progress: Record<string, unknown>;
    evidence: Record<string, unknown>;
    started_at: Date | null;
    completed_at: Date | null;
  }>(
    `select status, progress, evidence, started_at, completed_at from onboarding_journeys where user_id = $1`,
    [userId]
  );
  return rows;
}

describe("onboarding.restartJourney (real procedure, PGlite)", () => {
  beforeAll(async () => {
    await h.client!.exec(ddlFor(onboardingJourneys as unknown as PgTable));
    await h.client!.exec(
      `create unique index onboarding_journeys_user_lens_version_unique on onboarding_journeys (user_id, lens_key, template_version);`
    );
  });

  beforeEach(async () => {
    await h.client!.exec(`delete from onboarding_journeys;`);
  });

  it("completed → restart → active with empty progress, values and history kept", async () => {
    await seedCompleted(USER);

    const journey = await caller(USER).restartJourney({
      ...POD,
      firstActionId: "tools",
    });

    expect(journey).toMatchObject({
      status: "active",
      completedAt: null,
      progress: {
        currentActionId: "tools",
        completedActionIds: [],
        values: { tools: [{ name: "Notion", key: "notion", state: "wanted" }] },
      },
      evidence: {
        restarts: 1,
        completedCriteria: ["pod-setup-steps-completed"],
      },
    });
    expect(
      typeof (journey!.evidence as { restartedAt?: unknown }).restartedAt
    ).toBe("string");
    // History: the original start is kept.
    expect(journey!.startedAt).toBe("2026-09-01T00:00:00.000Z");

    const [row] = await rowOf(USER);
    expect(row!.status).toBe("active");
    expect(row!.completed_at).toBeNull();
    expect(
      (row!.progress as { completedActionIds: string[] }).completedActionIds
    ).toEqual([]);
  });

  it("startJourney still cannot move a completed journey (restart is its own door)", async () => {
    await seedCompleted(USER);
    await expect(caller(USER).startJourney(POD)).rejects.toThrow("cannot move");
    expect((await rowOf(USER))[0]!.status).toBe("completed");
  });

  it("counts every restart", async () => {
    await seedCompleted(USER);
    await caller(USER).restartJourney(POD);
    const second = await caller(USER).restartJourney(POD);
    expect((second!.evidence as { restarts?: number }).restarts).toBe(2);
    expect(second!.progress.currentActionId).toBeUndefined();
  });

  it("is owner-floored: another user's restart never touches this journey", async () => {
    await seedCompleted(USER);
    await caller(OTHER).restartJourney(POD);
    expect((await rowOf(USER))[0]!.status).toBe("completed");
    expect((await rowOf(OTHER))[0]!.status).toBe("active");
  });
});
