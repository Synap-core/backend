/**
 * Capture lineage through the ONE read door, `getObjectGraph`:
 *   - entity focus → the capture document it was MADE FROM (incoming `produced`)
 *   - document focus → the entities it MADE (outgoing `produced`)
 *   - entity focus → its RECEIPT (`entities.sourceProposalId`) carrying session,
 *     source message and agent, plus the session it ran in.
 *
 * The DB is faked at the `getDb()` seam (dispatch on table identity, the same
 * pattern as `document-body-neighbors.test.ts`), and `getLinksFor` returns the
 * stored edge. This proves the folds' SHAPE, direction and drop rules; it does
 * NOT prove the SQL floors (owner / lens) — the fake ignores `where`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  links: [] as Record<string, unknown>[],
  documentRows: [] as Record<string, unknown>[],
  entityRows: [] as Record<string, unknown>[],
  proposalRows: [] as Record<string, unknown>[],
  sessionRows: [] as Record<string, unknown>[],
}));

vi.mock("../links/links-service.js", () => ({
  getLinksFor: vi.fn(async () => h.links),
}));
vi.mock("../../utils/workspace-membership.js", () => ({
  resolveFacetVisibilityScope: vi.fn(async () => ({})),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = (rows: Record<string, unknown>[]) => {
    const self: Record<string, unknown> = {
      where: () => self,
      limit: () => self,
      orderBy: () => self,
      then: (
        resolve: (v: Record<string, unknown>[]) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return self;
  };
  const fakeDb = {
    select: () => ({
      from: (table: unknown) => {
        if (table === actual.documents) return chain(h.documentRows);
        if (table === actual.entities) return chain(h.entityRows);
        if (table === actual.proposals) return chain(h.proposalRows);
        if (table === actual.focusSessions) return chain(h.sessionRows);
        return chain([]);
      },
    }),
  };
  return {
    ...actual,
    getDb: async () => fakeDb,
    loadFacetSlugsBatch: vi.fn(async () => new Map()),
  };
});

import { getObjectGraph, mergeNeighbors } from "./graph-service.js";
import type { GraphNeighbor } from "./graph-service.js";

const USER = "user-owner";
const DOCUMENT_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ENTITY_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const PROPOSAL_ID = "dddddddd-4444-4444-8444-444444444444";
const SESSION_ID = "eeeeeeee-5555-4555-8555-555555555555";
const MESSAGE_ID = "ffffffff-6666-4666-8666-666666666666";

const PRODUCED_EDGE = {
  fromType: "document",
  fromId: DOCUMENT_ID,
  toType: "entity",
  toId: ENTITY_ID,
  linkType: "produced",
};

beforeEach(() => {
  h.links = [];
  h.documentRows = [];
  h.entityRows = [];
  h.proposalRows = [];
  h.sessionRows = [];
});

describe("getObjectGraph — capture lineage", () => {
  it("entity focus: lists the capture it was made from, as kind capture", async () => {
    h.links = [PRODUCED_EDGE];
    h.documentRows = [
      {
        id: DOCUMENT_ID,
        title: "Call notes",
        type: "markdown",
        workspaceId: null,
        metadata: { intakeSource: { door: "capture.execute" } },
      },
    ];
    h.entityRows = [
      { id: ENTITY_ID, title: "Ada", type: "person", workspaceId: null },
    ];

    const graph = await getObjectGraph(USER, "entity", ENTITY_ID);
    const madeFrom = graph.neighbors.filter(
      (n) => n.id === DOCUMENT_ID && n.via === "links"
    );
    expect(madeFrom).toEqual([
      expect.objectContaining({
        kind: "capture",
        id: DOCUMENT_ID,
        name: "Call notes",
        edgeType: "produced",
        direction: "incoming",
      }),
    ]);
  });

  it("a plain body document neighbour stays kind document", async () => {
    h.links = [{ ...PRODUCED_EDGE, linkType: "about" }];
    h.documentRows = [
      {
        id: DOCUMENT_ID,
        title: "Spec",
        type: "markdown",
        workspaceId: null,
        metadata: {},
      },
    ];
    h.entityRows = [
      { id: ENTITY_ID, title: "Ada", type: "person", workspaceId: null },
    ];

    const graph = await getObjectGraph(USER, "entity", ENTITY_ID);
    expect(
      graph.neighbors.filter((n) => n.id === DOCUMENT_ID && n.via === "links")
    ).toEqual([expect.objectContaining({ kind: "document", name: "Spec" })]);
  });

  it("document focus: lists the entities it made", async () => {
    h.links = [PRODUCED_EDGE];
    h.documentRows = [
      {
        id: DOCUMENT_ID,
        title: "Call notes",
        type: "markdown",
        workspaceId: null,
      },
    ];
    h.entityRows = [
      { id: ENTITY_ID, title: "Ada", type: "person", workspaceId: null },
    ];

    const graph = await getObjectGraph(USER, "document", DOCUMENT_ID);
    const made = graph.neighbors.filter(
      (n) => n.kind === "entity" && n.via === "links"
    );
    expect(made).toEqual([
      expect.objectContaining({
        id: ENTITY_ID,
        name: "Ada",
        edgeType: "produced",
        direction: "outgoing",
      }),
    ]);
  });

  it("drops a capture the caller cannot see instead of naming it by id", async () => {
    h.links = [PRODUCED_EDGE];
    h.documentRows = []; // failed the owner floor
    h.entityRows = [
      { id: ENTITY_ID, title: "Ada", type: "person", workspaceId: null },
    ];

    const graph = await getObjectGraph(USER, "entity", ENTITY_ID);
    expect(graph.neighbors.some((n) => n.id === DOCUMENT_ID)).toBe(false);
  });

  it("entity focus: the receipt carries session, source message and agent", async () => {
    h.entityRows = [
      {
        id: ENTITY_ID,
        title: "Ada",
        type: "person",
        workspaceId: null,
        sourceProposalId: PROPOSAL_ID,
      },
    ];
    h.proposalRows = [
      {
        id: PROPOSAL_ID,
        proposalType: "capture.graph",
        targetType: "entity",
        status: "auto_approved",
        workspaceId: null,
        sessionId: SESSION_ID,
        sourceMessageId: MESSAGE_ID,
        agentUserId: "agent-1",
      },
    ];
    h.sessionRows = [
      { id: SESSION_ID, goal: "Capture call", workspaceId: null },
    ];

    const graph = await getObjectGraph(USER, "entity", ENTITY_ID);
    expect(graph.neighbors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "proposal",
          id: PROPOSAL_ID,
          via: "governed",
          direction: "incoming",
          receipt: {
            sessionId: SESSION_ID,
            sourceMessageId: MESSAGE_ID,
            agentUserId: "agent-1",
          },
        }),
        expect.objectContaining({
          kind: "session",
          id: SESSION_ID,
          via: "produced-in",
        }),
      ])
    );
  });
});

describe("mergeNeighbors — receipt row wins over the temporal duplicate", () => {
  it("keeps the row that carries `receipt`", () => {
    const base: GraphNeighbor = {
      kind: "proposal",
      id: PROPOSAL_ID,
      name: "Captured",
      subtype: "auto_approved",
      subtypes: ["auto_approved"],
      workspaceId: null,
      edgeType: "capture.graph",
      direction: "incoming",
      via: "governed",
    };
    const withReceipt: GraphNeighbor = {
      ...base,
      receipt: {
        sessionId: SESSION_ID,
        sourceMessageId: null,
        agentUserId: null,
      },
    };
    const merged = mergeNeighbors([[], [withReceipt], [], [base]]);
    expect(merged).toEqual([withReceipt]);
  });
});
