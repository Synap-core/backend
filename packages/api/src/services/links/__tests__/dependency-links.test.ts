/**
 * THE dependency door — governance, the endpoint floor, and the event emit.
 *
 * The db is a chainable stub (every builder returns one thenable that resolves
 * to the next queued result), so these tests pin WHAT the door does in order:
 * floor → gate → write → event. The SQL of the floor is exercised for real in
 * `link-endpoint-visibility.pglite.test.ts`; the derivation rule in
 * `@synap-core/types` `dependency.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { queue, inserts, deletes, dbStub } = vi.hoisted(() => {
  const queue: unknown[][] = [];
  const inserts: unknown[] = [];
  const deletes: unknown[] = [];
  function chain(): Record<string, unknown> {
    const node: Record<string, unknown> = {
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(queue.shift() ?? []).then(resolve);
      },
    };
    for (const m of [
      "select",
      "from",
      "where",
      "limit",
      "innerJoin",
      "onConflictDoNothing",
      "returning",
    ]) {
      node[m] = () => node;
    }
    node.values = (v: unknown) => {
      inserts.push(v);
      return node;
    };
    return node;
  }
  const shared = chain();
  const dbStub = {
    select: () => shared,
    insert: () => shared,
    delete: () => {
      deletes.push(true);
      return shared;
    },
  };
  return { queue, inserts, deletes, dbStub };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: dbStub };
});

const visibility = vi.fn(async (_e: unknown, _u: string, _w: unknown) => null as
  | null
  | { status: 403 | 404; error: string });
vi.mock("../../../routers/hub-protocol/rest/link-endpoint-visibility.js", () => ({
  checkLinkEndpointsVisible: (e: unknown, u: string, w: unknown) =>
    visibility(e, u, w),
}));

const gate = vi.fn(async (_o: Record<string, unknown>) => ({
  granted: true,
}) as Record<string, unknown>);
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: (o: Record<string, unknown>) => gate(o),
}));

const mutations: Array<Record<string, unknown>> = [];
vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: async (o: Record<string, unknown>) => {
    mutations.push(o);
    return null;
  },
}));

const stamps: Array<Record<string, unknown>> = [];
vi.mock("../../proposals/stamp-materialized.js", () => ({
  stampAutoApprovedCreate: async (o: Record<string, unknown>) => {
    stamps.push(o);
  },
}));

import {
  governedDependencyLink,
  governedRemoveDependencyLink,
  validateDependencyEdge,
  writeRelationAsDependency,
} from "../dependency-links.js";

const U = "user-1";
const AGENT = "agent-1";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";
const edge = {
  fromType: "entity",
  fromId: T1,
  toType: "track",
  toId: T2,
  linkType: "blocked_by" as const,
};

beforeEach(() => {
  queue.length = 0;
  inserts.length = 0;
  deletes.length = 0;
  mutations.length = 0;
  stamps.length = 0;
  visibility.mockClear();
  gate.mockClear();
  gate.mockResolvedValue({ granted: true });
  visibility.mockResolvedValue(null);
});

describe("validateDependencyEdge — the endpoint floor", () => {
  it("refuses a non-work endpoint kind before reading anything", async () => {
    const r = await validateDependencyEdge(
      { ...edge, fromType: "playbook" },
      U
    );
    expect(r).toMatchObject({ ok: false, reason: "invalid_pair", httpStatus: 400 });
    expect(visibility).not.toHaveBeenCalled();
  });
  it("refuses a self edge", async () => {
    const r = await validateDependencyEdge({ ...edge, toType: "entity", toId: T1 }, U);
    expect(r).toMatchObject({ ok: false, reason: "self_edge" });
  });
  it("an invisible endpoint gets the floor's refusal verbatim", async () => {
    visibility.mockResolvedValueOnce({ status: 404, error: "Track not found" });
    const r = await validateDependencyEdge(edge, U);
    expect(r).toMatchObject({ ok: false, httpStatus: 404, error: "Track not found" });
  });
  it("stamps the BLOCKED (from) end's own workspace", async () => {
    queue.push([{ w: "ws-of-the-task" }]);
    expect(await validateDependencyEdge(edge, U)).toEqual({
      ok: true,
      workspaceId: "ws-of-the-task",
    });
  });
});

describe("governedDependencyLink — governance + event", () => {
  it("an AGENT write that governance defers files a proposal and writes NOTHING", async () => {
    queue.push([{ w: "ws-1" }]);
    gate.mockResolvedValueOnce({
      granted: false,
      proposalId: "prop-1",
      reviewPath: "/p/prop-1",
    });
    const r = await governedDependencyLink({
      edge,
      userId: U,
      agentUserId: AGENT,
      door: "test",
    });
    expect(r).toMatchObject({ status: "proposed", proposalId: "prop-1" });
    expect(gate.mock.calls[0]![0]).toMatchObject({
      userId: U,
      agentUserId: AGENT,
      workspaceId: "ws-1",
      subjectType: "link",
      action: "create",
      data: { linkType: "blocked_by", fromType: "entity", toType: "track" },
    });
    expect(inserts).toHaveLength(0);
    expect(mutations).toHaveLength(0);
  });

  it("a granted write inserts ONE edge, emits link.create (reachability), and stamps the undo receipt", async () => {
    queue.push([{ w: "ws-1" }]); // from-end workspace
    queue.push([{ id: "link-9" }]); // insert … returning
    gate.mockResolvedValueOnce({ granted: true, autoApprovedProposalId: "rcpt-1" });
    const r = await governedDependencyLink({
      edge,
      userId: U,
      agentUserId: AGENT,
      door: "test",
    });
    expect(r).toEqual({ status: "created", linkId: "link-9", inserted: 1 });
    expect(inserts).toEqual([
      expect.objectContaining({
        workspaceId: "ws-1",
        fromType: "entity",
        fromId: T1,
        toType: "track",
        toId: T2,
        linkType: "blocked_by",
        createdBy: U,
      }),
    ]);
    expect(mutations).toEqual([
      expect.objectContaining({
        subjectType: "link",
        action: "create",
        subjectId: "link-9",
        userId: U,
        workspaceId: "ws-1",
        agentUserId: AGENT,
        proposalId: "rcpt-1",
        data: {
          linkType: "blocked_by",
          fromType: "entity",
          fromId: T1,
          toType: "track",
          toId: T2,
        },
      }),
    ]);
    expect(stamps[0]).toMatchObject({
      receiptId: "rcpt-1",
      record: { linkIds: ["link-9"] },
    });
  });

  it("an already-existing edge emits NO event (nothing happened)", async () => {
    queue.push([{ w: "ws-1" }]);
    queue.push([]); // conflict: nothing returned
    queue.push([{ id: "old-link" }]); // existing lookup
    const r = await governedDependencyLink({ edge, userId: U, door: "test" });
    expect(r).toEqual({ status: "exists", linkId: "old-link", inserted: 0 });
    expect(mutations).toHaveLength(0);
  });

  it("an approved re-entry skips the gate but stamps the approval on the event", async () => {
    queue.push([{ w: "ws-1" }]);
    queue.push([{ id: "link-2" }]);
    await governedDependencyLink({
      edge,
      userId: U,
      agentUserId: AGENT,
      approvedProposalId: "prop-7",
      door: "test",
    });
    expect(gate).not.toHaveBeenCalled();
    expect(mutations[0]).toMatchObject({ proposalId: "prop-7", agentUserId: AGENT });
  });

  it("delete emits link.delete per removed row", async () => {
    queue.push([{ w: "ws-1" }]);
    queue.push([{ id: "link-3", workspaceId: "ws-1" }]);
    const r = await governedRemoveDependencyLink({ edge, userId: U, door: "test" });
    expect(r).toEqual({ status: "removed", removed: 1 });
    expect(gate.mock.calls[0]![0]).toMatchObject({ action: "delete" });
    expect(mutations[0]).toMatchObject({
      subjectType: "link",
      action: "delete",
      subjectId: "link-3",
    });
  });
});

describe("writeRelationAsDependency — the relation doors' mapping", () => {
  it("A blocks B lands as B --blocked_by--> A, tagged with the requested slug", async () => {
    queue.push([{ w: "ws-1" }]);
    queue.push([{ id: "link-5" }]);
    const r = await writeRelationAsDependency({
      type: "blocks",
      sourceEntityId: T1,
      targetEntityId: T2,
      userId: U,
    });
    expect(r).toEqual({
      id: "link-5",
      status: "created",
      storedAs: "link",
      inserted: 1,
    });
    expect(inserts[0]).toMatchObject({
      fromType: "entity",
      fromId: T2,
      toType: "entity",
      toId: T1,
      linkType: "blocked_by",
      metadata: { relationType: "blocks" },
    });
  });
  it("any other slug is left to the relation door (null, nothing read)", async () => {
    expect(
      await writeRelationAsDependency({
        type: "relates_to",
        sourceEntityId: T1,
        targetEntityId: T2,
        userId: U,
      })
    ).toBeNull();
    expect(visibility).not.toHaveBeenCalled();
  });
  it("a refused endpoint THROWS (never a silent skip)", async () => {
    visibility.mockResolvedValueOnce({ status: 404, error: "Entity not found" });
    await expect(
      writeRelationAsDependency({
        type: "depends_on",
        sourceEntityId: T1,
        targetEntityId: T2,
        userId: U,
      })
    ).rejects.toThrow(/Entity not found/);
  });
});
