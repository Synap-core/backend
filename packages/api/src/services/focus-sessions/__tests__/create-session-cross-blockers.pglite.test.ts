/**
 * A session BORN waiting on a decision (entity) or a goal — `blockedByEntityIds`
 * / `blockedByTrackIds` on `createFocusSession` (the door `synap_start_session`
 * calls) ARRIVE as `session --blocked_by--> entity | track` edges, on the
 * DIRECT path and on the PROPOSED path (proposal data → the real
 * `focus_session/create` executor). Reachability: the edges are read back from
 * PGlite, and each id is reported on `blockerLinks` beside the sessions.
 *
 * Real: `createFocusSession`, `applyUnitBlockerEdits` → `governedDependencyLink`
 * (cycle walk, THE store write), the registered executor.
 *
 * Stubbed, and why:
 *  - `checkPermissionOrPropose` — the governance membrane has its own suite;
 *    here it grants or proposes on demand, every call captured.
 *  - `checkLinkEndpointsVisible` / `assertWorkspaceWrite` — the endpoint and
 *    write floors have their own suites (`link-endpoint-visibility.pglite`,
 *    `dependency-links.test.ts`); here an id in `h.hidden` is refused so the
 *    per-id report of a refusal is driven.
 *  - `recordSessionSpawn`, `resolveSessionProjectPlacement`,
 *    `ensureSessionChannel`, realtime emit — unrelated side effects.
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

/** Every `blocked_by` edge out of a session, as `<kind>:<id>`. */
const waitsOn = (sessionId: string) =>
  q<{ to_type: string; to_id: string }>(
    `select to_type, to_id from links where link_type = 'blocked_by' and from_type = 'session' and from_id = $1 order by to_type, to_id`,
    [sessionId]
  ).then((r) => r.rows.map((x) => `${x.to_type}:${x.to_id}`));

describe("createFocusSession — born waiting on a decision or a goal", () => {
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

  it("DIRECT: writes session → entity and session → goal edges, each reported on blockerLinks; a refused one is said, not dropped", async () => {
    const decision = randomUUID();
    const goal = randomUUID();
    const hidden = randomUUID();
    h.hidden.add(hidden);
    const res = await createFocusSession({
      userId: USER,
      goal: "sign the term sheet",
      blockedByEntityIds: [decision, hidden],
      blockedByTrackIds: [goal],
    });
    expect(res.status).toBe("created");
    if (res.status !== "created") return;
    expect(res.blockerLinks).toEqual([
      { blockerEntityId: decision, status: "linked", inserted: 1 },
      {
        blockerEntityId: hidden,
        status: "failed",
        reason: "not_found",
        message: "Entity not found",
      },
      { blockerTrackId: goal, status: "linked", inserted: 1 },
    ]);
    expect(await waitsOn(res.session.id)).toEqual(
      [`entity:${decision}`, `track:${goal}`].sort()
    );
  });

  it("an AGENT's start: each cross-kind edge is judged as link/create and may be proposed", async () => {
    const decision = randomUUID();
    h.perm = async (opts) =>
      opts.subjectType === "link"
        ? { proposalId: "prop-link-1", proposalType: "create" }
        : { granted: true };
    const res = await createFocusSession({
      userId: USER,
      agentUserId: "agent-1",
      goal: "agent step",
      blockedByEntityIds: [decision],
    });
    expect(res).toMatchObject({
      status: "created",
      blockerLinks: [
        {
          blockerEntityId: decision,
          status: "proposed",
          proposalId: "prop-link-1",
        },
      ],
    });
    expect(h.permCalls.find((c) => c.subjectType === "link")).toMatchObject({
      agentUserId: "agent-1",
      action: "create",
      data: {
        fromType: "session",
        toType: "entity",
        toId: decision,
        linkType: "blocked_by",
      },
    });
    if (res.status === "created") {
      expect(await waitsOn(res.session.id)).toEqual([]);
    }
  });

  it("PROPOSED: the ids ride the proposal and land at approval, through the same door", async () => {
    const decision = randomUUID();
    const goal = randomUUID();
    h.perm = async (opts) =>
      opts.subjectType === "focus_session"
        ? { proposalId: "prop-session-1", proposalType: "create" }
        : { granted: true };
    const proposed = await createFocusSession({
      userId: USER,
      agentUserId: "agent-1",
      goal: "step waiting on a decision",
      blockedByEntityIds: [decision],
      blockedByTrackIds: [goal],
    });
    expect(proposed.status).toBe("proposed");
    const data = h.permCalls.find((c) => c.subjectType === "focus_session")!
      .data as Record<string, unknown>;
    expect(data).toMatchObject({
      blockedByEntityIds: [decision],
      blockedByTrackIds: [goal],
    });

    const proposalId = randomUUID();
    const targetId = randomUUID();
    await q(
      `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_at, updated_at)
       values ($1, 'pending', 'create', 'focus_session', $2, $3::jsonb, now(), now())`,
      [proposalId, targetId, JSON.stringify({ data })]
    );
    h.permCalls.length = 0;
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
    expect(await waitsOn(targetId)).toEqual(
      [`entity:${decision}`, `track:${goal}`].sort()
    );
    // The approval IS the decision: no second link proposal is filed.
    expect(h.permCalls.filter((c) => c.subjectType === "link")).toEqual([]);
  });
});
