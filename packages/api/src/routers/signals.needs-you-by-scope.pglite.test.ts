/**
 * `countNeedsYouByScope` — the homes' ONE needs-you read — against real SQL
 * (PGlite, every table) through the REAL signals read:
 *
 *  - SAMENESS: every scope it answers (the floor, each space, each
 *    (space, kind)) equals what `signals.count` answers for that scope on
 *    its own — proposals clustered per workspace and per kind, owed slots,
 *    review sessions and notifications, each narrowed in its own half;
 *  - a space the caller cannot read proposals in is null, as its own count
 *    throws there;
 *  - RATCHET: it makes ONE attention read (counted at the owed half —
 *    `listOwedSlots({ needsYouLens })` — which every attention read calls
 *    exactly once). The per-scope way it replaces
 *    made 1 + spaces + (space, kind) pairs.
 *
 * Stubbed: `listSessionsAwaitingReview` — replaced by a fixture population
 * that still narrows through the REAL lens predicates (workspace equality,
 * `sessionSubjectWhere`), so the review half is attributed, not assumed.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
  owedReads: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { is } = await import("drizzle-orm");
  const { PgTable } = await import("drizzle-orm/pg-core");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const tables = Object.entries(actual).filter(([, v]) => is(v, PgTable));
  h.tables = tables.map(([, v]) => v);
  const pg = drizzle(client, { schema: Object.fromEntries(tables) as never });
  return { ...actual, db: pg, getDb: async () => pg };
});

vi.mock(
  "../services/focus-sessions/owed-outputs.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../services/focus-sessions/owed-outputs.js")
      >();
    return {
      ...actual,
      listOwedSlots: async (
        ...args: Parameters<typeof actual.listOwedSlots>
      ) => {
        // The owed HALF (the needs-you lens, `listNeedsYouOwed`) — once per
        // attention read; the draft half reads owed slots too, with `onlyDrafts`.
        if ((args[0] as { needsYouLens?: boolean }).needsYouLens)
          h.owedReads += 1;
        return actual.listOwedSlots(...args);
      },
    };
  }
);

vi.mock("../services/projects/project-needs-you.js", async () => {
  const db = await import("@synap/database");
  const { sessionSubjectWhere } =
    await import("../services/focus-sessions/session-subject-where.js");
  return {
    listSessionsAwaitingReview: async (q: {
      workspaceId?: string | null;
      subject?: Parameters<typeof sessionSubjectWhere>[0];
    }) => {
      const fs = db.focusSessions;
      const rows = await (db.db as typeof db.db)
        .select({ id: fs.id, workspaceId: fs.workspaceId, title: fs.title })
        .from(fs)
        .where(
          db.and(
            db.drizzleSql`${fs.metadata}->>'awaitingReview' = 'true'`,
            // The real read's three-state lens (`sessionScopeConditions`):
            // a space, null = pod-wide only, undefined = the floor.
            ...(typeof q.workspaceId === "string"
              ? [db.eq(fs.workspaceId, q.workspaceId)]
              : q.workspaceId === null
                ? [db.isNull(fs.workspaceId)]
                : []),
            ...(q.subject ? [sessionSubjectWhere(q.subject)] : [])
          )
        );
      return {
        sessions: rows.map((r) => ({
          id: r.id,
          title: r.title ?? null,
          goal: null,
          updatedAt: new Date(),
          workspaceId: r.workspaceId ?? null,
          projectId: null,
          trackId: null,
        })),
        truncated: false,
      };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { signalsRouter, countNeedsYouByScope } from "./signals.js";

const USER = "user-1";
const DEAL = randomUUID();
const W1 = randomUUID();
const W2 = randomUUID();
const W3 = randomUUID(); // viewer only: proposals unreadable
const D1 = randomUUID();
const D2 = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def = [
      "created_at",
      "updated_at",
      "timestamp",
      "started_at",
    ].includes(c.name)
      ? " default now()"
      : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const ctx = {
  db: null,
  authenticated: true,
  userId: USER,
  workspaceId: null,
} as never;

async function proposal(o: {
  ws: string;
  type: string;
  targetId?: string;
  data?: Record<string, unknown>;
}) {
  await q(
    `insert into proposals (id, created_by, workspace_id, proposal_type, target_type, target_id, data, status, created_at, updated_at)
     values (gen_random_uuid(),$1,$2,$3,'entity',$4,$5::jsonb,'pending',now(),now())`,
    [USER, o.ws, o.type, o.targetId ?? null, JSON.stringify(o.data ?? {})]
  );
}

async function session(o: {
  ws: string;
  subject?: string;
  owes?: boolean;
  review?: boolean;
}) {
  const slots = o.owes
    ? [
        {
          kind: "document",
          label: "Sign-off",
          status: "pending",
          owner: "human",
          blockedReason: "needs_human",
          owedSince: new Date().toISOString(),
        },
      ]
    : [];
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, origin, subject_entity_id, expected_outputs, metadata, created_at, started_at, updated_at)
     values (gen_random_uuid(),$1,$2,'g','active','human',$3,$4::jsonb,$5::jsonb,now(),now(),now())`,
    [
      USER,
      o.ws,
      o.subject ?? null,
      JSON.stringify(slots),
      JSON.stringify(o.review ? { awaitingReview: "true" } : {}),
    ]
  );
}

const SCOPES = {
  spaces: [
    { workspaceId: W1, profileSlugs: ["deal"] },
    { workspaceId: W2, profileSlugs: ["deal"] },
    { workspaceId: W3, profileSlugs: ["deal"] },
  ],
};

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(
    `insert into users (id, name, email, user_type) values ($1,'Me','me@x.io','human')`,
    [USER]
  );
  for (const [ws, role] of [
    [W1, "owner"],
    [W2, "editor"],
    [W3, "viewer"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, `ws-${role}`, USER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(),$1,$2,$3)`,
      [ws, USER, role]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope, is_active) values ($1,'deal','Deal','kind','workspace',true)`,
    [DEAL]
  );
  for (const [id, ws] of [
    [D1, W1],
    [D2, W2],
  ])
    await q(
      `insert into entities (id, user_id, workspace_id, type, profile_id, title, properties, created_at) values ($1,$2,$3,'deal',$4,'Deal','{}'::jsonb,now())`,
      [id, USER, ws, DEAL]
    );
  const other = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties, created_at) values ($1,$2,$3,'note','Note','{}'::jsonb,now())`,
    [other, USER, W1]
  );

  // Proposals: W1 — one on a deal, one on a note; W2 — creating a deal;
  // W3 — one the viewer cannot read there.
  await proposal({ ws: W1, type: "update", targetId: D1 });
  await proposal({ ws: W1, type: "update", targetId: other });
  await proposal({ ws: W2, type: "create", data: { profileSlug: "deal" } });
  await proposal({ ws: W3, type: "update", targetId: randomUUID() });
  // Owed: W1 on a deal, W2 on nothing. Review: W1 on a deal, W2 on nothing.
  await session({ ws: W1, subject: D1, owes: true });
  await session({ ws: W2, owes: true });
  await session({ ws: W1, subject: D1, review: true });
  await session({ ws: W2, review: true });
  // Unread notifications in W1 and W2.
  // Distinct titles: the same news in two spaces would fold into one row.
  for (const ws of [W1, W2])
    await q(
      `insert into notifications (id, user_id, workspace_id, type, category, title, status, created_at) values (gen_random_uuid(),$1,$2,'custom.note','inbox',$3,'unread',now())`,
      [USER, ws, `Heads up ${ws.slice(0, 4)}`]
    );
});

async function perScopeCount(scope: Record<string, unknown>) {
  try {
    return (await signalsRouter.createCaller(ctx).count(scope as never))
      .needsYou;
  } catch {
    return null;
  }
}

describe("countNeedsYouByScope", () => {
  it("answers every scope exactly as signals.count does on its own", async () => {
    const grouped = await countNeedsYouByScope(ctx, SCOPES);
    expect(grouped.total).toBe(await perScopeCount({}));
    for (const s of SCOPES.spaces) {
      expect(grouped.bySpace.get(s.workspaceId), s.workspaceId).toBe(
        await perScopeCount({ workspaceId: s.workspaceId })
      );
      expect(grouped.byKind.get(s.workspaceId)!.get("deal")).toBe(
        await perScopeCount({ workspaceId: s.workspaceId, profileSlug: "deal" })
      );
    }
    // Non-vacuity: the scopes disagree, so a wrong narrowing cannot pass.
    expect(grouped.bySpace.get(W1)).toBeGreaterThan(0);
    expect(grouped.byKind.get(W1)!.get("deal")).toBeGreaterThan(0);
    expect(grouped.byKind.get(W1)!.get("deal")).toBeLessThan(
      grouped.bySpace.get(W1)!
    );
    expect(grouped.byKind.get(W2)!.get("deal")).toBeGreaterThan(0);
    expect(grouped.total).toBeGreaterThan(grouped.bySpace.get(W1)!);
    // Each space's own notification is counted (non-vacuity of that half).
    const parts = await signalsRouter
      .createCaller(ctx)
      .count({ workspaceId: W2 } as never);
    expect(parts.notifications).toBe(1);
    // The viewer space: unreadable proposals → null, never a number.
    expect(grouped.bySpace.get(W3)).toBeNull();
    expect(grouped.byKind.get(W3)!.get("deal")).toBeNull();
  });

  it("RATCHET: one attention read for the whole page", async () => {
    h.owedReads = 0;
    const grouped = await countNeedsYouByScope(ctx, SCOPES);
    expect(grouped.attentionReads).toBe(1);
    expect(h.owedReads).toBe(1);
  });

  it("the per-scope way it replaces: 1 + spaces + (space, kind) reads", async () => {
    h.owedReads = 0;
    await perScopeCount({});
    for (const s of SCOPES.spaces) {
      await perScopeCount({ workspaceId: s.workspaceId });
      await perScopeCount({ workspaceId: s.workspaceId, profileSlug: "deal" });
    }
    // The counter measures what it claims (non-vacuity of the ratchet).
    expect(h.owedReads).toBe(1 + 3 + 3);
  });
  it("podLevel (homes X3): the needs-you in NO space — equals signals.count's pod-only lens", async () => {
    // Pod-level rows: a proposal, an owed slot and a notification with no space.
    await q(
      `insert into proposals (id, created_by, workspace_id, proposal_type, target_type, target_id, data, status, created_at, updated_at)
       values (gen_random_uuid(),$1,NULL,'update','entity',$2,'{}'::jsonb,'pending',now(),now())`,
      [USER, randomUUID()]
    );
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, status, origin, expected_outputs, metadata, created_at, started_at, updated_at)
       values (gen_random_uuid(),$1,NULL,'g','active','human',$2::jsonb,'{}'::jsonb,now(),now(),now())`,
      [
        USER,
        JSON.stringify([
          {
            kind: "document",
            label: "Pod sign-off",
            status: "pending",
            owner: "human",
            blockedReason: "needs_human",
            owedSince: new Date().toISOString(),
          },
        ]),
      ]
    );
    await q(
      `insert into notifications (id, user_id, workspace_id, type, category, title, status, created_at) values (gen_random_uuid(),$1,NULL,'custom.note','inbox','Pod heads up','unread',now())`,
      [USER]
    );
    const grouped = await countNeedsYouByScope(ctx, SCOPES);
    // Unfinished captures live in no space; the fixture has none, so the
    // pod-only lens is the whole of it here.
    expect(grouped.podLevel).toBe(await perScopeCount({ workspaceId: null }));
    expect(grouped.podLevel).toBeGreaterThanOrEqual(2); // non-vacuity
    // Still the floor's total, and the spaces are untouched by pod rows.
    expect(grouped.total).toBe(await perScopeCount({}));
    expect(grouped.bySpace.get(W1)).toBe(
      await perScopeCount({ workspaceId: W1 })
    );
  });

  // LAST: it fills a scan cap for every test after it.
  it("a capped read says so: `truncated` is signals.count's own floor flag", async () => {
    const before = await countNeedsYouByScope(ctx, SCOPES);
    // Uncapped: the floor flag is a measured false, not an absent one.
    expect(before.truncated).toBe(false);
    expect(before.bySpaceTruncated.get(W1)).toBe(false);
    expect(before.byKindTruncated.get(W1)!.get("deal")).toBe(false);
    expect(before.podLevelTruncated).toBe(false);
    // Fill the notification scan cap (100) in W1 — distinct titles, so the
    // fold cannot shrink them below it.
    await q(
      `insert into notifications (id, user_id, workspace_id, type, category, title, status, created_at)
       select gen_random_uuid(),$1,$2,'custom.note','inbox','Capped '||g,'unread',now()
       from generate_series(1,100) g`,
      [USER, W1]
    );
    const own = await signalsRouter.createCaller(ctx).count({} as never);
    expect(own.truncated).toBe(true); // non-vacuity: the cap was reached
    const grouped = await countNeedsYouByScope(ctx, SCOPES);
    expect(grouped.total).toBe(own.needsYou);
    expect(grouped.truncated).toBe(own.truncated);
    const w1 = await signalsRouter
      .createCaller(ctx)
      .count({ workspaceId: W1 } as never);
    expect(w1.truncated).toBe(true);
    expect(grouped.bySpaceTruncated.get(W1)).toBe(w1.truncated);
    // A space whose count failed has no floor flag either.
    expect(grouped.bySpace.get(W3)).toBeNull();
    expect(grouped.bySpaceTruncated.get(W3)).toBeNull();
    expect(grouped.byKindTruncated.get(W3)!.get("deal")).toBeNull();
    // The per-scope fallback does not measure pod level: no flag either.
    expect(grouped.podLevel).toBeNull();
    expect(grouped.podLevelTruncated).toBeNull();

    // A KIND's count capped: fill the owed-slot scan cap (100) on a deal in
    // W1. Notifications never follow a kind, so before this the kind was
    // uncapped while its space was capped — the flag is per scope.
    expect(grouped.byKindTruncated.get(W1)!.get("deal")).toBe(false);
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, status, origin, subject_entity_id, expected_outputs, metadata, created_at, started_at, updated_at)
       select gen_random_uuid(),$1,$2,'g'||g,'active','human',$3,$4::jsonb,'{}'::jsonb,now(),now(),now()
       from generate_series(1,100) g`,
      [
        USER,
        W1,
        D1,
        JSON.stringify([
          {
            kind: "document",
            label: "Sign-off",
            status: "pending",
            owner: "human",
            blockedReason: "needs_human",
            owedSince: new Date().toISOString(),
          },
        ]),
      ]
    );
    const kind = await signalsRouter
      .createCaller(ctx)
      .count({ workspaceId: W1, profileSlug: "deal" } as never);
    expect(kind.truncated).toBe(true); // non-vacuity: the kind cap was reached
    const capped = await countNeedsYouByScope(ctx, SCOPES);
    expect(capped.byKind.get(W1)!.get("deal")).toBe(kind.needsYou);
    expect(capped.byKindTruncated.get(W1)!.get("deal")).toBe(true);
  });
});
