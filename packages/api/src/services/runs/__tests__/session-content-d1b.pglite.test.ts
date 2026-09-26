/**
 * DECISION D1, round 2 — session CONTENT that escaped the session read rule by
 * being COPIED somewhere else, or reached through a side door:
 *
 *   1. `events.search` — a session's events (subject = the session, or
 *      recorded inside it) are OMITTED for a non-reader.
 *   2. proposals — the goal stamped as `data.targetName` and a close's
 *      goal/status/summary in `data` are REDACTED AT READ (display, groups,
 *      the Hub list), never rewritten.
 *   3. the session's DOCUMENT (titled with the session, holding the closing
 *      report) follows the session, not the workspace.
 *   4. the Hub channel context-card lists only sessions the caller may read.
 *
 * Cast (all members of W): OWNER owns session T (minted room ROOM, MEMBER
 * seated as a human); COLLEAGUE is not on the roster. "Agent key" = the same
 * MEMBER through an agent door (`agentUserId` / `isHubProtocol`, or no roster).
 *
 * Stubbed: `getEventRepository().searchEvents` returns a fixed page — the SQL
 * of the search is not what D1 changed; the filter over its result is, and it
 * runs for real (the session predicate executes on PGlite).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      proposals: actual.proposals as never,
      documents: actual.documents as never,
      views: actual.views as never,
      workspaceMembers: actual.workspaceMembers as never,
      workspaces: actual.workspaces as never,
    },
  });
  return {
    ...actual,
    db,
    getDb: async () => db,
    getEventRepository: () => ({
      searchEvents: async () => h.events,
    }),
  };
});

vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import * as schema from "@synap/database/schema";
import { documents } from "@synap/database/schema";
import { eventsRouter } from "../../../routers/events.js";
import { enrichProposalsForDisplay } from "../../../routers/proposals/display.js";
import { proposalsRouter } from "../../../routers/proposals.js";
import { documentsRouter } from "../../../routers/documents.js";
import { loadReadableDocument } from "../../../utils/document-edit-access.js";
import { AccessContext, scopedDb } from "../../../access/index.js";
import { redactUnreadableSessionTargets } from "../../proposals/session-content-redaction.js";
import { registerChannelsRoutes } from "../../../routers/hub-protocol/rest/channels.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const OWNER = "owner-d1b";
const MEMBER = "member-d1b";
const COLLEAGUE = "colleague-d1b";
const WS = randomUUID();
const WS_COLLEAGUE = randomUUID(); // COLLEAGUE owns it → events.search admin branch
const WS_MEMBER = randomUUID(); // MEMBER owns it → same branch, as a roster human
const T = randomUUID();
const ROOM = randomUUID();
const T2 = randomUUID();
const TEAM = randomUUID();
const DOC = randomUUID(); // T's designated session document
const PLAIN_DOC = randomUUID(); // an ordinary workspace document (control)
const T_GOAL = "Negotiate the Acme exit";
const SUMMARY = "Acme agreed to 40% — confidential";

const human = (userId: string) => ({ authenticated: true, userId }) as never;
const agentKey = (userId: string) =>
  ({ authenticated: true, userId, agentUserId: `agent-of-${userId}` }) as never;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const n of [
    "focus_sessions",
    "artifacts",
    "documents",
    "proposals",
    "channels",
    "channel_members",
  ])
    expect(byName.has(n)).toBe(true);
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [OWNER, MEMBER, COLLEAGUE]) {
    await q(`insert into users (id, user_type) values ($1, 'human')`, [u]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
      [randomUUID(), WS, u]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb),($3,'C',$4,'{}'::jsonb),($5,'M',$6,'{}'::jsonb)`,
    [WS, OWNER, WS_COLLEAGUE, COLLEAGUE, WS_MEMBER, MEMBER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [randomUUID(), WS_COLLEAGUE, COLLEAGUE, randomUUID(), WS_MEMBER, MEMBER]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, metadata, expected_outputs, channel_id, created_at, updated_at, started_at)
     values ($1, $2, $3, $4, 'active', '{}'::jsonb, $5::jsonb, $6, now(), now(), now())`,
    [
      T,
      OWNER,
      WS,
      T_GOAL,
      JSON.stringify([{ label: "Term sheet", status: "open" }]),
      ROOM,
    ]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, context_object_type, context_object_id, created_at, updated_at)
     values ($1, $2, $3, 'group', 'focus_session', $4, now(), now())`,
    [ROOM, OWNER, WS, T]
  );
  for (const m of [OWNER, MEMBER]) {
    await q(
      `insert into channel_members (id, channel_id, member_id, member_kind, role) values ($1, $2, $3, 'human', 'member')`,
      [randomUUID(), ROOM, m]
    );
  }
  // T2 BORROWS a team channel COLLEAGUE sits in: seeing the channel must not
  // mean reading the session running in it.
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, metadata, expected_outputs, channel_id, created_at, updated_at, started_at)
     values ($1, $2, $3, 'Quiet side project', 'active', '{}'::jsonb, '[]'::jsonb, $4, now(), now(), now())`,
    [T2, OWNER, WS, TEAM]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, created_at, updated_at)
     values ($1, $2, $3, 'group', now(), now())`,
    [TEAM, OWNER, WS]
  );
  for (const m of [OWNER, COLLEAGUE]) {
    await q(
      `insert into channel_members (id, channel_id, member_id, member_kind, role) values ($1, $2, $3, 'human', 'member')`,
      [randomUUID(), TEAM, m]
    );
  }
  await q(
    `insert into documents (id, title, type, workspace_id, user_id, current_version, created_at, updated_at)
     values ($1, $2, 'markdown', $3, $4, 1, now(), now()), ($5, 'Team handbook', 'markdown', $3, $4, 1, now(), now())`,
    [DOC, T_GOAL, WS, OWNER, PLAIN_DOC]
  );
  await q(
    `insert into artifacts (id, user_id, workspace_id, kind, ref_id, title, origin_kind, session_id, state, props, created_at, updated_at)
     values ($1, $2, $3, 'document', $4, $5, 'agent', $6, 'kept', '{"expectedLabel":"session-document"}'::jsonb, now(), now())`,
    [randomUUID(), OWNER, WS, DOC, T_GOAL, T]
  );
  h.events = [
    {
      id: randomUUID(),
      eventType: "focus_session.closed",
      subjectType: "focus_session",
      subjectId: T,
      data: { goal: T_GOAL, summary: SUMMARY },
      userId: OWNER,
    },
    {
      id: randomUUID(),
      eventType: "entity.created",
      subjectType: "entity",
      subjectId: randomUUID(),
      sessionId: T,
      data: { title: "Acme term sheet" },
      userId: OWNER,
    },
    {
      id: randomUUID(),
      eventType: "entity.created",
      subjectType: "entity",
      subjectId: randomUUID(),
      data: { title: "Unrelated" },
      userId: OWNER,
    },
  ];
});

// ── 1. events.search ─────────────────────────────────────────────────────────
describe("events.search — a session's events follow the session", () => {
  const search = async (ctx: never) =>
    (await eventsRouter
      .createCaller(ctx)
      .search({ limit: 50, offset: 0 })) as Array<{
      eventType: string;
      data: unknown;
    }>;

  it("a colleague (on the pod-wide admin branch) gets none of T's events, but the rest", async () => {
    const rows = await search(human(COLLEAGUE));
    expect(JSON.stringify(rows)).not.toContain(T_GOAL);
    expect(JSON.stringify(rows)).not.toContain("Acme term sheet");
    expect(rows.map((r) => (r.data as { title?: string }).title)).toContain(
      "Unrelated"
    );
  });
  it("a roster human gets them; the same member's agent key does not", async () => {
    expect(JSON.stringify(await search(human(MEMBER)))).toContain(SUMMARY);
    expect(JSON.stringify(await search(agentKey(MEMBER)))).not.toContain(
      T_GOAL
    );
  });
});

// ── 2. proposals: redact at read ────────────────────────────────────────────
function closeProposal(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: randomUUID(),
    status: "pending",
    proposalType: "update",
    targetType: "focus_session",
    targetId: T,
    workspaceId: WS,
    data: {
      targetType: "focus_session",
      targetId: T,
      changeType: "update",
      targetName: T_GOAL,
      summary: `Close "${T_GOAL}"`,
      data: {
        id: T,
        status: "closed",
        goal: T_GOAL,
        previousStatus: "active",
        sessionSummary: SUMMARY,
      },
    },
    revisionHistory: [
      {
        at: now.toISOString(),
        by: OWNER,
        before: { goal: T_GOAL },
        patch: { sessionSummary: SUMMARY },
      },
    ],
    projectId: null,
    threadId: null,
    sessionId: null,
    correlationId: null,
    agentUserId: null,
    subjectUserId: null,
    createdBy: OWNER,
    reviewedBy: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as never;
}

describe("proposals — session content copied at write time is withheld at read", () => {
  const display = async (userId: string, roster: boolean) =>
    (
      await enrichProposalsForDisplay([closeProposal()], userId, { roster })
    )[0] as unknown as Record<string, unknown>;

  it("a colleague sees the proposal with the placeholder, no goal/status/summary anywhere", async () => {
    const row = await display(COLLEAGUE, true);
    const wire = JSON.stringify(row);
    expect(wire).not.toContain(T_GOAL);
    expect(wire).not.toContain(SUMMARY);
    expect(row.targetName).toBe("Private session");
  });
  it("a roster human sees the goal; the same member's agent door does not", async () => {
    expect(JSON.stringify(await display(MEMBER, true))).toContain(SUMMARY);
    expect(JSON.stringify(await display(MEMBER, false))).not.toContain(T_GOAL);
  });
  it("a proposal to START a session (target not yet created) is left alone", async () => {
    const [row] = await redactUnreadableSessionTargets(
      [closeProposal({ targetId: randomUUID() })] as Array<{
        targetType: string;
        targetId: string | null;
        data: unknown;
      }>,
      { userId: COLLEAGUE }
    );
    expect(JSON.stringify(row)).toContain(T_GOAL);
  });
  it("proposals.groups labels a colleague's cluster without the goal", async () => {
    const pid = randomUUID();
    const p = closeProposal({ id: pid }) as unknown as { data: unknown };
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, created_by, created_at, updated_at)
       values ($1, $2, 'focus_session', $3, 'update', 'pending', $4::jsonb, $5, now(), now())`,
      [pid, WS, T, JSON.stringify(p.data), OWNER]
    );
    const groups = (ctx: never) =>
      proposalsRouter.createCaller(ctx).groups({ workspaceId: WS } as never);
    expect(JSON.stringify(await groups(human(COLLEAGUE)))).not.toContain(
      T_GOAL
    );
    expect(JSON.stringify(await groups(human(MEMBER)))).toContain(T_GOAL);
    await q(`delete from proposals where id = $1`, [pid]);
  });
});

// ── 3. the session document ─────────────────────────────────────────────────
describe("the session's document follows the session", () => {
  it("documents.get's gate: a colleague gets NOT_FOUND; owner and roster human read it", async () => {
    await expect(loadReadableDocument(COLLEAGUE, DOC)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await loadReadableDocument(MEMBER, DOC)).id).toBe(DOC);
    expect((await loadReadableDocument(OWNER, DOC)).id).toBe(DOC);
    // Narrow-only: an ordinary workspace document is untouched.
    expect((await loadReadableDocument(COLLEAGUE, PLAIN_DOC)).id).toBe(
      PLAIN_DOC
    );
  });
  it("an agent actor reads it owner-only", async () => {
    const asAgent = (userId: string) =>
      scopedDb(
        AccessContext.agent({ userId, agentUserId: `agent-of-${userId}` })
      ).findFirst(documents, { where: eq(documents.id, DOC) });
    expect(await asAgent(MEMBER)).toBeUndefined();
    expect(await asAgent(OWNER)).toBeDefined();
  });
  it("documents.list: a colleague does not list it; a roster human does; an agent key does not", async () => {
    const titles = async (ctx: never) =>
      JSON.stringify(await documentsRouter.createCaller(ctx).list({} as never));
    expect(await titles(human(COLLEAGUE))).not.toContain(T_GOAL);
    expect(await titles(human(COLLEAGUE))).toContain("Team handbook");
    expect(await titles(human(MEMBER))).toContain(T_GOAL);
    expect(await titles(agentKey(MEMBER))).not.toContain(T_GOAL);
  });
});

// ── 4. Hub channel context-card ─────────────────────────────────────────────
describe("GET /channels/:id/context-card — sessions the caller may read", () => {
  const card = async (userId: string, channelId = ROOM) => {
    const app = new OpenAPIHono();
    app.use("*", async (c, next) => {
      c.set("scopes" as never, ["hub-protocol.read"] as never);
      c.set("userId" as never, userId as never);
      await next();
    });
    registerChannelsRoutes(app as never);
    const res = await app.request(`/channels/${channelId}/context-card`);
    return {
      status: res.status,
      body: (await res.json()) as { sessions?: Array<{ id: string }> },
    };
  };
  it("the owner sees the session; the member (agent door, owner-only) does not", async () => {
    const own = await card(OWNER);
    expect(own.status).toBe(200);
    expect(own.body.sessions?.map((s) => s.id)).toEqual([T]);
    const member = await card(MEMBER);
    expect(member.status).toBe(200);
    expect(member.body.sessions).toEqual([]);
  });
  it("a colleague who SEES a borrowed team channel does not see the owner's session in it", async () => {
    const theirs = await card(COLLEAGUE, TEAM);
    expect(theirs.status).toBe(200);
    expect(theirs.body.sessions).toEqual([]);
    expect((await card(OWNER, TEAM)).body.sessions?.map((s) => s.id)).toEqual([
      T2,
    ]);
  });
});
