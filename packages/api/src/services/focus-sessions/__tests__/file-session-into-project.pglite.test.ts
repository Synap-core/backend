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

  // The MCP URL lens (`?projectId=`) is injected into every tool call's args,
  // so an agent's ordinary update on a project-scoped session arrives carrying
  // the project it is ALREADY in. That is not a filing and must not propose.
  it("the session's CURRENT project is a no-op: not forced, not carried", async () => {
    const projectId = await seedProject(USER);
    const sessionId = await seedSession(projectId);
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      projectId,
      progress: 40,
    });
    expect(res.status).toBe("updated");
    const call = permSpy.mock.calls[0]![0];
    expect(call.forcePropose).toBeUndefined();
    expect((call.data as Record<string, unknown>).projectId).toBeUndefined();
    expect(await projectOf(sessionId)).toBe(projectId);
  });

  it("a DIFFERENT project on a filed session is still a proposed filing", async () => {
    const current = await seedProject(USER);
    const next = await seedProject(USER);
    const sessionId = await seedSession(current);
    permSpy.mockImplementation(async (args) =>
      args.forcePropose
        ? { proposalId: randomUUID(), proposalType: "update" }
        : {}
    );
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      projectId: next,
    });
    expect(res.status).toBe("proposed");
    const call = permSpy.mock.calls[0]![0];
    expect(call.forcePropose).toBe(true);
    expect((call.data as Record<string, unknown>).projectId).toBe(next);
    expect(await projectOf(sessionId)).toBe(current);
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

/**
 * Same door, same rule as the project no-op above, for CRITERIA: they reach the
 * membrane only when they DIFFER from the stored list. An MCP `outcomes` attach
 * re-sends the whole merged list even when it left the criteria untouched; an
 * agent changing a criterion is still proposed. The stub mirrors the gate's own
 * predicate (`isFocusSessionCriteriaUpdate`: an AI write CARRYING `criteria`
 * proposes) — the gate's half is proven in
 * `utils/permission-check.focus-session-criteria.test.ts`; this pins the door's.
 */
describe("criteria reach the membrane only when they change", () => {
  const C1 = {
    key: "report",
    statement: "A report exists",
    check: { kind: "human" },
  };
  const C2 = {
    key: "tests",
    statement: "Tests pass",
    check: { kind: "human" },
  };

  async function seedWithCriteria(): Promise<string> {
    const sessionId = await seedSession();
    await q(
      `update focus_sessions set criteria = $2::jsonb, expected_outputs = $3::jsonb where id = $1`,
      [
        sessionId,
        JSON.stringify([C1, C2]),
        JSON.stringify([
          { kind: "document", label: "Brief", status: "pending" },
        ]),
      ]
    );
    return sessionId;
  }
  const row = async (sessionId: string) =>
    (
      await q<{
        criteria: unknown;
        expected_outputs: Array<Record<string, unknown>>;
      }>(
        `select criteria, expected_outputs from focus_sessions where id = $1`,
        [sessionId]
      )
    ).rows[0]!;

  beforeEach(() => {
    permSpy.mockImplementation(async (args) =>
      args.agentUserId &&
      (args.data as Record<string, unknown> | undefined)?.criteria !== undefined
        ? { proposalId: randomUUID(), proposalType: "update" }
        : {}
    );
  });

  it("an agent's outcome attach re-sending UNCHANGED criteria applies — no proposal", async () => {
    const sessionId = await seedWithCriteria();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      // The merged list, in a different order: still the same contract.
      criteria: [C2, C1] as never,
      completeOutput: "Brief",
    });
    expect(res.status).toBe("updated");
    const gate = permSpy.mock.calls[0]![0].data as Record<string, unknown>;
    expect(gate.criteria).toBeUndefined();
    expect(gate.completeOutput).toBe("Brief");
    expect((await row(sessionId)).expected_outputs[0]!.claimedDone).toBe(true);
  });

  it("an agent CHANGING a criterion is still proposed, and nothing is written", async () => {
    const sessionId = await seedWithCriteria();
    const changed = [{ ...C1, statement: "A signed report exists" }, C2];
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      criteria: changed as never,
    });
    expect(res.status).toBe("proposed");
    const gate = permSpy.mock.calls[0]![0].data as Record<string, unknown>;
    expect(gate.criteria).toEqual(changed);
    expect((await row(sessionId)).criteria).toEqual([C1, C2]);
  });

  it("an unchanged list never overwrites a criteria change approved meanwhile", async () => {
    const sessionId = await seedWithCriteria();
    const approved = [{ ...C1, statement: "A signed report exists" }, C2];
    // The membrane runs between the door's (unlocked) load and its write: a
    // person approving a criteria proposal lands exactly there.
    permSpy.mockImplementationOnce(async () => {
      await q(`update focus_sessions set criteria = $2::jsonb where id = $1`, [
        sessionId,
        JSON.stringify(approved),
      ]);
      return {};
    });
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      // The agent's stale copy of the list it loaded, re-sent unchanged.
      criteria: [C1, C2] as never,
      completeOutput: "Brief",
    });
    expect(res.status).toBe("updated");
    expect((await row(sessionId)).criteria).toEqual(approved);
    expect((await row(sessionId)).expected_outputs[0]!.claimedDone).toBe(true);
  });

  it("MCP synap_update_session `outcomes` adding an output, criteria untouched — applied, no proposal", async () => {
    const sessionId = await seedWithCriteria();
    const { sessionHandlers } =
      await import("../../../routers/mcp/handlers/session.js");
    const out = await sessionHandlers.synap_update_session!({
      toolName: "synap_update_session",
      args: {
        sessionId,
        outcomes: [{ key: "summary", label: "Summary", kind: "document" }],
      },
      userId: USER,
      agentUserId: AGENT,
      apiKeyScopes: ["mcp.write", "mcp.read"],
      workspaceAccessible: false,
      caller: {} as never,
      lensCaller: {} as never,
    } as never);
    const text = (out.content[0] as { text: string }).text;
    expect(text).not.toMatch(/proposalId|"error"/);
    // Through `resolveOutcomesUpdate` the handler re-sends the merged criteria
    // list; the door drops it as unchanged, so the gate never sees criteria.
    const gate = permSpy.mock.calls.at(-1)![0].data as Record<string, unknown>;
    expect(gate.criteria).toBeUndefined();
    const after = await row(sessionId);
    expect(after.criteria).toEqual([C1, C2]);
    expect(after.expected_outputs.map((o) => o.label)).toEqual([
      "Brief",
      "Summary",
    ]);
  });

  it("a person changing their own criteria writes them directly (unchanged path)", async () => {
    const sessionId = await seedWithCriteria();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      criteria: [C1] as never,
    });
    expect(res.status).toBe("updated");
    expect((await row(sessionId)).criteria).toEqual([C1]);
  });
});

/**
 * A filing never carries a goal it does not change, and approving an OLDER
 * proposal never writes a stale goal back (`session-update-goal.ts`). Seen live
 * 2026-10-20: every filing copied the session's current goal "so summaries
 * resolve", the review diff showed "Goal: update" for nothing, and approving
 * an older filing put a replaced goal back. Driven through the real door and
 * the real executor; the title is the REAL `buildProposalSummary` on the gate
 * payload the door built.
 */
describe("a filing carries the session's name, not its goal", () => {
  const goalOf = async (sessionId: string) =>
    (
      await q<{ goal: string }>(
        `select goal from focus_sessions where id = $1`,
        [sessionId]
      )
    ).rows[0]!.goal;
  const summaryOf = async (gate: Record<string, unknown>) => {
    const { buildProposalSummary } = await vi.importActual<
      typeof import("../../../utils/permission-check.js")
    >("../../../utils/permission-check.js");
    return buildProposalSummary("focus_session", "update", gate);
  };

  beforeEach(() => {
    permSpy.mockImplementation(async (args) =>
      args.forcePropose
        ? { proposalId: randomUUID(), proposalType: "update" }
        : {}
    );
  });

  it("approving an older filing keeps a goal changed since", async () => {
    const sessionId = await seedSession();
    const projectId = await seedProject(USER);
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      projectId,
    });
    expect(res.status).toBe("proposed");
    const gate = permSpy.mock.calls[0]![0].data as Record<string, unknown>;
    expect(gate).not.toHaveProperty("goal");
    expect(gate).not.toHaveProperty("previousGoal");
    expect(gate.sessionName).toBe("Shell work");
    expect(await summaryOf(gate)).toBe(
      'File session "Shell work" into "Synap"'
    );

    // The person re-goals the session after the filing was proposed.
    await updateFocusSession({
      sessionId,
      userId: USER,
      goal: "Win the first clients",
    });

    const out = (await approve(sessionId, gate)) as { refusals?: string[] };
    expect(await projectOf(sessionId)).toBe(projectId);
    expect(await goalOf(sessionId)).toBe("Win the first clients");
    expect(out.refusals).toBeUndefined();
  });

  // A goal change is not a filing: the stub proposes every agent write here
  // so the goal change itself is the proposal under test.
  const proposeEveryAgentWrite = () =>
    permSpy.mockImplementation(async (args) =>
      args.agentUserId
        ? { proposalId: randomUUID(), proposalType: "update" }
        : {}
    );

  it("a goal change carries the goal it replaces, and approval applies it", async () => {
    proposeEveryAgentWrite();
    const sessionId = await seedSession();
    await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      goal: "Map the commercial foundations",
    });
    const gate = permSpy.mock.calls[0]![0].data as Record<string, unknown>;
    expect(gate.goal).toBe("Map the commercial foundations");
    expect(gate.previousGoal).toBe("Ship the work shell");
    // Named by what the reviewer knows it as, not by the goal it is changing.
    expect(await summaryOf(gate)).toBe('Update Session "Shell work"');

    await approve(sessionId, gate);
    expect(await goalOf(sessionId)).toBe("Map the commercial foundations");
  });

  it("an older goal change never overwrites a goal changed since, and says so", async () => {
    proposeEveryAgentWrite();
    const sessionId = await seedSession();
    await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      goal: "The older plan",
    });
    const gate = permSpy.mock.calls[0]![0].data as Record<string, unknown>;
    await updateFocusSession({
      sessionId,
      userId: USER,
      goal: "The newer plan",
    });

    const out = (await approve(sessionId, gate)) as { refusals?: string[] };
    expect(await goalOf(sessionId)).toBe("The newer plan");
    expect(out.refusals).toEqual([
      expect.stringMatching(/goal changed after this proposal was filed/),
    ]);
  });

  it("a payload filed before the rule (copied goal, no previousGoal) never reverts the goal", async () => {
    const sessionId = await seedSession();
    const projectId = await seedProject(USER);
    // The pre-fix wire shape: the goal copied at filing time, since replaced.
    const out = (await approve(sessionId, {
      id: sessionId,
      goal: "Founder 2026-10-20: Radar is removed",
      projectId,
    })) as { refusals?: string[] };
    expect(await goalOf(sessionId)).toBe("Ship the work shell");
    expect(await projectOf(sessionId)).toBe(projectId);
    expect(out.refusals).toEqual([
      expect.stringMatching(/filed before goal changes were tracked/),
    ]);

    // A copied goal that still matches is a no-op, not a refusal.
    const quiet = (await approve(sessionId, {
      id: sessionId,
      goal: "Ship the work shell",
      projectId: null,
    })) as { refusals?: string[] };
    expect(quiet.refusals).toBeUndefined();
    expect(await projectOf(sessionId)).toBeNull();
  });
});

/**
 * F2 — an agent's FILING is its own proposal (`session-filing-gate.ts`); the
 * rest of the same call takes the ordinary decision. Before, the filing forced
 * the WHOLE update to a proposal, so a rename or progress tick sent with it
 * waited on a person, and rode through on the filing's approval unnamed.
 */
describe("a filing is proposed on its own; the rest of the call is not held", () => {
  const rowOf = async (sessionId: string) =>
    (
      await q<{
        title: string | null;
        progress: number;
        project_id: string | null;
      }>(
        `select title, progress, project_id from focus_sessions where id = $1`,
        [sessionId]
      )
    ).rows[0]!;

  beforeEach(() => {
    // The ladder's shape for an agent: a forced filing proposes, an ordinary
    // rename / progress tick is granted.
    permSpy.mockImplementation(async (args) =>
      args.forcePropose
        ? { proposalId: randomUUID(), proposalType: "update" }
        : {}
    );
  });

  it("an agent's rename + progress land now; only the filing waits, named", async () => {
    const sessionId = await seedSession();
    const projectId = await seedProject(USER);
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      projectId,
      title: "Renamed shell work",
      progress: 55,
    });
    expect(res.status).toBe("updated");
    if (res.status !== "updated") throw new Error("unreachable");
    expect(res.filing).toMatchObject({ status: "proposed" });

    const [filingCall, restCall] = permSpy.mock.calls.map((c) => c[0]);
    expect(permSpy).toHaveBeenCalledTimes(2);
    expect(filingCall!.forcePropose).toBe(true);
    const filingGate = filingCall!.data as Record<string, unknown>;
    expect(Object.keys(filingGate).sort()).toEqual(
      ["id", "projectId", "projectName", "sessionName"].sort()
    );
    expect(restCall!.forcePropose).toBeUndefined();
    const restGate = restCall!.data as Record<string, unknown>;
    expect(restGate).toMatchObject({
      title: "Renamed shell work",
      progress: 55,
    });
    expect(restGate).not.toHaveProperty("projectId");

    const { buildProposalSummary } = await vi.importActual<
      typeof import("../../../utils/permission-check.js")
    >("../../../utils/permission-check.js");
    expect(buildProposalSummary("focus_session", "update", filingGate)).toBe(
      'File session "Shell work" into "Synap"'
    );

    let row = await rowOf(sessionId);
    expect(row.title).toBe("Renamed shell work");
    expect(row.progress).toBe(55);
    expect(row.project_id).toBeNull();

    await approve(sessionId, filingGate);
    row = await rowOf(sessionId);
    expect(row.project_id).toBe(projectId);
    expect(row.title).toBe("Renamed shell work");
  });

  it("a person's own filing with a rename is one write, never forced", async () => {
    const sessionId = await seedSession();
    const projectId = await seedProject(USER);
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      projectId,
      title: "Mine",
    });
    expect(res.status).toBe("updated");
    expect(permSpy).toHaveBeenCalledTimes(1);
    const row = await rowOf(sessionId);
    expect(row.project_id).toBe(projectId);
    expect(row.title).toBe("Mine");
  });
});

/**
 * FB1020 B3 — an agent filing its OWN FRESH session into the project it was
 * told to focus on reaches the pod's own-organise class row (the engine is
 * mocked to answer as the class row does: granted, with a receipt). Real door,
 * real `isOwnFreshWork` over the session row (`metadata.clientKey` names the
 * calling key), real undo stamp.
 *
 * Rows that rule out a wrong rule: a filing ALONE is ONE receipt (rules out a
 * second, empty receipt beside it) whose Undo restores the project; a filing
 * WITH a rename keeps two decisions and the filing's receipt still undoes the
 * project only; a session bound to ANOTHER key keeps the old forced proposal.
 */
describe("B3: an agent files its own fresh session — one receipt, with Undo", () => {
  const KEY = randomUUID();

  async function ownSession(key = KEY): Promise<string> {
    const id = await seedSession();
    await q(
      `update focus_sessions set metadata = $2::jsonb, created_at = now() where id = $1`,
      [id, JSON.stringify({ clientKey: `key:${key}|conv:c1` })]
    );
    return id;
  }
  async function receipt(): Promise<string> {
    const id = randomUUID();
    await q(
      `insert into proposals (id, target_type, target_id, proposal_type, status, data)
       values ($1,'focus_session',$1,'focus_session.update','auto_approved','{}'::jsonb)`,
      [id]
    );
    return id;
  }
  const rowPatchesOf = async (id: string) =>
    (
      await q<{ data: { materialized?: { rowPatches?: unknown[] } } }>(
        `select data from proposals where id = $1`,
        [id]
      )
    ).rows[0]!.data.materialized?.rowPatches;

  async function asAgent<T>(fn: () => Promise<T>): Promise<T> {
    const { runWithCallingKey } = await import("@synap/database");
    return runWithCallingKey(KEY, fn);
  }

  async function focusOn(projectId: string) {
    await q(`delete from users where id = $1`, [AGENT]);
    await q(
      `insert into users (id, name, email, user_type, agent_metadata) values ($1,'Claude Code','a@x','agent',$2::jsonb)`,
      [
        AGENT,
        JSON.stringify({ agentType: "claude-code", focusProjectId: projectId }),
      ]
    );
  }

  it("a filing alone: the proof reaches the class, ONE receipt, project filed, Undo stamped", async () => {
    const projectId = await seedProject(USER);
    await focusOn(projectId);
    const sessionId = await ownSession();
    const r1 = await receipt();
    permSpy.mockImplementation(async (args) =>
      args.ownWorkOrganise
        ? { granted: true, autoApprovedProposalId: r1 }
        : args.forcePropose
          ? { proposalId: randomUUID(), proposalType: "update" }
          : { granted: true }
    );
    const res = await asAgent(() =>
      updateFocusSession({
        sessionId,
        userId: USER,
        agentUserId: AGENT,
        projectId,
      })
    );
    expect(res.status).toBe("updated");
    expect(permSpy).toHaveBeenCalledTimes(1);
    expect(permSpy.mock.calls[0]![0]).toMatchObject({
      forcePropose: false,
      ownWorkOrganise: true,
    });
    expect(await projectOf(sessionId)).toBe(projectId);
    expect(await rowPatchesOf(r1)).toEqual([
      {
        kind: "focus_session",
        id: sessionId,
        before: { projectId: null },
        after: { projectId },
      },
    ]);
  });

  it("a filing with a rename: two decisions; the filing's receipt undoes the project only", async () => {
    const projectId = await seedProject(USER);
    await focusOn(projectId);
    const sessionId = await ownSession();
    const r1 = await receipt();
    const r2 = await receipt();
    permSpy.mockImplementation(async (args) =>
      args.ownWorkOrganise
        ? { granted: true, autoApprovedProposalId: r1 }
        : { granted: true, autoApprovedProposalId: r2 }
    );
    await asAgent(() =>
      updateFocusSession({
        sessionId,
        userId: USER,
        agentUserId: AGENT,
        projectId,
        title: "Renamed",
      })
    );
    expect(permSpy).toHaveBeenCalledTimes(2);
    expect(await rowPatchesOf(r1)).toEqual([
      {
        kind: "focus_session",
        id: sessionId,
        before: { projectId: null },
        after: { projectId },
      },
    ]);
  });

  it("a session bound to ANOTHER key keeps the forced proposal", async () => {
    const projectId = await seedProject(USER);
    await focusOn(projectId);
    const sessionId = await ownSession(randomUUID());
    permSpy.mockImplementation(async () => ({
      proposalId: randomUUID(),
      proposalType: "update",
    }));
    const res = await asAgent(() =>
      updateFocusSession({
        sessionId,
        userId: USER,
        agentUserId: AGENT,
        projectId,
      })
    );
    expect(res.status).toBe("proposed");
    expect(permSpy.mock.calls[0]![0]).toMatchObject({ forcePropose: true });
    expect(await projectOf(sessionId)).toBeNull();
  });
});
