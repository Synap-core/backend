/**
 * The INTENT lens (`signals.*({ profileSlug })`, surfaces W1.2) on PGlite —
 * "what needs me ON Leads", driven through the REAL router with the REAL
 * `proposals.groups` (so `proposalOnThingsWhere` runs as SQL), the real owed
 * read (`sessionSubjectWhere`) and the real notification door.
 *
 * Stubbed: `listSessionsAwaitingReview` (its unit facts read a dozen more
 * tables — see `signals.lens-page.pglite.test.ts`); the stub RECORDS the
 * subject it is handed, so the forwarding is still asserted.
 *
 * Fixture (one user):
 *   lead L1 · note N1
 *   S_L  session on L1, owes a decision
 *   S_N  session on N1, owes a decision
 *   P_TARGET   pending update targeting L1
 *   P_CREATE   pending create carrying profileSlug "lead" (nested envelope)
 *   P_SESSION  pending document create filed inside S_L
 *   P_NOTE     pending update targeting N1
 *   an unread asking notification (container-less)
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  reviewSubjects: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  // `profileSlugRows` reads `db.query.profiles` (relational API).
  return {
    ...actual,
    db: drizzle(client, { schema: { profiles: actual.profiles as never } }),
  };
});

vi.mock("../services/projects/project-needs-you.js", () => ({
  listSessionsAwaitingReview: async (q: { subject?: unknown }) => {
    h.reviewSubjects.push(q.subject);
    return { sessions: [], truncated: false };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  notifications,
  messages,
  channels,
  channelMembers,
  users,
  workspaces,
  workspaceMembers,
  podMembers,
  projectMembers,
  proposals,
  projects,
  events,
  chatTurns,
  automationRuns,
  automationStepRuns,
  automations,
  entities,
  entityFacets,
  profiles,
  links,
} from "@synap/database";
import { signalsRouter } from "./signals.js";

const USER = "user-1";
const LEAD = randomUUID();
const NOTE = randomUUID();
const L1 = randomUUID();
const N1 = randomUUID();
const S_L = randomUUID();
const S_N = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${["created_at", "updated_at", "timestamp", "started_at"].includes(c.name) ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function session(id: string, subject: string) {
  // Each session's room has an IS turn running — both are "working now".
  const room = randomUUID();
  await q(
    `insert into chat_turns (id, channel_id, status, started_at, updated_at) values ($1, $2, 'running', now(), now())`,
    [randomUUID(), room]
  );
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, origin, subject_entity_id, channel_id, expected_outputs, agent_ids, metadata, criteria, created_at, updated_at, started_at)
     values ($1, $2, 'g', $3, 'active', 'human', $4, $6, $5::jsonb, '{}', '{}'::jsonb, '[]'::jsonb, now(), now(), now())`,
    [
      id,
      USER,
      `Session ${id.slice(0, 4)}`,
      subject,
      JSON.stringify([
        {
          kind: "decision",
          label: `Decide ${id.slice(0, 4)}`,
          status: "pending",
          owner: "human",
          owedSince: new Date(Date.now() - 60 * 60_000).toISOString(),
        },
      ]),
      room,
    ]
  );
}

async function proposal(o: {
  type: string;
  targetType: string;
  targetId: string;
  data?: unknown;
  sessionId?: string;
}) {
  await q(
    `insert into proposals (id, proposal_type, target_type, target_id, data, status, session_id, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5::jsonb, 'pending', $6, $7, now() - interval '20 minutes', now())`,
    [
      randomUUID(),
      o.type,
      o.targetType,
      o.targetId,
      JSON.stringify(o.data ?? {}),
      o.sessionId ?? null,
      USER,
    ]
  );
}

const caller = () =>
  signalsRouter.createCaller({
    db: null,
    authenticated: true,
    userId: USER,
  } as never);

beforeAll(async () => {
  for (const t of [
    focusSessions,
    notifications,
    messages,
    channels,
    channelMembers,
    users,
    workspaces,
    workspaceMembers,
    podMembers,
    projectMembers,
    proposals,
    projects,
    events,
    chatTurns,
    automationRuns,
    automationStepRuns,
    automations,
    entities,
    entityFacets,
    profiles,
    links,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into users (id, name, user_type) values ($1, 'Me', 'human')`,
    [USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values
      ($1,'lead','Lead','kind','workspace'), ($2,'note','Note','kind','workspace')`,
    [LEAD, NOTE]
  );
  for (const [id, p] of [
    [L1, LEAD],
    [N1, NOTE],
  ] as const) {
    await q(
      `insert into entities (id, user_id, type, profile_id, title, properties) values ($1,$2,'x',$3,'t','{}'::jsonb)`,
      [id, USER, p]
    );
  }
  await session(S_L, L1);
  await session(S_N, N1);
  await proposal({ type: "update", targetType: "entity", targetId: L1 });
  await proposal({
    type: "create",
    targetType: "entity",
    targetId: randomUUID(),
    data: { data: { profileSlug: "lead", title: "New lead" } },
  });
  await proposal({
    type: "create",
    targetType: "document",
    targetId: randomUUID(),
    sessionId: S_L,
  });
  await proposal({ type: "update", targetType: "entity", targetId: N1 });
  await q(
    `insert into notifications (id, user_id, type, category, priority, title, body, source_type, source_id, actions, status, created_at)
     values ($1, $2, 'connector.sync.failed', 'data', 'high', 'Gmail sync failed', '', 'connector', null, '[]'::jsonb, 'unread', now())`,
    [randomUUID(), USER]
  );
}, 120_000);

describe("signals — the intent lens (profileSlug)", () => {
  it("count: decisions on the kind's things (target · create · filed in a session on one), their owed slots, no notification", async () => {
    const lead = await caller().count({ profileSlug: "lead" });
    expect(lead).toMatchObject({ decisions: 3, blocked: 1, notifications: 0 });
    const note = await caller().count({ profileSlug: "note" });
    expect(note).toMatchObject({ decisions: 1, blocked: 1, notifications: 0 });
    // Non-vacuity: unlensed, everything counts — including the notification.
    const all = await caller().count({});
    expect(all).toMatchObject({ decisions: 4, blocked: 2, notifications: 1 });
  });

  it("the review half is handed the resolved subject", async () => {
    h.reviewSubjects = [];
    await caller().count({ profileSlug: "lead" });
    expect(h.reviewSubjects).toEqual([{ kind: "kind", profileIds: [LEAD] }]);
  });

  it("needs-you rows are the same population as the count", async () => {
    const { signals } = await caller().list({
      lens: "needs-you",
      profileSlug: "lead",
      limit: 100,
    });
    const owedRows = signals.filter((s) => s.kind === "owed-slot");
    expect(owedRows).toHaveLength(1);
    expect(owedRows[0]!.target).toMatchObject({ kind: "session", id: S_L });
  });

  it("happening: only the sessions on the kind's things that are working now", async () => {
    const lead = await caller().list({
      lens: "happening",
      profileSlug: "lead",
    });
    expect(lead.signals.map((x) => x.id)).toEqual([`live:${S_L}`]);
    // Non-vacuity: unlensed, both rooms are working.
    const all = await caller().list({ lens: "happening" });
    expect(new Set(all.signals.map((x) => x.id))).toEqual(
      new Set([`live:${S_L}`, `live:${S_N}`])
    );
  });

  it("countByProfile: one count per slug, an unknown slug is unavailable — never zero", async () => {
    const rows = await caller().countByProfile({
      profileSlugs: ["lead", "note", "nope"],
    });
    expect(rows.map((r) => [r.profileSlug, r.status])).toEqual([
      ["lead", "ok"],
      ["note", "ok"],
      ["nope", "unavailable"],
    ]);
    expect(rows[0]).toMatchObject({ count: { decisions: 3, blocked: 1 } });
  });

  it("an unknown slug throws on a single read; lenses that cannot follow a thing refuse it", async () => {
    await expect(caller().count({ profileSlug: "nope" })).rejects.toMatchObject(
      { code: "NOT_FOUND" }
    );
    for (const lens of ["page", "produced", "history"] as const) {
      await expect(
        caller().list({ lens, profileSlug: "lead" })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });
});
