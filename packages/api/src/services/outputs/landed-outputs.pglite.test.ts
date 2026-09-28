/**
 * W5 "Landed" on PGlite — real SQL through the real projection and the REAL
 * tRPC doors, nothing hand-built in between:
 *
 *   outputs.landed            — objects that landed pod-wide + actor + decision
 *   focusSessions.landed      — sessions settled since, with outputsSummary
 *   focusSessions.list        — every row carries lastAgentActivityAt
 *   proposals.list({subject}) — Lineage "Decided by" finds the CREATING
 *                               proposal even when it targets another id
 *
 * Fixture (USER owns everything unless noted; AGENT is an agent user):
 *   S1   closed 30m ago, work, W1
 *        E_AUTO  entity, agent write, auto-approved RECEIPT (targetId = E_AUTO)
 *                filed BEFORE it + a LATER approved edit on the same target
 *                (must not be read as the creation)
 *        E_COMP  entity from an APPROVED composite — the proposal targets
 *                ANOTHER id; only `source_proposal_id` links them
 *        D_MINE  document the USER made (no provenance) → human, applied
 *        pending create P_PEND (target does not exist) → "To review" row
 *        pending edit P_EDIT on E_AUTO (target exists) → NOT a row
 *   S2   failed 10m ago (no closed_at), W1 — a view artifact made by an agent
 *        that recorded no id → agent with id null
 *   S3   active, W1 — an older output; an agent posted in its room
 *   SOLD closed two days ago, W1
 *   SW2  closed 5m ago, W2 (the other workspace)
 *   STR  a stranger's closed session with an output — never listed
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
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
  // Every table, so the doors' relational reads (`db.query.*`) resolve too.
  const pg = drizzle(client, { schema: Object.fromEntries(tables) as never });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    getParentSessionIds: async () => new Map<string, string>(),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { TRPCError } from "@trpc/server";
import {
  resolveLandedDecisionView,
  type LandedObjectRow,
} from "@synap-core/types/landed";
import { outputsRouter } from "../../routers/outputs.js";
import { focusSessionsRouter } from "../../routers/focus-sessions.js";
import { proposalsRouter } from "../../routers/proposals.js";

const USER = "user-1";
const STRANGER = "user-2";
const AGENT = "agent-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def = c.primary && type === "uuid" ? " default gen_random_uuid()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

const W1 = randomUUID();
const W2 = randomUUID();
const HIDDEN_PROJECT = randomUUID();
const S = {
  s1: randomUUID(),
  s2: randomUUID(),
  s3: randomUUID(),
  old: randomUUID(),
  w2: randomUUID(),
  str: randomUUID(),
};
const CH3 = randomUUID();
const E_AUTO = randomUUID();
const E_COMP = randomUUID();
const D_MINE = randomUUID();
const V_AGENT = randomUUID();
const E_S3 = randomUUID();
const D_W2 = randomUUID();
const D_STR = randomUUID();
const P_RECEIPT = randomUUID();
const P_LATER_EDIT = randomUUID();
const P_COMP = randomUUID();
const P_PEND = randomUUID();
const P_PEND_TARGET = randomUUID();
const P_EDIT = randomUUID();
const COMPANY_PROFILE = randomUUID();

async function session(
  id: string,
  o: {
    user?: string;
    ws?: string;
    goal: string;
    status: string;
    updated: number;
    closed?: number | null;
    channelId?: string | null;
  }
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, expected_outputs, metadata, origin, channel_id, created_at, started_at, updated_at, closed_at)
     values ($1,$2,$3,$4,$5,'[]'::jsonb,'{}'::jsonb,'human',$6,$7,$7,$8,$9)`,
    [
      id,
      o.user ?? USER,
      o.ws ?? W1,
      o.goal,
      o.status,
      o.channelId ?? null,
      ago(o.updated + 60),
      ago(o.updated),
      o.closed == null ? null : ago(o.closed),
    ]
  );
}

const produced = (sessionId: string, entityId: string, mins: number) =>
  q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1,'session',$2,'entity',$3,'produced','{}'::jsonb,$4)`,
    [randomUUID(), sessionId, entityId, ago(mins)]
  );

const artifact = (
  sessionId: string,
  kind: string,
  refId: string,
  title: string,
  origin: "agent" | "user",
  mins: number,
  user = USER
) =>
  q(
    `insert into artifacts (id, user_id, kind, ref_id, title, origin_kind, session_id, state, props, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,'kept','{}'::jsonb,$8,$8)`,
    [randomUUID(), user, kind, refId, title, origin, sessionId, ago(mins)]
  );

const proposal = (p: {
  id: string;
  status: string;
  targetType: string;
  targetId: string;
  proposalType: string;
  mins: number;
  sessionId?: string | null;
  agent?: string | null;
  reviewedBy?: string | null;
  data?: unknown;
}) =>
  q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, agent_user_id, created_by, session_id, reviewed_by, reviewed_at, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$13)`,
    [
      p.id,
      W1,
      p.targetType,
      p.targetId,
      p.proposalType,
      JSON.stringify(p.data ?? {}),
      p.status,
      p.agent ?? null,
      p.agent ?? USER,
      p.sessionId ?? null,
      p.reviewedBy ?? null,
      p.reviewedBy ? ago(p.mins - 1) : null,
      ago(p.mins),
    ]
  );

const ctx = (extra: Record<string, unknown> = {}) =>
  ({ db: null, authenticated: true, userId: USER, ...extra }) as never;
const landed = (input: Parameters<ReturnType<typeof outputsRouter.createCaller>["landed"]>[0], c = ctx()) =>
  outputsRouter.createCaller(c).landed(input);

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema) await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await h.client!.exec(`create schema if not exists pgboss; create table if not exists pgboss.job (id uuid primary key default gen_random_uuid(), name text, state text, data jsonb);`);

  await q(`insert into workspaces (id, name) values ($1,'Builder'),($2,'CRM')`, [W1, W2]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id) values ($1,$2,$4),($3,$5,$4)`,
    [randomUUID(), W1, randomUUID(), USER, W2]
  );
  await q(
    `insert into users (id, name, email, user_type, agent_metadata) values
      ($1,'Antoine','a@x.io','human',null),
      ($2,'Claude Code','agent@x.io','agent','{"agentType":"claude-code"}'::jsonb),
      ($3,'Stranger','s@x.io','human',null)`,
    [USER, AGENT, STRANGER]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1,$2,null,'Theirs','active')`,
    [HIDDEN_PROJECT, STRANGER]
  );

  await session(S.s1, { goal: "Outreach wave", status: "closed", updated: 30, closed: 30 });
  await session(S.s2, { goal: "Scrape pricing", status: "failed", updated: 10, closed: null });
  await session(S.s3, { goal: "Still running", status: "active", updated: 3, channelId: CH3 });
  await session(S.old, { goal: "Last week", status: "closed", updated: 2880, closed: 2880 });
  await session(S.w2, { ws: W2, goal: "CRM import", status: "closed", updated: 5, closed: 5 });
  await session(S.str, { user: STRANGER, goal: "Not yours", status: "closed", updated: 4, closed: 4 });

  // S1 — E_AUTO: receipt filed BEFORE the write, and a LATER approved edit.
  await proposal({ id: P_RECEIPT, status: "auto_approved", targetType: "entity", targetId: E_AUTO, proposalType: "entity.create", mins: 50, sessionId: S.s1, agent: AGENT });
  await proposal({ id: P_LATER_EDIT, status: "approved", targetType: "entity", targetId: E_AUTO, proposalType: "update", mins: 35, sessionId: S.s1, agent: AGENT, reviewedBy: USER });
  // S1 — E_COMP: an approved COMPOSITE whose target is another id.
  await proposal({ id: P_COMP, status: "approved", targetType: "entity", targetId: randomUUID(), proposalType: "create_composite", mins: 48, sessionId: S.s1, agent: AGENT, reviewedBy: USER });
  // S1 — a pending CREATE (no such object) and a pending EDIT of E_AUTO.
  await proposal({ id: P_PEND, status: "pending", targetType: "entity", targetId: P_PEND_TARGET, proposalType: "create", mins: 31, sessionId: S.s1, agent: AGENT, data: { targetType: "entity", changeType: "create", requestId: "r1", data: { title: "Linear" } } });
  await proposal({ id: P_EDIT, status: "pending", targetType: "entity", targetId: E_AUTO, proposalType: "update", mins: 31, sessionId: S.s1, agent: AGENT });

  // A CUSTOM kind with its own plural — the label both apps must render.
  await q(
    `insert into profiles (id, slug, display_name, plural, ui_hints) values ($1,'company','Company','Companies','{}'::jsonb)`,
    [COMPANY_PROFILE]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, title, type, created_by_kind, created_by_user_id, agent_user_id, source_proposal_id, created_at, updated_at) values
      ($1,$2,$3,'Ada Lovelace','person','agent',$2,$4,null,$5,$5),
      ($6,$2,$3,'Linear Co','company','agent',$2,$4,$7,$8,$8),
      ($9,$2,$3,'Older thing','note',null,null,null,null,$10,$10),
      ($11,$12,$3,'Theirs','note',null,null,null,null,$13,$13)`,
    [E_AUTO, USER, W1, AGENT, ago(49), E_COMP, P_COMP, ago(40), E_S3, ago(200), randomUUID(), STRANGER, ago(4)]
  );
  await q(
    `insert into documents (id, user_id, workspace_id, title, created_at, updated_at) values
      ($1,$2,$3,'My notes',$4,$4),($5,$2,$6,'CRM brief',$7,$7),($8,$9,$3,'Stranger doc',$10,$10)`,
    [D_MINE, USER, W1, ago(33), D_W2, W2, ago(6), D_STR, STRANGER, ago(4)]
  );
  await q(`update entities set profile_id = $1 where id = $2`, [COMPANY_PROFILE, E_COMP]);
  await produced(S.s1, E_AUTO, 49);
  await produced(S.s1, E_COMP, 40);
  await artifact(S.s1, "document", D_MINE, "My notes", "user", 33);
  await artifact(S.s2, "view", V_AGENT, "Scrape log", "agent", 11);
  await produced(S.s3, E_S3, 200);
  await artifact(S.w2, "document", D_W2, "CRM brief", "agent", 6);
  await artifact(S.str, "document", D_STR, "Stranger doc", "agent", 4, STRANGER);

  // S3's room: an agent post (2m ago) is later than any proposal in S3.
  await q(
    `insert into messages (id, channel_id, role, author_type, content, user_id, timestamp) values ($1,$2,'assistant','ai_agent','progress',$3,$4)`,
    [randomUUID(), CH3, AGENT, ago(2)]
  );
  await proposal({ id: randomUUID(), status: "auto_approved", targetType: "entity", targetId: randomUUID(), proposalType: "entity.update", mins: 20, sessionId: S.s3, agent: AGENT });
});

const byRef = (items: LandedObjectRow[], id: string) =>
  items.find((i) => i.ref.id === id)!;

describe("outputs.landed — objects that landed, pod-wide", () => {
  it("lists every floored session's outputs, newest first, with a session door; strangers never", async () => {
    const page = await landed({});
    expect(page.items.map((i) => i.title)).toEqual([
      "CRM brief", // 6m, W2
      "Scrape log", // 11m
      "Linear", // 31m — the pending create
      "My notes", // 33m
      "Linear Co", // 40m
      "Ada Lovelace", // 49m
      "Older thing", // 200m, from the ACTIVE session: landed objects are not only from settled sessions
    ]);
    expect(page.items.some((i) => i.title === "Stranger doc")).toBe(false);
    expect(byRef(page.items, E_AUTO).session).toEqual({ id: S.s1, title: "Outreach wave" });
    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("decision = the CREATING proposal: the receipt before the write, never a later edit", async () => {
    const row = byRef((await landed({})).items, E_AUTO);
    expect(row.decision).toEqual({ state: "auto_approved", proposalId: P_RECEIPT, decidedBy: null, decidedAt: null });
    expect(resolveLandedDecisionView(row.decision.state).undoable).toBe(true);
  });

  it("an approved composite is found through source_proposal_id, with WHO decided", async () => {
    const row = byRef((await landed({})).items, E_COMP);
    expect(row.decision.state).toBe("approved");
    expect(row.decision.proposalId).toBe(P_COMP);
    expect(row.decision.decidedBy).toEqual({ id: USER, name: "Antoine" });
    expect(row.decision.decidedAt).not.toBeNull();
    expect(row.actor).toEqual({ kind: "agent", id: AGENT, name: "Claude Code" });
    expect(row.entityProfile).toMatchObject({ displayName: "Company", plural: "Companies" });
  });

  it("actor: a legacy no-provenance row is the owner (human, me); an unattributed agent artifact is an agent with no id", async () => {
    const items = (await landed({})).items;
    expect(byRef(items, D_MINE).actor).toEqual({ kind: "human", id: USER, name: "Antoine", isViewer: true });
    expect(byRef(items, D_MINE).decision.state).toBe("applied");
    expect(byRef(items, V_AGENT).actor).toEqual({ kind: "agent", id: null, name: null });
  });

  it("a pending CREATE is a To-review row whose door is the proposal; a pending EDIT of a live object is not a row", async () => {
    const items = (await landed({})).items;
    const pending = items.find((i) => i.id === `proposal:${P_PEND}`)!;
    expect(pending).toMatchObject({
      kind: "entity",
      title: "Linear",
      ref: { kind: "proposal", id: P_PEND },
      session: { id: S.s1 },
      decision: { state: "pending", proposalId: P_PEND },
      actor: { kind: "agent", id: AGENT },
    });
    expect(resolveLandedDecisionView(pending.decision.state).landed).toBe(false);
    expect(items.some((i) => i.id === `proposal:${P_EDIT}`)).toBe(false);
  });

  it("actor filter: agents / me", async () => {
    const agents = (await landed({ actor: "agents" })).items.map((i) => i.title);
    expect(agents).toEqual(["CRM brief", "Scrape log", "Linear", "Linear Co", "Ada Lovelace"]);
    const mine = (await landed({ actor: "me" })).items.map((i) => i.title);
    expect(mine).toEqual(["My notes", "Older thing"]);
  });

  it("since filters rows at or after the instant", async () => {
    const recent = (await landed({ since: ago(32) })).items.map((i) => i.title);
    expect(recent).toEqual(["CRM brief", "Scrape log", "Linear"]);
  });

  it("workspace lens: absent = the whole floor even with an active-workspace header; an id narrows", async () => {
    const withHeader = await landed({}, ctx({ workspaceId: W1 }));
    expect(withHeader.items.some((i) => i.title === "CRM brief")).toBe(true);
    const w2 = await landed({ workspaceId: W2 });
    expect(w2.items.map((i) => i.title)).toEqual(["CRM brief"]);
  });

  it("cursor pages cover every row exactly once", async () => {
    const all = (await landed({})).items.map((i) => i.id);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await landed({ limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all);
  });

  it("errors throw — a hidden project, a bad cursor, a bad since — never an empty page", async () => {
    await expect(landed({ projectId: HIDDEN_PROJECT })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(landed({ cursor: "garbage" })).rejects.toBeInstanceOf(TRPCError);
    await expect(landed({ since: "yesterday" })).rejects.toBeInstanceOf(TRPCError);
  });
});

describe("focusSessions.landed — sessions settled since, as their result", () => {
  const caller = () => focusSessionsRouter.createCaller(ctx({ workspaceId: W1 }));

  it("settled (failures included) since, newest settled first; open and older sessions out; floor not header", async () => {
    const rows = await caller().landed({ since: ago(60) });
    expect(rows.map((r) => r.id)).toEqual([S.w2, S.s2, S.s1]);
  });

  it("each row carries its outputsSummary from the Produced join", async () => {
    const rows = await caller().landed({ since: ago(60) });
    const s1 = rows.find((r) => r.id === S.s1)!;
    expect(s1.outputsSummary.count).toBe(3);
    expect(s1.outputsSummary.byKind.map((k) => [k.key, k.count])).toEqual([
      ["company", 1],
      ["document", 1],
      ["person", 1],
    ]);
    // The profile's OWN words ride on the group — singular and plural.
    expect(s1.outputsSummary.byKind[0]!.entityProfile).toEqual({
      slug: "company",
      displayName: "Company",
      plural: "Companies",
      icon: null,
    });
    expect(s1.outputsSummary.top).toMatchObject({ title: "My notes", ref: { kind: "document", id: D_MINE } });
    expect(rows.find((r) => r.id === S.s2)!.outputsSummary.count).toBe(1);
  });
});

describe("lastAgentActivityAt on every session list row", () => {
  it("is the later of an agent's proposal and an agent's room post; null when no agent acted", async () => {
    const rows = await focusSessionsRouter
      .createCaller(ctx())
      .list({ status: "all", limit: 50 });
    const at = (id: string) => rows.find((r) => r.id === id)!.lastAgentActivityAt;
    // S3: proposal 20m ago, room post 2m ago → the post.
    expect(Math.abs(new Date(at(S.s3)!).getTime() - Date.parse(ago(2)))).toBeLessThan(5_000);
    // S1: latest agent proposal 31m ago.
    expect(Math.abs(new Date(at(S.s1)!).getTime() - Date.parse(ago(31)))).toBeLessThan(5_000);
    expect(at(S.old)).toBeNull();
  });
});

describe("proposals.list({ subject }) — Lineage 'Decided by' reaches the creating proposal", () => {
  const list = (input: Record<string, unknown>) =>
    proposalsRouter.createCaller(ctx()).list({ status: "all", ...input } as never);

  it("targetId alone misses a composite's proposal; subject finds it, with the approver", async () => {
    const byTarget = await list({ targetId: E_COMP });
    expect(byTarget.items.map((p: { id: string }) => p.id)).not.toContain(P_COMP);
    const bySubject = await list({ subject: { kind: "entity", id: E_COMP } });
    const row = bySubject.items.find((p: { id: string }) => p.id === P_COMP) as
      | { status: string; approverName?: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("approved");
    expect(row!.approverName).toBe("Antoine");
  });

  it("subject keeps every proposal targeting the object (receipt + later edits)", async () => {
    const ids = (await list({ subject: { kind: "entity", id: E_AUTO } })).items.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining([P_RECEIPT, P_LATER_EDIT, P_EDIT]));
  });
});
