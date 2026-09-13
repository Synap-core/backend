/**
 * Create-time `title`, parent (`spawned_from`) and `blockedBySessionIds`
 * (`blocked_by`) ARRIVE — on the DIRECT path (`createFocusSession`) and on the
 * PROPOSED path (proposal data → the real `focus_session/create` executor).
 * Reachability, not shape: rows and edges are read back from PGlite.
 *
 * Real: `createFocusSession`, `addCreateTimeBlockers`, `validateSessionBlocker`
 * + `addSessionBlocker` (the owner floor), the registered executor. Tables are
 * generated from the Drizzle definitions.
 *
 * Stubbed, and why:
 *  - `recordSessionSpawn` — lives on `@synap/database`'s own connection (its
 *    producer is covered by `session-spawn.test.ts`); stubbed per test so the
 *    SEAM under test — does its outcome reach the caller — is driven.
 *  - `checkPermissionOrPropose` — the governance membrane is its own suite;
 *    here it grants or proposes on demand so both paths are reachable.
 *  - `resolveSessionProjectPlacement`, `ensureSessionChannel`, realtime emit —
 *    unrelated side effects with their own connections.
 *
 * NOT covered: the tRPC / Hub REST / MCP create doors' argument plumbing
 * (typecheck only), and the approver≠owner floor-out on the proposed path.
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
  spawn: (async () => ({
    linked: true,
    suspendedIntentRecorded: false,
  })) as (input: Record<string, unknown>) => Promise<unknown>,
  perm: (async () => ({ granted: true })) as (
    opts: Record<string, unknown>
  ) => Promise<unknown>,
  permCalls: [] as Array<Record<string, unknown>>,
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
    recordSessionSpawn: (input: Record<string, unknown>) => h.spawn(input),
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

vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionChannel: async () => null };
});

vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, proposals, links, playbooks } from "@synap/database";
import { createFocusSession } from "../create-session.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";

const USER = "user-1";
const OTHER = "user-2";
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

async function seedSession(user: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'blocker', 'active', '[]'::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [id, user]
  );
  return id;
}

const blockedByEdges = (sessionId: string) =>
  q<{ to_id: string }>(
    `select to_id from links where link_type = 'blocked_by' and from_id = $1`,
    [sessionId]
  ).then((r) => r.rows.map((x) => x.to_id));

describe("createFocusSession — title, parent and blockers at birth", () => {
  beforeAll(async () => {
    for (const t of [focusSessions, proposals, links, playbooks]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    // `addSessionBlocker`'s ON CONFLICT target needs its unique index.
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
    h.perm = async () => ({ granted: true });
    h.spawn = async () => ({ linked: true, suspendedIntentRecorded: false });
  });

  it("stores the one-lined title; a title over 200 characters is refused", async () => {
    const res = await createFocusSession({
      userId: USER,
      title: "  Billing\n launch ",
      goal: "Ship billing to every customer",
    });
    expect(res.status).toBe("created");
    const id = res.status === "created" ? res.session.id : "";
    const { rows } = await q<{ title: string | null }>(
      `select title from focus_sessions where id = $1`,
      [id]
    );
    expect(rows).toEqual([{ title: "Billing launch" }]);

    await expect(
      createFocusSession({ userId: USER, title: "x".repeat(201), goal: "g" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a parent that cannot be linked is REPORTED, not silently dropped", async () => {
    const parentSessionId = randomUUID();
    h.spawn = async () => ({ linked: false, reason: "parent_not_found" });
    const missed = await createFocusSession({
      userId: USER,
      goal: "child",
      parentSessionId,
    });
    expect(missed).toMatchObject({
      status: "created",
      parentLink: {
        status: "failed",
        parentSessionId,
        reason: "parent_not_found",
      },
    });

    h.spawn = async () => {
      throw new Error("transport blip");
    };
    const thrown = await createFocusSession({
      userId: USER,
      goal: "child 2",
      parentSessionId,
    });
    expect(thrown).toMatchObject({
      status: "created",
      parentLink: {
        status: "failed",
        reason: "error",
        message: "transport blip",
      },
    });

    h.spawn = async () => ({ linked: true, suspendedIntentRecorded: true });
    const linked = await createFocusSession({
      userId: USER,
      goal: "child 3",
      parentSessionId,
      suspendedIntent: "was drafting",
    });
    expect(linked).toMatchObject({
      parentLink: { status: "linked", suspendedIntentRecorded: true },
    });
  });

  it("writes blocked_by for an owned blocker and refuses a stranger's, per id", async () => {
    const mine = await seedSession(USER);
    const theirs = await seedSession(OTHER);
    const res = await createFocusSession({
      userId: USER,
      goal: "waits on two",
      blockedBySessionIds: [mine, theirs],
    });
    expect(res.status).toBe("created");
    if (res.status !== "created") return;
    expect(res.blockerLinks).toEqual([
      { blockerSessionId: mine, status: "linked", inserted: 1 },
      { blockerSessionId: theirs, status: "failed", reason: "not_found" },
    ]);
    expect(await blockedByEdges(res.session.id)).toEqual([mine]);
  });

  it("an AGENT's create-time blocker is judged like POST /links — and may be proposed", async () => {
    const mine = await seedSession(USER);
    h.perm = async (opts) =>
      opts.subjectType === "link"
        ? { proposalId: "prop-link-1", proposalType: "create" }
        : { granted: true };
    const res = await createFocusSession({
      userId: USER,
      agentUserId: "agent-1",
      goal: "agent opened",
      blockedBySessionIds: [mine],
    });
    expect(res).toMatchObject({
      status: "created",
      blockerLinks: [
        {
          blockerSessionId: mine,
          status: "proposed",
          proposalId: "prop-link-1",
        },
      ],
    });
    const linkCall = h.permCalls.find((c) => c.subjectType === "link");
    expect(linkCall).toMatchObject({
      userId: USER,
      agentUserId: "agent-1",
      action: "create",
      data: { linkType: "blocked_by", toId: mine },
    });
    if (res.status === "created") {
      expect(await blockedByEdges(res.session.id)).toEqual([]);
    }
  });

  it("PROPOSED path: title, parent and blockers ride the proposal and land at approval", async () => {
    const mine = await seedSession(USER);
    const theirs = await seedSession(OTHER);
    const parentSessionId = randomUUID();
    h.perm = async (opts) =>
      opts.subjectType === "focus_session"
        ? { proposalId: "prop-session-1", proposalType: "create" }
        : { granted: true };

    const proposed = await createFocusSession({
      userId: USER,
      agentUserId: "agent-1",
      title: "Billing launch",
      goal: "Ship billing",
      parentSessionId,
      blockedBySessionIds: [mine, theirs],
    });
    expect(proposed.status).toBe("proposed");
    const data = h.permCalls.find((c) => c.subjectType === "focus_session")!
      .data as Record<string, unknown>;
    expect(data).toMatchObject({
      title: "Billing launch",
      parentSessionId,
      blockedBySessionIds: [mine, theirs],
    });

    const proposalId = randomUUID();
    const targetId = randomUUID();
    await q(
      `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_at, updated_at)
       values ($1, 'pending', 'create', 'focus_session', $2, $3::jsonb, now(), now())`,
      [proposalId, targetId, JSON.stringify({ data })]
    );
    h.spawn = async () => ({ linked: false, reason: "parent_not_found" });
    const executor = proposalExecRegistry.resolveExact("focus_session/create")!;
    const result = await executor.execute({
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

    const { rows } = await q<{ title: string | null }>(
      `select title from focus_sessions where id = $1`,
      [targetId]
    );
    expect(rows).toEqual([{ title: "Billing launch" }]);
    expect(await blockedByEdges(targetId)).toEqual([mine]);
    expect(result.success).toBe(true);
    expect(result.refusals).toEqual([
      expect.stringContaining(
        `Parent session ${parentSessionId} was not linked`
      ),
      expect.stringContaining(
        `Blocker session ${theirs} was not linked (not_found)`
      ),
    ]);
  });
});
