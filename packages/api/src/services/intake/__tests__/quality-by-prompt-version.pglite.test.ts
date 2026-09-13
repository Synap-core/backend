/**
 * Quality per prompt version — through the REAL diagnose door, and the
 * regression notifier through the REAL notification store, on PGlite.
 *
 * Real: `diagnoseRouter({ userId })` → `diagnoseGlobal` → every signal it
 * gathers (all tables generated from the Drizzle schema) →
 * `readQualityByPromptVersionSignal` → `gatherQualityByPromptVersion` (the
 * `metadata -> 'run'` filter, the owner floor, the `session_id` join) →
 * `summarizeQualityByPromptVersion`. And `notifyPromptVersionRegressions` →
 * `resolvePodAdminUserIds` → `NotificationService.create` → the persisted row.
 *
 * Stubbed, and why:
 *  - `emitSideEffects` / `eventRepository.append` — automation + audit fan-out
 *    on their own connections.
 *  - `emitChatEvent` / `sendExpoPush` — Socket.IO bridge and a third-party hop.
 *  - `gatherQualityByPromptVersion` is WRAPPED (importOriginal) with a toggle
 *    that throws, to prove an unavailable read is marked, not zeroed.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  failQuality: false,
  truncateSessions: false,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, { schema: schema as never }),
    eventRepository: {
      ...(actual.eventRepository as object),
      append: async () => undefined,
    },
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock(
  "../../../utils/chat-realtime-broadcast.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    emitChatEvent: () => undefined,
  })
);
vi.mock("../../../notifications/expo-push.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendExpoPush: async () => undefined,
}));
vi.mock("../quality-by-prompt-version.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../quality-by-prompt-version.js")>();
  return {
    ...actual,
    gatherQualityByPromptVersion: async (
      ...args: Parameters<typeof actual.gatherQualityByPromptVersion>
    ) => {
      if (h.failQuality) throw new Error("simulated read failure");
      const report = await actual.gatherQualityByPromptVersion(...args);
      // Hitting the real 2000-session cap on PGlite is too slow; mark the REAL
      // report (regressions still computed from real rows) as capped instead.
      return h.truncateSessions
        ? { ...report, truncated: { ...report.truncated, sessions: true } }
        : report;
    },
  };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { diagnoseRouter } from "../../diagnose/index.js";
import {
  detectPromptVersionRegressions,
  MIN_DECIDED_PER_VERSION,
  type PromptVersionQuality,
} from "../quality-by-prompt-version.js";
import { notifyPromptVersionRegressions } from "../prompt-version-regression.js";

const USER = "user-1";
const OTHER = "user-2";
const ADMIN = "admin-1";
const DAY = 24 * 60 * 60 * 1000;

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (type === "jsonb" && d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  const name = cfg.schema ? `"${cfg.schema}"."${cfg.name}"` : `"${cfg.name}"`;
  const pre = cfg.schema ? `create schema if not exists "${cfg.schema}"; ` : "";
  return `${pre}create table if not exists ${name} (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function run(opts: {
  owner: string;
  promptVersion: string;
  daysAgo: number;
  model?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, created_at, updated_at)
     values ($1, $2, 'Capture', 'closed', $3::jsonb, $4, $4)`,
    [
      id,
      opts.owner,
      JSON.stringify({
        run: {
          version: 1,
          sourceDocumentIds: [],
          guidelines: [],
          engine: "structure",
          model: opts.model ?? "deepseek-chat",
          promptVersion: opts.promptVersion,
          updatedAt: "t",
        },
      }),
      new Date(Date.now() - opts.daysAgo * DAY),
    ]
  );
  return id;
}

async function proposal(
  sessionId: string,
  status: string,
  extra: { reasonCode?: string; data?: unknown } = {}
) {
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data,
       created_by, session_id, reason_code, created_at, updated_at)
     values ($1, $2, 'graph', 'capture', $3, $4::jsonb, $5, $6, $7, now(), now())`,
    [
      randomUUID(),
      status,
      randomUUID(),
      JSON.stringify(extra.data ?? {}),
      USER,
      sessionId,
      extra.reasonCode ?? null,
    ]
  );
}

async function many(sessionId: string, status: string, n: number) {
  for (let i = 0; i < n; i++) await proposal(sessionId, status);
}

type Section = { key: string; status: string; headline: string; detail: any };
async function qualitySection(): Promise<Section | undefined> {
  const report = (await diagnoseRouter({ userId: USER })) as {
    sections: Section[];
  };
  return report.sections.find((s) => s.key === "quality_by_prompt_version");
}

beforeAll(async () => {
  for (const v of Object.values(schema)) {
    if (is(v, PgTable)) await h.client!.exec(ddlFor(v));
  }
  const ws = randomUUID();
  await q(
    `insert into workspaces (id, name, system_slug) values ($1, 'Pod admin', 'pod-admin')`,
    [ws]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), ws, ADMIN]
  );
});

beforeEach(async () => {
  h.failQuality = false;
  await h.client!.exec(
    "delete from proposals; delete from focus_sessions; delete from notifications;"
  );
});

describe("diagnose: quality_by_prompt_version", () => {
  it("groups the caller's intake runs by prompt version with review outcomes", async () => {
    const v1 = await run({
      owner: USER,
      promptVersion: "structure:v1",
      daysAgo: 10,
    });
    await many(v1, "approved", 3);
    await proposal(v1, "rejected", { reasonCode: "bad_data" });

    const v2 = await run({
      owner: USER,
      promptVersion: "structure:v2",
      daysAgo: 2,
    });
    await proposal(v2, "approved", {
      data: { dispositions: { a: { status: "reject" } } },
    });
    await proposal(v2, "rejected", { reasonCode: "bad_data" });
    await proposal(v2, "rejected");
    await proposal(v2, "pending");
    await proposal(v2, "auto_approved");

    // Another user's run — outside the owner floor.
    const foreign = await run({
      owner: OTHER,
      promptVersion: "structure:v2",
      daysAgo: 1,
    });
    await many(foreign, "rejected", 5);
    // A session without a run manifest is not an intake run.
    await q(
      `insert into focus_sessions (id, user_id, goal, status, metadata, created_at, updated_at)
       values ($1, $2, 'Plain', 'active', '{}'::jsonb, now(), now())`,
      [randomUUID(), USER]
    );

    const section = await qualitySection();
    expect(section?.status).toBe("ok");
    expect(section?.detail.available).toBe(true);
    expect(section?.detail.runs).toBe(2);
    const groups = section!.detail.groups as PromptVersionQuality[];
    expect(groups.map((g) => g.promptVersion)).toEqual([
      "structure:v1",
      "structure:v2",
    ]);
    expect(groups[0]).toMatchObject({
      runs: 1,
      decided: 4,
      rejectRate: 0.25,
      reasonedRejectRate: 1,
      proposals: { approved: 3, rejected: 1, pending: 0 },
    });
    expect(groups[1]).toMatchObject({
      runs: 1,
      decided: 3,
      rejectRate: 0.6667,
      reasonedRejects: 1,
      reasonedRejectRate: 0.5,
      itemsDenied: 1,
      proposals: {
        total: 5,
        approved: 0,
        partiallyApproved: 1,
        rejected: 2,
        pending: 1,
        autoApproved: 1,
      },
    });
    expect(section!.detail.regressions).toEqual([]);
  });

  it("an unreadable signal is marked unavailable, never reported as no runs", async () => {
    h.failQuality = true;
    const section = await qualitySection();
    expect(section).toMatchObject({
      status: "attention",
      detail: { available: false, error: "simulated read failure" },
    });
  });
});

describe("prompt-version regression: threshold both sides", () => {
  const g = (
    promptVersion: string,
    firstSeenAt: string,
    decided: number,
    rejectRate: number,
    model = "m"
  ): PromptVersionQuality =>
    ({
      promptVersion,
      engine: "structure",
      model,
      firstSeenAt,
      decided,
      rejectRate,
    }) as PromptVersionQuality;

  it("fires at the delta and minimum sample, not below either", () => {
    const N = MIN_DECIDED_PER_VERSION;
    expect(
      detectPromptVersionRegressions([
        g("a", "1", N, 0.1),
        g("b", "2", N, 0.25),
      ])
    ).toHaveLength(1);
    // 35% vs 20% is a 15-point delta; in floats 0.35 - 0.2 = 0.1499999…
    expect(
      detectPromptVersionRegressions([
        g("a", "1", N, 0.2),
        g("b", "2", N, 0.35),
      ])
    ).toHaveLength(1);
    expect(
      detectPromptVersionRegressions([
        g("a", "1", N, 0.1),
        g("b", "2", N, 0.24),
      ])
    ).toHaveLength(0);
    expect(
      detectPromptVersionRegressions([
        g("a", "1", N, 0.1),
        g("b", "2", N - 1, 0.9),
      ])
    ).toHaveLength(0);
    // Improvement is not a regression; a model swap is a different line.
    expect(
      detectPromptVersionRegressions([g("a", "1", N, 0.5), g("b", "2", N, 0.1)])
    ).toHaveLength(0);
    expect(
      detectPromptVersionRegressions([
        g("a", "1", N, 0.1, "m1"),
        g("b", "2", N, 0.9, "m2"),
      ])
    ).toHaveLength(0);
    expect(
      detectPromptVersionRegressions([
        g("a", "1", N, 0.1),
        g("unknown", "2", N, 0.9),
      ])
    ).toHaveLength(0);
  });

  it("notifies the pod admin once for a clear regression, and not below the threshold", async () => {
    const v1 = await run({
      owner: USER,
      promptVersion: "structure:v1",
      daysAgo: 10,
    });
    await many(v1, "approved", 23);
    await many(v1, "rejected", 2);
    const v2 = await run({
      owner: USER,
      promptVersion: "structure:v2",
      daysAgo: 2,
    });
    await many(v2, "approved", 15);
    await many(v2, "rejected", 10);

    const first = await notifyPromptVersionRegressions();
    expect(first).toEqual({ regressions: 1, notified: 1, recipients: 1 });
    const second = await notifyPromptVersionRegressions();
    expect(second).toMatchObject({ regressions: 1, notified: 0 });
    const { rows } = await q<{ user_id: string; title: string }>(
      `select user_id, title from notifications where type = 'intake.prompt_version_regression'`
    );
    expect(rows).toEqual([
      { user_id: ADMIN, title: "Prompt structure:v2 is rejected more often" },
    ]);

    // The diagnose section reads the same regression.
    expect((await qualitySection())?.status).toBe("attention");
  });

  it("stays silent when the newer version is worse by less than the threshold", async () => {
    const v1 = await run({
      owner: USER,
      promptVersion: "structure:v1",
      daysAgo: 10,
    });
    await many(v1, "approved", 23);
    await many(v1, "rejected", 2);
    const v2 = await run({
      owner: USER,
      promptVersion: "structure:v2",
      daysAgo: 2,
    });
    await many(v2, "approved", 20);
    await many(v2, "rejected", 5);

    expect(await notifyPromptVersionRegressions()).toEqual({
      regressions: 0,
      notified: 0,
      recipients: 0,
    });
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from notifications`
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("tells no one off a TRUNCATED scan, even when that partial window shows a clear regression", async () => {
    const v1 = await run({
      owner: USER,
      promptVersion: "structure:v1",
      daysAgo: 10,
    });
    await many(v1, "approved", 23);
    await many(v1, "rejected", 2);
    const v2 = await run({
      owner: USER,
      promptVersion: "structure:v2",
      daysAgo: 2,
    });
    await many(v2, "approved", 15);
    await many(v2, "rejected", 10);

    h.truncateSessions = true;
    try {
      // Non-vacuity: the same rows DO read as a regression — only the cap
      // stops the notification.
      expect(await notifyPromptVersionRegressions()).toEqual({
        regressions: 1,
        notified: 0,
        recipients: 0,
        skipped: "truncated",
      });
    } finally {
      h.truncateSessions = false;
    }
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from notifications`
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("diagnose says PARTIAL WINDOW and claims no regression off a truncated scan", async () => {
    const v1 = await run({
      owner: USER,
      promptVersion: "structure:v1",
      daysAgo: 10,
    });
    await many(v1, "approved", 23);
    await many(v1, "rejected", 2);
    const v2 = await run({
      owner: USER,
      promptVersion: "structure:v2",
      daysAgo: 2,
    });
    await many(v2, "approved", 15);
    await many(v2, "rejected", 10);

    h.truncateSessions = true;
    try {
      const section = await qualitySection();
      expect(section?.status).toBe("attention");
      expect(section?.headline).toMatch(/^Partial window/);
      expect(section?.headline).not.toMatch(/is rejected/);
      expect(section?.detail.regressions).toEqual([]);
      // Non-vacuity: the partial rows DID read as a regression.
      expect(section?.detail.unverifiedRegressions).toHaveLength(1);
    } finally {
      h.truncateSessions = false;
    }
  });
});
