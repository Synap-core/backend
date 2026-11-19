/**
 * W3 (work-model plan 8daa514b, decisions D1 a, D9 a): every session sits in a
 * space read from its chain — explicit → the playbook's → the subject's → the
 * parent's → the project's home → the agent's focus, a derived rung counting
 * only where the actor may write.
 *
 * Real: `resolveSessionWorkspacePlacement` and `createFocusSession` on PGlite
 * (every table from the Drizzle schema), the focus reader over a real
 * `users.agent_metadata` row. Stubbed: the membrane (it RECORDS the space it is
 * asked about and grants), the session room, realtime, spawn edges.
 *
 * Rows rule out: a rung skipped or out of order; a derived space the actor
 * cannot write reaching the membrane (that is the `workspace.join` proposal
 * instead of the start, or a denial); the focus beating a fact; an explicit
 * space second-guessed; a placed session without its provenance stamp; a
 * copied space losing its source's rung; a move keeping a ladder stamp; an
 * adopted receipt re-homed without its room; an intake retry minting a
 * second room beside a placed first one.
 *
 * Cannot see: the real membrane's per-space governance (whether a space
 * proposes session starts); production constraints (no FKs here).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  membrane: [] as Array<{ workspaceId?: string; agentUserId?: string }>,
  /** The auto-opened receipt `findClientSession` hands the adoption, if any. */
  adoptee: null as null | { id: string },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  const realOpenRunSession = actual.openRunSession as (
    input: Record<string, unknown>
  ) => Promise<unknown>;
  return {
    ...actual,
    db: h.db,
    recordSessionSpawn: async () => ({
      linked: false,
      suspendedIntentRecorded: false,
    }),
    // The run door, real, on this PGlite (it defaults to its own pool).
    openRunSession: (input: Record<string, unknown>) =>
      realOpenRunSession({ ...input, database: h.db }),
    // The receipt lookup reads the package's own pool: the row is handed in.
    findClientSession: async () => h.adoptee,
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (args: {
      workspaceId?: string;
      agentUserId?: string;
    }) => {
      h.membrane.push({
        workspaceId: args.workspaceId,
        agentUserId: args.agentUserId,
      });
      return { granted: true };
    },
  };
});
vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionChannel: async () => null };
});
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  openRunSession,
  resolveSessionWorkspacePlacement,
} from "@synap/database";
import { createFocusSession } from "../create-session.js";
import { applySessionWorkspaceMove } from "../move-session-workspace.js";
import { ensureIntakeSession } from "../../intake/ensure-intake-session.js";

const PERSON = randomUUID();
const AGENT = randomUUID(); // member of BUILDER, CONTENT, BRAND (viewer), ARCHIVED
const FOCUSED = randomUUID(); // member of BUILDER, CONTENT; focus = CONTENT
const STRANGER = randomUUID(); // member of nothing

const BUILDER = randomUUID();
const CONTENT = randomUUID();
const FINANCE = randomUUID(); // AGENT is not a member
const BRAND = randomUUID(); // AGENT is a viewer
const ARCHIVED = randomUUID(); // AGENT is an editor, the space is archived

const PLAYBOOK = { builder: randomUUID(), finance: randomUUID() };
const SUBJECT = {
  content: randomUUID(),
  podWideForBrand: randomUUID(),
  finance: randomUUID(),
};
const PROJECT = { builderHome: randomUUID(), noHome: randomUUID() };
const PARENT = { content: randomUUID(), foreign: randomUUID() };

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    const def =
      c.name === "created_at" ||
      c.name === "updated_at" ||
      c.name === "started_at"
        ? " default now()"
        : c.name === "status" && cfg.name === "focus_sessions"
          ? " default 'active'"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await q(
    `insert into users (id, email, name, user_type, agent_metadata) values
      ($1, 'p@x.test', 'Person', 'human', null),
      ($2, 'a@x.test', 'Agent', 'agent', null),
      ($3, 'f@x.test', 'Focused', 'agent', $5::jsonb),
      ($4, 's@x.test', 'Stranger', 'agent', $6::jsonb)`,
    [
      PERSON,
      AGENT,
      FOCUSED,
      STRANGER,
      JSON.stringify({ focusWorkspaceId: CONTENT }),
      JSON.stringify({ focusWorkspaceId: CONTENT }),
    ]
  );
  for (const [id, archived] of [
    [BUILDER, false],
    [CONTENT, false],
    [FINANCE, false],
    [BRAND, false],
    [ARCHIVED, true],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, archived_at) values ($1, 'Space', $2, $3)`,
      [id, PERSON, archived ? new Date().toISOString() : null]
    );
  }
  for (const [user, ws, role] of [
    [AGENT, BUILDER, "editor"],
    [AGENT, CONTENT, "editor"],
    [AGENT, BRAND, "viewer"],
    [AGENT, ARCHIVED, "editor"],
    [FOCUSED, BUILDER, "editor"],
    [FOCUSED, CONTENT, "editor"],
    [PERSON, BUILDER, "owner"],
    // The person can see the CONTENT subject (the start's subject floor).
    [PERSON, CONTENT, "owner"],
  ] as const) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
      [randomUUID(), ws, user, role]
    );
  }
  for (const [id, ws] of [
    [PLAYBOOK.builder, BUILDER],
    [PLAYBOOK.finance, FINANCE],
  ] as const) {
    await q(
      `insert into playbooks (id, workspace_id, name, created_by) values ($1, $2, 'Ship', $3)`,
      [id, ws, PERSON]
    );
  }
  for (const [id, ws, home] of [
    [SUBJECT.content, CONTENT, null],
    [SUBJECT.podWideForBrand, null, BRAND],
    [SUBJECT.finance, FINANCE, null],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, home_workspace_id, type, title) values ($1, $2, $3, $4, 'task', 'Thing')`,
      [id, PERSON, ws, home]
    );
  }
  for (const [id, home] of [
    [PROJECT.builderHome, BUILDER],
    [PROJECT.noHome, null],
  ] as const) {
    await q(
      `insert into projects (id, user_id, workspace_id, name) values ($1, $2, $3, 'Project')`,
      [id, PERSON, home]
    );
  }
  for (const [id, owner, ws] of [
    [PARENT.content, PERSON, CONTENT],
    [PARENT.foreign, randomUUID(), BUILDER],
  ] as const) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, status, expected_outputs, metadata) values ($1, $2, $3, 'Parent', 'active', '[]'::jsonb, '{}'::jsonb)`,
      [id, owner, ws]
    );
  }
}, 120_000);

const ladder = (ctx: Record<string, unknown>) =>
  resolveSessionWorkspacePlacement(h.db as never, {
    userId: PERSON,
    agentUserId: AGENT,
    ...ctx,
  });

describe("the space ladder — each rung, in order (D1 a)", () => {
  it("explicit wins, unchecked (the membrane decides it, as before)", async () => {
    expect(
      await ladder({
        explicitWorkspaceId: FINANCE,
        playbookId: PLAYBOOK.builder,
      })
    ).toEqual({ workspaceId: FINANCE, rung: "explicit" });
  });

  it("the playbook's space before the subject's", async () => {
    expect(
      await ladder({
        playbookId: PLAYBOOK.builder,
        subjectEntityId: SUBJECT.content,
      })
    ).toEqual({ workspaceId: BUILDER, rung: "playbook" });
  });

  it("the subject's space before the parent's", async () => {
    expect(
      await ladder({
        subjectEntityId: SUBJECT.content,
        parentSessionId: PARENT.content,
        projectId: PROJECT.builderHome,
      })
    ).toEqual({ workspaceId: CONTENT, rung: "subject" });
  });

  it("the parent's space before the project's home", async () => {
    expect(
      await ladder({
        parentSessionId: PARENT.content,
        projectId: PROJECT.builderHome,
      })
    ).toEqual({ workspaceId: CONTENT, rung: "parent" });
  });

  it("the project's home space before the focus", async () => {
    const focus = vi.fn(async () => CONTENT);
    expect(
      await ladder({
        projectId: PROJECT.builderHome,
        focusWorkspaceId: focus,
      })
    ).toEqual({ workspaceId: BUILDER, rung: "project_home" });
    // Read only when every rung above is empty.
    expect(focus).not.toHaveBeenCalled();
  });

  it("the focus, last, when nothing else answers", async () => {
    expect(
      await ladder({
        projectId: PROJECT.noHome,
        focusWorkspaceId: async () => CONTENT,
      })
    ).toEqual({ workspaceId: CONTENT, rung: "focus" });
  });

  it("nothing answers: no space, as before", async () => {
    expect(await ladder({ projectId: PROJECT.noHome })).toEqual({
      workspaceId: null,
      rung: null,
    });
  });
});

describe("a derived rung counts only where the actor may write", () => {
  it("a space the agent is not a member of is skipped (no join proposal)", async () => {
    expect(
      await ladder({
        playbookId: PLAYBOOK.finance,
        subjectEntityId: SUBJECT.finance,
        projectId: PROJECT.builderHome,
      })
    ).toEqual({ workspaceId: BUILDER, rung: "project_home" });
  });

  it("a space where it is only a viewer is skipped", async () => {
    expect(
      await ladder({
        subjectEntityId: SUBJECT.podWideForBrand,
        projectId: PROJECT.builderHome,
      })
    ).toEqual({ workspaceId: BUILDER, rung: "project_home" });
  });

  it("an archived space is skipped", async () => {
    expect(
      await ladder({
        focusWorkspaceId: async () => ARCHIVED,
      })
    ).toEqual({ workspaceId: null, rung: null });
  });

  it("the membership is the AGENT's, not its person's", async () => {
    // PERSON owns BUILDER; STRANGER is a member of nothing.
    expect(
      await ladder({
        agentUserId: STRANGER,
        projectId: PROJECT.builderHome,
      })
    ).toEqual({ workspaceId: null, rung: null });
  });

  it("CONTROL — a pod-wide subject filed for a space it CAN write places there", async () => {
    expect(
      await resolveSessionWorkspacePlacement(h.db as never, {
        userId: PERSON,
        agentUserId: null,
        subjectEntityId: SUBJECT.podWideForBrand,
      })
    ).toEqual({ workspaceId: null, rung: null }); // PERSON is not in BRAND
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
      [randomUUID(), BRAND, PERSON]
    );
    expect(
      await resolveSessionWorkspacePlacement(h.db as never, {
        userId: PERSON,
        agentUserId: null,
        subjectEntityId: SUBJECT.podWideForBrand,
      })
    ).toEqual({ workspaceId: BRAND, rung: "subject" });
  });

  it("another person's parent places nothing", async () => {
    expect(await ladder({ parentSessionId: PARENT.foreign })).toEqual({
      workspaceId: null,
      rung: null,
    });
  });
});

const sessionRow = async (r: unknown) => {
  const id = (r as { session: { id: string } }).session.id;
  return (
    await q(
      `select workspace_id, metadata from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0] as {
    workspace_id: string | null;
    metadata: Record<string, unknown> | null;
  };
};
const start = (over: Record<string, unknown>) =>
  createFocusSession({
    userId: PERSON,
    goal: `Work ${randomUUID()}`,
    matchTemplate: false,
    forceCreate: true,
    ...over,
  });

describe("createFocusSession places the session BEFORE the membrane", () => {
  it("an agent's start filed in a project sits in the project's home space, stamped", async () => {
    h.membrane = [];
    const row = await sessionRow(
      await start({ agentUserId: AGENT, projectId: PROJECT.builderHome })
    );
    expect(row.workspace_id).toBe(BUILDER);
    expect(row.metadata?.workspacePlacement).toEqual({ rung: "project_home" });
    expect(h.membrane).toEqual([{ workspaceId: BUILDER, agentUserId: AGENT }]);
  });

  it("an agent that cannot write the project's home starts with no space: the membrane never sees it", async () => {
    h.membrane = [];
    const row = await sessionRow(
      await start({ agentUserId: STRANGER, projectId: PROJECT.builderHome })
    );
    expect(row.workspace_id).toBeNull();
    expect(row.metadata?.workspacePlacement).toBeUndefined();
    expect(h.membrane).toEqual([
      { workspaceId: undefined, agentUserId: STRANGER },
    ]);
  });

  it("the agent's focus places a start nothing else places", async () => {
    const row = await sessionRow(await start({ agentUserId: FOCUSED }));
    expect(row.workspace_id).toBe(CONTENT);
    expect(row.metadata?.workspacePlacement).toEqual({ rung: "focus" });
  });

  it("a fact beats the focus: the subject's space wins", async () => {
    const row = await sessionRow(
      await start({
        agentUserId: FOCUSED,
        subjectEntityId: SUBJECT.content,
        projectId: PROJECT.builderHome,
      })
    );
    expect(row.workspace_id).toBe(CONTENT);
    expect(row.metadata?.workspacePlacement).toEqual({ rung: "subject" });
  });

  it("an explicit space is kept and stamped explicit", async () => {
    const row = await sessionRow(
      await start({
        agentUserId: FOCUSED,
        workspaceId: BUILDER,
      })
    );
    expect(row.workspace_id).toBe(BUILDER);
    expect(row.metadata?.workspacePlacement).toEqual({ rung: "explicit" });
  });
});

describe("runs follow the ladder, receipts keep the caller's space (D9 a)", () => {
  const runRow = async (sessionId: string) =>
    (
      await q(
        `select workspace_id, metadata from focus_sessions where id = $1`,
        [sessionId]
      )
    ).rows[0] as {
      workspace_id: string | null;
      metadata: Record<string, unknown> | null;
    };

  it("a run filed in a project sits in the project's home space", async () => {
    const { sessionId } = await openRunSession({
      database: h.db as never,
      userId: PERSON,
      agentUserId: AGENT,
      goal: `Run ${randomUUID()}`,
      source: "automation",
      projectId: PROJECT.builderHome,
    });
    const row = await runRow(sessionId);
    expect(row.workspace_id).toBe(BUILDER);
    expect(row.metadata?.workspacePlacement).toEqual({ rung: "project_home" });
  });

  it("a write receipt keeps the caller's space, null included", async () => {
    const { sessionId } = await openRunSession({
      database: h.db as never,
      userId: PERSON,
      agentUserId: AGENT,
      goal: `Receipt ${randomUUID()}`,
      source: "agent-write",
      projectId: PROJECT.builderHome,
      keepCallerWorkspace: true,
    });
    const row = await runRow(sessionId);
    expect(row.workspace_id).toBeNull();
    expect(row.metadata?.workspacePlacement).toBeUndefined();
  });
});

describe("a copied space keeps its source's rung; a move restamps it", () => {
  it("a start that copies a session's space carries that session's rung", async () => {
    const row = await sessionRow(
      await start({
        agentUserId: AGENT,
        workspaceId: CONTENT,
        workspaceRung: "parent",
      })
    );
    expect(row.workspace_id).toBe(CONTENT);
    expect(row.metadata?.workspacePlacement).toEqual({ rung: "parent" });
  });

  it("a deliberate move stamps `explicit`; a move to no space drops the stamp", async () => {
    const res = await start({
      agentUserId: AGENT,
      projectId: PROJECT.builderHome,
    });
    const id = (res as { session: { id: string } }).session.id;
    const move = (workspaceId: string | null) =>
      (h.db as { transaction: (f: (tx: never) => Promise<void>) => Promise<void> })
        .transaction((tx) =>
          applySessionWorkspaceMove(tx, {
            sessionId: id,
            channelId: null,
            workspaceId,
          })
        );
    await move(CONTENT);
    expect((await sessionRow(res)).metadata?.workspacePlacement).toEqual({
      rung: "explicit",
    });
    await move(null);
    const row = await sessionRow(res);
    expect(row.workspace_id).toBeNull();
    expect(row.metadata?.workspacePlacement).toBeUndefined();
  });
});

describe("an adopted receipt is re-homed through the move", () => {
  it("its room follows it into the space the start placed it in", async () => {
    const receipt = randomUUID();
    const room = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, channel_id, goal, status, expected_outputs, metadata)
       values ($1, $2, null, $3, 'Writes', 'active', '[]'::jsonb, '{"kind":"agent-proposal-package","autoOpened":true}'::jsonb)`,
      [receipt, PERSON, room]
    );
    await q(
      `insert into channels (id, user_id, workspace_id, channel_type, scope, status, title, context_object_type, context_object_id)
       values ($1, $2, null, 'group', 'pod', 'active', 'Room', 'focus_session', $3)`,
      [room, PERSON, receipt]
    );
    h.adoptee = { id: receipt };
    try {
      const res = await start({
        agentUserId: AGENT,
        projectId: PROJECT.builderHome,
        clientKey: `agent:${AGENT}|conv:${randomUUID()}`,
      });
      expect((res as { session: { id: string } }).session.id).toBe(receipt);
    } finally {
      h.adoptee = null;
    }
    const row = (
      await q(`select workspace_id, metadata from focus_sessions where id = $1`, [
        receipt,
      ])
    ).rows[0] as { workspace_id: string; metadata: Record<string, unknown> };
    expect(row.workspace_id).toBe(BUILDER);
    expect(row.metadata.workspacePlacement).toEqual({ rung: "project_home" });
    expect(
      (await q(`select workspace_id, scope from channels where id = $1`, [room]))
        .rows[0]
    ).toEqual({ workspace_id: BUILDER, scope: "workspace" });
  });
});

describe("an intake retry reuses the room a mint placed (real ladder)", () => {
  it("the same correlation key, placed by the project's home, lands in one room", async () => {
    const key = `capture:${randomUUID()}`;
    const ask = () =>
      ensureIntakeSession({
        userId: PERSON,
        agentUserId: AGENT,
        projectId: PROJECT.builderHome,
        door: "capture",
        goal: "Capture · a note",
        correlationKey: key,
      });
    const first = await ask();
    expect(first.status).toBe("minted");
    const placed = (
      await q(`select workspace_id from focus_sessions where id = $1`, [
        first.sessionId,
      ])
    ).rows[0] as { workspace_id: string | null };
    expect(placed.workspace_id).toBe(BUILDER);
    const second = await ask();
    expect(second.sessionId).toBe(first.sessionId);
    expect(second).toMatchObject({ status: "minted", reused: true });
  });
});
