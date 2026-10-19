/**
 * `onboarding.recordValues` — the STATUS-NEUTRAL values door — driven through
 * the REAL procedure on PGlite. It merges `progress.values` one level deep and
 * never moves the journey: for EVERY status, status / current step / completed
 * steps / evidence / timestamps are equal before and after. An absent journey
 * is created `offered` (the table default), never started.
 *
 * The discriminator is the per-status table: a door that delegated to any
 * status-moving write (start / pause / complete / restart) changes the status
 * or a timestamp of at least one row.
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

const STATUSES = [
  "offered",
  "active",
  "paused",
  "completed",
  "dismissed",
] as const;

async function seed(userId: string, status: string) {
  await q(
    `insert into onboarding_journeys (id, user_id, lens_kind, lens_key, template_version, status, progress, evidence, offered_at, started_at, paused_at, completed_at, dismissed_at, created_at, updated_at)
     values ($1, $2, 'pod', 'pod', '1', $3, $4::jsonb, $5::jsonb, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z',
       $6, $7, $8, now(), now())`,
    [
      randomUUID(),
      userId,
      status,
      JSON.stringify({
        currentActionId: "connect",
        completedActionIds: ["tools"],
        values: {
          tools: [{ name: "Notion" }],
          firstRun: { focus: "old", kept: true },
        },
      }),
      JSON.stringify({
        meaningfulEntityIds: [],
        completedCriteria: ["pod-setup-steps-completed"],
      }),
      status === "paused" ? "2026-09-03T00:00:00Z" : null,
      status === "completed" ? "2026-09-04T00:00:00Z" : null,
      status === "dismissed" ? "2026-09-05T00:00:00Z" : null,
    ]
  );
}

async function rowOf(userId: string) {
  const { rows } = await q<Record<string, unknown>>(
    `select status, progress, evidence, offered_at, started_at, paused_at, completed_at, dismissed_at from onboarding_journeys where user_id = $1`,
    [userId]
  );
  return rows;
}

describe("onboarding.recordValues (real procedure, PGlite)", () => {
  beforeAll(async () => {
    await h.client!.exec(ddlFor(onboardingJourneys as unknown as PgTable));
    await h.client!.exec(
      `create unique index onboarding_journeys_user_lens_version_unique on onboarding_journeys (user_id, lens_key, template_version);`
    );
  });

  beforeEach(async () => {
    await h.client!.exec(`delete from onboarding_journeys;`);
  });

  it.each(STATUSES)(
    "a %s journey keeps its status, step, evidence and timestamps",
    async (status) => {
      await seed(USER, status);
      const [before] = await rowOf(USER);

      const journey = await caller(USER).recordValues({
        ...POD,
        values: {
          firstRun: { focus: "launch a newsletter" },
          dayOneSeen: true,
        },
      });

      const [after] = await rowOf(USER);
      expect(journey!.status).toBe(status);
      const { progress: pBefore, ...restBefore } = before!;
      const { progress: pAfter, ...restAfter } = after!;
      expect(restAfter).toEqual(restBefore); // status, evidence, every timestamp
      expect(pAfter).toEqual({
        currentActionId: "connect",
        completedActionIds: ["tools"],
        // One level deep: `firstRun` is REPLACED (its old `kept` is gone),
        // `tools` is untouched, `dayOneSeen` is added.
        values: {
          tools: [{ name: "Notion" }],
          firstRun: { focus: "launch a newsletter" },
          dayOneSeen: true,
        },
      });
      expect(pBefore).not.toEqual(pAfter); // non-vacuity: it did write
    }
  );

  it("no journey yet → one is created OFFERED (not started), holding the values", async () => {
    const journey = await caller(USER).recordValues({
      ...POD,
      values: { firstRun: { focus: "x" } },
    });
    expect(journey).toMatchObject({
      status: "offered",
      startedAt: null,
      progress: {
        completedActionIds: [],
        values: { firstRun: { focus: "x" } },
      },
    });
    expect(await rowOf(USER)).toHaveLength(1);
  });

  it("an empty values object is refused", async () => {
    await expect(
      caller(USER).recordValues({ ...POD, values: {} })
    ).rejects.toThrow();
  });

  it("is owner-floored: another user's values never touch this journey", async () => {
    await seed(USER, "completed");
    const [before] = await rowOf(USER);
    await caller(OTHER).recordValues({ ...POD, values: { dayOneSeen: true } });
    expect((await rowOf(USER))[0]).toEqual(before);
    expect((await rowOf(OTHER))[0]!.status).toBe("offered");
  });
});
