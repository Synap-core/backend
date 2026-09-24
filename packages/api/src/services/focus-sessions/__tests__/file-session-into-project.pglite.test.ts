/**
 * FILING a session into a project — driven through the REAL service
 * (`updateFocusSession`, the MCP door's) and the REAL `focus_session/update`
 * executor on PGlite, never a hand-built object.
 *
 * The rules under test:
 *  - a person files and unfiles their own session directly;
 *  - a project the caller cannot see is refused BEFORE governance;
 *  - an AGENT's filing is always a proposal (`forcePropose`), and the proposal
 *    carries `projectId`, so approving it lands the filing (not a no-op);
 *  - approval re-floors the target, so a project that became invisible is
 *    refused instead of written.
 *
 * Stubbed, as in the sibling suite: `checkPermissionOrPropose` (the ladder has
 * its own suites; the stub records the call so `forcePropose` is asserted),
 * channel mint, realtime emit, block guidance.
 *
 * NOT covered, measured: the tRPC door's own writer (it shares
 * `loadVisibleProject` but builds its own `set`; typecheck only).
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
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: permSpy,
  proposedMessageFor: (_t: unknown, fallback: string) => fallback,
}));
vi.mock("../ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: vi.fn(async () => undefined),
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { updateFocusSession } from "../update-session.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";

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
const OTHER = "user-2";
const AGENT = randomUUID();

async function seedSession(projectId: string | null = null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, project_id, expected_outputs, criteria, metadata, agent_ids, started_at, updated_at)
     values ($1, $2, 'Shell work', 'Ship the work shell', 'active', 'human', $3,
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now())`,
    [id, USER, projectId]
  );
  return id;
}

async function seedProject(owner: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, 'Synap', 'active', now(), now())`,
    [id, owner]
  );
  return id;
}

const projectOf = async (sessionId: string) =>
  (
    await q<{ project_id: string | null }>(
      `select project_id from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.project_id;

async function approve(sessionId: string, gate: Record<string, unknown>) {
  const executor = proposalExecRegistry.resolveExact("focus_session/update")!;
  return executor.execute({
    proposal: {
      id: randomUUID(),
      targetId: sessionId,
      workspaceId: null,
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
    "delete from focus_sessions; delete from projects; delete from proposals;"
  );
  permSpy.mockClear();
  permSpy.mockImplementation(async () => ({}));
});

describe("a person files their own session", () => {
  it("files it into a visible project", async () => {
    const sessionId = await seedSession();
    const projectId = await seedProject(USER);
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      projectId,
    });
    expect(res.status).toBe("updated");
    expect(await projectOf(sessionId)).toBe(projectId);
  });

  it("unfiles it with an explicit null, and leaves it alone when omitted", async () => {
    const projectId = await seedProject(USER);
    const sessionId = await seedSession(projectId);
    await updateFocusSession({ sessionId, userId: USER, progress: 10 });
    expect(await projectOf(sessionId)).toBe(projectId);
    await updateFocusSession({ sessionId, userId: USER, projectId: null });
    expect(await projectOf(sessionId)).toBeNull();
  });

  it("refuses a project the caller cannot see, before governance", async () => {
    const sessionId = await seedSession();
    const foreign = await seedProject(OTHER);
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      projectId: foreign,
    });
    expect(res.status).toBe("denied");
    expect(permSpy).not.toHaveBeenCalled();
    expect(await projectOf(sessionId)).toBeNull();
  });
});

describe("an agent can only PROPOSE a filing", () => {
  it("forces a proposal whose payload carries projectId, and approval lands it", async () => {
    const sessionId = await seedSession();
    const projectId = await seedProject(USER);
    permSpy.mockImplementation(async (args) =>
      args.forcePropose
        ? { proposalId: randomUUID(), proposalType: "update" }
        : {}
    );

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      projectId,
    });
    expect(res.status).toBe("proposed");
    const call = permSpy.mock.calls[0]![0];
    expect(call.forcePropose).toBe(true);
    const gate = call.data as Record<string, unknown>;
    expect(gate.projectId).toBe(projectId);
    // Display-only name so the proposal title can say WHERE (never applied).
    expect(gate.projectName).toBe("Synap");
    expect(await projectOf(sessionId)).toBeNull();

    await approve(sessionId, gate);
    expect(await projectOf(sessionId)).toBe(projectId);
  });

  it("an update that does not touch the project is not forced", async () => {
    const sessionId = await seedSession();
    await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      progress: 40,
    });
    expect(permSpy.mock.calls[0]![0].forcePropose).toBeUndefined();
  });

  it("approval re-floors: a project no longer visible is refused, not written", async () => {
    const sessionId = await seedSession();
    const foreign = await seedProject(OTHER);
    await expect(
      approve(sessionId, { id: sessionId, goal: "Ship", projectId: foreign })
    ).rejects.toThrow(/not visible/);
    expect(await projectOf(sessionId)).toBeNull();
  });
});
