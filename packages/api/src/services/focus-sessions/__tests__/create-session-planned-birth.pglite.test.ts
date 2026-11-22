/**
 * BIRTH STATUS (founder P4) and a step's TIME (B5) on the session door —
 * `createFocusSession` (what `synap_start_session` and the capture plan call),
 * on the DIRECT path and on the PROPOSED path (proposal data → the real
 * `focus_session/create` executor). Reachability: the row's stored `status`
 * and `metadata` are read back from PGlite.
 *
 * Stubs as `create-session-cross-blockers.pglite.test.ts` (same harness):
 * the governance membrane, the endpoint floors and unrelated side effects.
 *
 * Each case names the WRONG rule it rules out.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  perm: (async () => ({ granted: true })) as (
    opts: Record<string, unknown>
  ) => Promise<unknown>,
  permCalls: [] as Array<Record<string, unknown>>,
  hidden: new Set<string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        focusSessions: actual.focusSessions as never,
        playbooks: actual.playbooks as never,
      },
    }),
    recordSessionSpawn: async () => ({
      linked: true,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: (opts: Record<string, unknown>) => {
      h.permCalls.push(opts);
      return h.perm(opts);
    },
  };
});

vi.mock(
  "../../../routers/hub-protocol/rest/link-endpoint-visibility.js",
  () => ({
    checkLinkEndpointsVisible: async (edge: { toId: string }) =>
      h.hidden.has(edge.toId)
        ? { status: 404 as const, error: "Entity not found" }
        : null,
    checkLinkEndpointVisible: async () => null,
  })
);

vi.mock("../../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: async () => undefined,
}));

vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionChannel: async () => null };
});

vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  proposals,
  links,
  playbooks,
  users,
  lifecycleTransitionOutbox,
} from "@synap/database";
import { createFocusSession } from "../create-session.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";

const USER = "user-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const stored = (id: string) =>
  q<{ status: string; metadata: Record<string, unknown> }>(
    `select status, metadata from focus_sessions where id = $1`,
    [id]
  ).then((r) => r.rows[0]!);

describe("createFocusSession — a step that waits is born planned", () => {
  beforeAll(async () => {
    for (const t of [
      lifecycleTransitionOutbox,
      focusSessions,
      proposals,
      links,
      playbooks,
      users,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      `create unique index idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type);`
    );
    registerFocusSessionExecutors();
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(async () => {
    await h.client!.exec(
      "delete from focus_sessions; delete from proposals; delete from links;"
    );
    h.permCalls.length = 0;
    h.hidden.clear();
    h.perm = async () => ({ granted: true });
  });

  it("DIRECT: blockers => forming; startNow => active; nothing to wait on => active", async () => {
    const decision = randomUUID();
    const planned = await createFocusSession({
      userId: USER,
      goal: "send the term sheet",
      blockedByEntityIds: [decision],
    });
    const now = await createFocusSession({
      userId: USER,
      goal: "send the deck now",
      blockedByEntityIds: [decision],
      startNow: true,
    });
    const free = await createFocusSession({ userId: USER, goal: "free work" });
    if (
      planned.status !== "created" ||
      now.status !== "created" ||
      free.status !== "created"
    ) {
      throw new Error("not created");
    }
    // Rules out: "every step is born active" (the 14 manual pauses).
    expect((await stored(planned.session.id)).status).toBe("forming");
    expect((await stored(now.session.id)).status).toBe("active");
    // Rules out: "every new session is planned".
    expect((await stored(free.session.id)).status).toBe("active");
  });

  it("DIRECT: a later plannedFor alone waits too; its time lands on metadata", async () => {
    const res = await createFocusSession({
      userId: USER,
      goal: "board meeting",
      plannedFor: "2099-03",
      dueBy: "2099-03-31",
    });
    if (res.status !== "created") throw new Error("not created");
    const row = await stored(res.session.id);
    expect(row.status).toBe("forming");
    expect(row.metadata).toMatchObject({
      plannedFor: "2099-03",
      dueBy: "2099-03-31",
    });
  });

  it("the plan door's awaitsBlockers births it planned before its edges exist", async () => {
    const res = await createFocusSession({
      userId: USER,
      goal: "plan step",
      awaitsBlockers: true,
    });
    if (res.status !== "created") throw new Error("not created");
    expect((await stored(res.session.id)).status).toBe("forming");
  });

  it("a malformed date is refused in words, nothing written", async () => {
    await expect(
      createFocusSession({ userId: USER, goal: "bad", plannedFor: "soon" })
    ).rejects.toThrow(/plannedFor must be a month/);
    const n = await q<{ n: number }>(
      `select count(*)::int as n from focus_sessions`
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it("PROPOSED: the birth and the time ride the proposal and land at approval", async () => {
    const decision = randomUUID();
    h.perm = async (opts) =>
      opts.subjectType === "focus_session"
        ? { proposalId: "prop-session-1", proposalType: "create" }
        : { granted: true };
    const proposed = await createFocusSession({
      userId: USER,
      agentUserId: "agent-1",
      goal: "planned via a proposal",
      blockedByEntityIds: [decision],
      dueBy: "2099-01-15",
    });
    expect(proposed.status).toBe("proposed");
    const data = h.permCalls.find((c) => c.subjectType === "focus_session")!
      .data as Record<string, unknown>;
    expect(data).toMatchObject({ dueBy: "2099-01-15" });

    const proposalId = randomUUID();
    const targetId = randomUUID();
    await q(
      `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_at, updated_at)
       values ($1, 'pending', 'create', 'focus_session', $2, $3::jsonb, now(), now())`,
      [proposalId, targetId, JSON.stringify({ data })]
    );
    const result = await proposalExecRegistry
      .resolveExact("focus_session/create")!
      .execute({
        proposal: {
          id: proposalId,
          targetId,
          workspaceId: null,
          projectId: null,
          subjectUserId: USER,
          data: { data },
          targetType: "focus_session",
          proposalType: "create",
        },
        payload: null,
        userId: USER,
        input: { proposalId },
        ctx: {},
        deps: {
          emitProposalReviewed: () => undefined,
          reportProposalOutcome: () => undefined,
        },
      } as never);
    expect(result.success).toBe(true);
    const row = await stored(targetId);
    // Rules out: "the approved row is born active whatever the start said".
    expect(row.status).toBe("forming");
    expect(row.metadata).toMatchObject({ dueBy: "2099-01-15" });
  });
});
