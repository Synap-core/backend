/**
 * D12 — MOVE a session into another space, driven through the REAL
 * `updateFocusSession` (the MCP `update_session` door), the REAL
 * `focus_session/update` executor, the REAL `checkSessionWorkspaceMove` /
 * `applySessionWorkspaceMove`, and read back through the REAL session read
 * roster (`sessionReaderIds` → `sessionReadableWhere`) on PGlite.
 *
 * Stubbed, at infrastructure seams only: `checkPermissionOrPropose` (records
 * the gate call; proposes when an agent forces it), realtime emit, block
 * guidance, side effects. The proposal envelope is built from the RECORDED gate
 * `data`, exactly as `createProposal` nests it (`data.data`).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});

const { permSpy } = vi.hoisted(() => ({
  permSpy: vi.fn(
    async (_args: Record<string, unknown>) => ({}) as Record<string, unknown>
  ),
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: permSpy,
  proposedMessageFor: (_t: unknown, fallback: string) => fallback,
}));
vi.mock("../ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { updateFocusSession } from "../update-session.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { sessionReaderIds } from "../../../access/session-visibility.js";

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
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
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
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = "user-1";
const PEER = "user-2";
const OUTSIDER = "user-3";
const AGENT = randomUUID();
const ORIGIN = randomUUID();
const TARGET = randomUUID();
const VIEWER_ONLY = randomUUID();

async function member(ws: string, userId: string, role = "editor") {
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, $3)`,
    [ws, userId, role]
  );
}

/** A session in ORIGIN with its minted room, one artifact and one produced entity. */
async function seedSession(seated: string[]) {
  const sessionId = randomUUID();
  const channelId = randomUUID();
  const entityId = randomUUID();
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, scope, status, title, context_object_type, context_object_id)
     values ($1, $2, $3, 'group', 'workspace', 'active', 'Room', 'focus_session', $4)`,
    [channelId, USER, ORIGIN, sessionId]
  );
  for (const [i, who] of [USER, ...seated].entries()) {
    await q(
      `insert into channel_members (id, channel_id, member_id, member_kind, role)
       values (gen_random_uuid(), $1, $2, 'human', $3)`,
      [channelId, who, i === 0 ? "owner" : "member"]
    );
  }
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, workspace_id, channel_id, expected_outputs, criteria, metadata, agent_ids, started_at, updated_at)
     values ($1, $2, null, 'Write the brief', 'active', 'human', $3, $4,
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now())`,
    [sessionId, USER, ORIGIN, channelId]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties)
     values ($1, $2, $3, 'note', 'The brief', '{}'::jsonb)`,
    [entityId, USER, ORIGIN]
  );
  await q(
    `insert into artifacts (id, workspace_id, user_id, kind, ref_id, title, session_id, state)
     values (gen_random_uuid(), $1, $2, 'entity', $3, 'The brief', $4, 'working')`,
    [ORIGIN, USER, entityId, sessionId]
  );
  return { sessionId, channelId, entityId };
}

const placement = async (s: {
  sessionId: string;
  channelId: string;
  entityId: string;
}) => ({
  session: (
    await q<{ workspace_id: string | null }>(
      `select workspace_id from focus_sessions where id = $1`,
      [s.sessionId]
    )
  ).rows[0]!.workspace_id,
  room: (
    await q<{ workspace_id: string | null; scope: string }>(
      `select workspace_id, scope from channels where id = $1`,
      [s.channelId]
    )
  ).rows[0]!,
  artifacts: (
    await q<{ workspace_id: string | null }>(
      `select workspace_id from artifacts where session_id = $1`,
      [s.sessionId]
    )
  ).rows.map((r) => r.workspace_id),
  entity: (
    await q<{ workspace_id: string | null }>(
      `select workspace_id from entities where id = $1`,
      [s.entityId]
    )
  ).rows[0]!.workspace_id,
});

async function approve(sessionId: string, gate: Record<string, unknown>) {
  const executor = proposalExecRegistry.resolveExact("focus_session/update")!;
  return executor.execute({
    proposal: {
      id: randomUUID(),
      targetId: sessionId,
      workspaceId: ORIGIN,
      projectId: null,
      subjectUserId: USER,
      data: { data: gate },
      targetType: "focus_session",
      proposalType: "update",
    },
    payload: null,
    userId: USER,
    input: { proposalId: randomUUID() },
    deps: {
      reportProposalOutcome: () => undefined,
      emitProposalReviewed: () => undefined,
      emitSideEffects: () => undefined,
      notify: async () => undefined,
    },
  } as never);
}

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one these doors read.
      }
    }
  }
  registerFocusSessionExecutors();
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from channels; delete from channel_members; delete from artifacts; delete from entities; delete from proposals; delete from workspaces; delete from workspace_members; delete from users;"
  );
  for (const id of [USER, PEER, OUTSIDER]) {
    await q(
      `insert into users (id, email, user_type) values ($1, $2, 'human')`,
      [id, `${id}@example.test`]
    );
  }
  for (const ws of [ORIGIN, TARGET, VIEWER_ONLY]) {
    await q(
      `insert into workspaces (id, name, owner_id, created_at, updated_at) values ($1, $2, $3, now(), now())`,
      [ws, ws === TARGET ? "Builder" : `ws-${ws.slice(0, 4)}`, USER]
    );
  }
  await member(ORIGIN, USER, "owner");
  await member(TARGET, USER, "owner");
  await member(VIEWER_ONLY, USER, "viewer");
  // PEER sits in the room but belongs to TARGET only — so it cannot read the
  // session while it lives in ORIGIN.
  await member(TARGET, PEER, "editor");
  permSpy.mockClear();
  permSpy.mockImplementation(async (args) =>
    args.agentUserId && args.forcePropose
      ? { proposalId: randomUUID(), proposalType: "update" }
      : {}
  );
});

describe("an agent moves a session into another space", () => {
  it("proposes; the approval moves session, room and artifacts — never the entities", async () => {
    const s = await seedSession([PEER]);
    expect(await sessionReaderIds(s.sessionId)).toEqual([USER]);

    const res = await updateFocusSession({
      sessionId: s.sessionId,
      userId: USER,
      agentUserId: AGENT,
      workspaceId: TARGET,
    });
    expect(res.status).toBe("proposed");
    const gate = permSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(gate).toMatchObject({
      subjectType: "focus_session",
      action: "update",
      forcePropose: true,
      workspaceId: ORIGIN,
      data: { workspaceId: TARGET, workspaceName: "Builder" },
    });
    // Nothing moved before approval.
    expect((await placement(s)).session).toBe(ORIGIN);

    await approve(s.sessionId, gate.data as Record<string, unknown>);

    expect(await placement(s)).toEqual({
      session: TARGET,
      room: { workspace_id: TARGET, scope: "workspace" },
      artifacts: [TARGET],
      entity: ORIGIN,
    });
    // The room's human seat now reads the session through the real roster.
    expect((await sessionReaderIds(s.sessionId)).sort()).toEqual(
      [USER, PEER].sort()
    );
  });

  it("refuses, before governance, when someone in the room is not a member of the target", async () => {
    const s = await seedSession([PEER, OUTSIDER]);
    const res = await updateFocusSession({
      sessionId: s.sessionId,
      userId: USER,
      agentUserId: AGENT,
      workspaceId: TARGET,
    });
    expect(res.status).toBe("denied");
    if (res.status === "denied") {
      expect(res.reason).toMatch(/1 person in its room is not a member/);
    }
    expect(permSpy).not.toHaveBeenCalled();
    expect((await placement(s)).session).toBe(ORIGIN);
  });

  it("refuses a space the caller cannot write", async () => {
    const s = await seedSession([]);
    const res = await updateFocusSession({
      sessionId: s.sessionId,
      userId: USER,
      agentUserId: AGENT,
      workspaceId: VIEWER_ONLY,
    });
    expect(res.status).toBe("denied");
    expect(permSpy).not.toHaveBeenCalled();
  });

  it("approval re-floors: a roster member added since the proposal blocks it", async () => {
    const s = await seedSession([PEER]);
    await updateFocusSession({
      sessionId: s.sessionId,
      userId: USER,
      agentUserId: AGENT,
      workspaceId: TARGET,
    });
    const gate = permSpy.mock.calls[0]![0] as Record<string, unknown>;
    await q(
      `insert into channel_members (id, channel_id, member_id, member_kind, role)
       values (gen_random_uuid(), $1, $2, 'human', 'member')`,
      [s.channelId, OUTSIDER]
    );
    await expect(
      approve(s.sessionId, gate.data as Record<string, unknown>)
    ).rejects.toThrow(/not a member/);
    expect((await placement(s)).session).toBe(ORIGIN);
  });
});

describe("a person moves their own session", () => {
  it("moves it directly, and `null` makes it personal (room goes pod-scoped)", async () => {
    const s = await seedSession([]);
    const res = await updateFocusSession({
      sessionId: s.sessionId,
      userId: USER,
      workspaceId: TARGET,
    });
    expect(res.status).toBe("updated");
    if (res.status === "updated") expect(res.session.workspaceId).toBe(TARGET);
    expect((await placement(s)).room).toEqual({
      workspace_id: TARGET,
      scope: "workspace",
    });

    await updateFocusSession({
      sessionId: s.sessionId,
      userId: USER,
      workspaceId: null,
    });
    expect(await placement(s)).toEqual({
      session: null,
      room: { workspace_id: null, scope: "pod" },
      artifacts: [null],
      entity: ORIGIN,
    });
  });

  it("its own space is not a move: no proposal for an agent", async () => {
    const s = await seedSession([]);
    await updateFocusSession({
      sessionId: s.sessionId,
      userId: USER,
      agentUserId: AGENT,
      workspaceId: ORIGIN,
      progress: 10,
    });
    const gate = permSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(gate.forcePropose).toBeUndefined();
    expect(gate.data).not.toHaveProperty("workspaceId");
  });
});
