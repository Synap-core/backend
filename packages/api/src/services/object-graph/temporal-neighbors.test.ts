/**
 * THE TEMPORAL HALF OF THE OBJECT GRAPH (why-spine, 0241).
 *
 * Every pre-existing neighbour source in `graph-service` answers WHAT an object
 * is connected to. None answers WHY it looks the way it does, because "why" is
 * not a stored `links`/`relations` edge — it is on the append-only `events`
 * spine: subject → the proposal that authorized the change (`proposal_id`,
 * 0231) → the goal-bound session it happened inside (`session_id`, 0241).
 *
 * Two things must hold, and the second is the one that bites:
 *   1. a proposal that touched the object shows up as a BACKWARD neighbour, and
 *      drags its session in with it;
 *   2. a neighbour the visibility floor rejects is DROPPED, never emitted as a
 *      bare id. An id is itself the leak — the graph is the surface where
 *      seven owner-private kinds have leaked by name before
 *      (`hydration-floor-owner-private.test.ts`).
 *
 * The DB is faked at the `getDb()` seam and dispatches on TABLE IDENTITY, so
 * these run with no Postgres. What a fake cannot prove is that the real SQL
 * predicate is owner-floored — drizzle conditions are opaque objects here — so
 * that invariant is asserted structurally against the source instead.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  eventRows: [] as Record<string, unknown>[],
  proposalRows: [] as Record<string, unknown>[],
  sessionRows: [] as Record<string, unknown>[],
  entityRows: [] as Record<string, unknown>[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();

  /** Awaitable query stub: `.where`/`.orderBy`/`.limit` all return itself. */
  const chain = (rows: Record<string, unknown>[]) => {
    const self: Record<string, unknown> = {
      where: () => self,
      orderBy: () => self,
      limit: () => self,
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
        if (table === actual.events) return chain(h.eventRows);
        if (table === actual.proposals) return chain(h.proposalRows);
        if (table === actual.focusSessions) return chain(h.sessionRows);
        if (table === actual.entities) return chain(h.entityRows);
        return chain([]);
      },
    }),
  };

  return { ...actual, getDb: async () => fakeDb };
});

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  getTemporalNeighbors,
  getReceiptNeighbors,
  mergeNeighbors,
  type GraphNeighbor,
} from "./graph-service.js";

const OWNER = "user-owner";
const ENTITY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const PROPOSAL_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const SESSION_ID = "cccccccc-3333-4333-8333-333333333333";
const WORKSPACE_ID = "dddddddd-4444-4444-8444-444444444444";

const NO_FACET_SCOPE = {
  workspaceIds: [] as string[],
  isMember: false,
} as unknown as Parameters<typeof getTemporalNeighbors>[3];

beforeEach(() => {
  h.eventRows = [];
  h.proposalRows = [];
  h.sessionRows = [];
  h.entityRows = [];
});

describe("getTemporalNeighbors", () => {
  it("surfaces the proposal that changed the object, and the session it ran in", async () => {
    h.eventRows = [
      {
        proposalId: PROPOSAL_ID,
        sessionId: SESSION_ID,
        timestamp: new Date(),
      },
    ];
    h.proposalRows = [
      {
        id: PROPOSAL_ID,
        proposalType: "update",
        targetType: "entity",
        status: "approved",
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
      },
    ];
    h.sessionRows = [
      {
        id: SESSION_ID,
        goal: "Close the Acme renewal",
        workspaceId: WORKSPACE_ID,
      },
    ];

    const out = await getTemporalNeighbors(
      OWNER,
      "entity",
      ENTITY_ID,
      NO_FACET_SCOPE,
      WORKSPACE_ID
    );

    // Both are things that acted ON the focused object → backward-looking.
    expect(out.every((n) => n.direction === "incoming")).toBe(true);

    const proposal = out.find((n) => n.kind === "proposal");
    expect(proposal).toMatchObject({
      id: PROPOSAL_ID,
      via: "governed",
      subtype: "approved",
    });
    // Named by the proposal's OWN display door (`proposalDisplaySummary`),
    // never a bare verb. A row with no payload at all still gets the door's
    // fallback — the vocabulary's verb — never an id or an empty string.
    expect(proposal?.name).toBe("Update");

    expect(out.find((n) => n.kind === "session")).toMatchObject({
      id: SESSION_ID,
      name: "Close the Acme renewal",
      via: "produced-in",
    });
  });

  it("reaches the session through the PROPOSAL when the event row predates 0241", async () => {
    // Rows written before `events.session_id` existed carry no session, but the
    // proposal they point at usually does — the second, older route.
    h.eventRows = [
      { proposalId: PROPOSAL_ID, sessionId: null, timestamp: new Date() },
    ];
    h.proposalRows = [
      {
        id: PROPOSAL_ID,
        proposalType: "create",
        targetType: "entity",
        status: "approved",
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
      },
    ];
    h.sessionRows = [
      { id: SESSION_ID, goal: "Backfill week", workspaceId: WORKSPACE_ID },
    ];

    const out = await getTemporalNeighbors(
      OWNER,
      "entity",
      ENTITY_ID,
      NO_FACET_SCOPE,
      WORKSPACE_ID
    );
    expect(out.find((n) => n.kind === "session")?.id).toBe(SESSION_ID);
  });

  it("DROPS a session the visibility floor rejects — never a bare id", async () => {
    // The floor is what returns no row; the graph must then emit nothing at all.
    // Emitting a stub node would publish the existence of another user's session.
    h.eventRows = [
      { proposalId: null, sessionId: SESSION_ID, timestamp: new Date() },
    ];
    h.sessionRows = []; // hydration floor rejected it

    const out = await getTemporalNeighbors(
      OWNER,
      "entity",
      ENTITY_ID,
      NO_FACET_SCOPE,
      WORKSPACE_ID
    );
    expect(out).toEqual([]);
  });

  it("drops a proposal the access layer rejects, and the session it would have dragged in", async () => {
    h.eventRows = [
      { proposalId: PROPOSAL_ID, sessionId: null, timestamp: new Date() },
    ];
    h.proposalRows = []; // userVisibleWhere rejected it
    h.sessionRows = [
      {
        id: SESSION_ID,
        goal: "Someone else's week",
        workspaceId: WORKSPACE_ID,
      },
    ];

    const out = await getTemporalNeighbors(
      OWNER,
      "entity",
      ENTITY_ID,
      NO_FACET_SCOPE,
      WORKSPACE_ID
    );
    expect(out).toEqual([]);
  });

  it("never returns the focused session as its own neighbour", async () => {
    h.eventRows = [
      { proposalId: null, sessionId: SESSION_ID, timestamp: new Date() },
    ];
    h.sessionRows = [
      { id: SESSION_ID, goal: "Ship the spine", workspaceId: WORKSPACE_ID },
    ];

    const out = await getTemporalNeighbors(
      OWNER,
      "session",
      SESSION_ID,
      NO_FACET_SCOPE,
      WORKSPACE_ID
    );
    expect(out).toEqual([]);
  });

  it("short-circuits with no query when the object has no governed/session events", async () => {
    h.eventRows = [];
    const out = await getTemporalNeighbors(
      OWNER,
      "entity",
      ENTITY_ID,
      NO_FACET_SCOPE,
      WORKSPACE_ID
    );
    expect(out).toEqual([]);
  });
});

/**
 * ONE FACT, TWO ROWS (live dogfood, entity ab8b1cce…).
 *
 * A session that produced an object is BOTH a stored `links` edge and, via the
 * events spine, a derived temporal neighbour. Emitting both made the neighbour
 * pane list the same session twice under two names. The stored edge is the
 * primary fact; the derived one folds into it — but only when it exists, since
 * an UPDATE done inside a session writes no `produced` link at all and the
 * temporal row is then the only trace of it.
 */
describe("mergeNeighbors — produced / produced-in fold", () => {
  const SESSION_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SESSION_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  const producedLink = (id: string): GraphNeighbor => ({
    kind: "session",
    id,
    name: "Close the Acme renewal",
    subtype: null,
    subtypes: [],
    workspaceId: WORKSPACE_ID,
    edgeType: "produced",
    direction: "incoming",
    via: "links",
  });

  const producedInTemporal = (id: string): GraphNeighbor => ({
    kind: "session",
    id,
    name: "Close the Acme renewal",
    subtype: null,
    subtypes: [],
    workspaceId: WORKSPACE_ID,
    edgeType: "produced_in",
    direction: "incoming",
    via: "produced-in",
  });

  it("(a) keeps ONE row — the stored link — when both name the same session", () => {
    const out = mergeNeighbors([
      [producedLink(SESSION_A)],
      [producedInTemporal(SESSION_A)],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: SESSION_A,
      via: "links",
      edgeType: "produced",
    });
  });

  it("(b) keeps the temporal row when no produced link exists (update-in-session)", () => {
    const out = mergeNeighbors([[], [producedInTemporal(SESSION_A)]]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: SESSION_A, via: "produced-in" });
  });

  it("(c) folds only the matching session — two different sessions stay two rows", () => {
    const out = mergeNeighbors([
      [producedLink(SESSION_A)],
      [producedInTemporal(SESSION_B)],
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.id).sort()).toEqual([SESSION_A, SESSION_B].sort());
    expect(out.find((n) => n.id === SESSION_B)?.via).toBe("produced-in");
  });

  it("still de-dups the same edge arriving twice", () => {
    const out = mergeNeighbors([
      [producedLink(SESSION_A)],
      [producedLink(SESSION_A)],
    ]);
    expect(out).toHaveLength(1);
  });
});

describe("the floors a fake DB cannot exercise", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "graph-service.ts"),
    "utf8"
  );
  const fn = src.slice(
    src.indexOf("export async function getTemporalNeighbors")
  );

  it("owner-floors the DRIVER scan on events.userId", () => {
    // The event row is the ONLY thing naming these proposal/session ids at all,
    // so without this floor a caller could enumerate another user's ids before
    // any downstream check ever runs.
    expect(fn).toContain("eq(events.userId, userId)");
  });

  it("re-floors proposals with the access layer rather than a bare inArray", () => {
    expect(fn).toContain("userVisibleWhere(proposals.workspaceId, userId)");
  });

  it("bounds the scan and the neighbour fan-out", () => {
    expect(fn).toContain("TEMPORAL_EVENT_SCAN_LIMIT");
    expect(fn).toContain("TEMPORAL_NEIGHBOR_CAP");
  });
});

/**
 * "Came from" names — W6a (2026-09-28). A proposal neighbour used to be named
 * `buildObjectActionTitle(proposalType, targetType)`: a composite plan read
 * "Graph", a create read "Created" — a verb with no object, beside a kind noun
 * the row already shows. It must read what the proposal's own row reads.
 * Rows below are WIRE-shaped (`proposals.data` as producers store it).
 */
describe("getTemporalNeighbors — proposal names come from the proposal's display door", () => {
  const nameFor = async (row: Record<string, unknown>) => {
    h.eventRows = [
      { proposalId: PROPOSAL_ID, sessionId: null, timestamp: new Date() },
    ];
    h.proposalRows = [
      {
        id: PROPOSAL_ID,
        status: "approved",
        workspaceId: WORKSPACE_ID,
        sessionId: null,
        targetId: ENTITY_ID,
        ...row,
      },
    ];
    const out = await getTemporalNeighbors(
      OWNER,
      "entity",
      ENTITY_ID,
      NO_FACET_SCOPE,
      WORKSPACE_ID
    );
    return out.find((n) => n.kind === "proposal")?.name;
  };

  it("a composite plan names the object it created, not the verb 'Graph'", async () => {
    const name = await nameFor({
      proposalType: "graph",
      targetType: "entity",
      data: {
        changeType: "create",
        summary: "Create entity",
        operations: [
          {
            op: "create_entity",
            profileSlug: "note",
            title: "Raycast V1 focus lens",
          },
          { op: "create_relation" },
        ],
      },
    });
    expect(name).not.toBe("Graph");
    expect(name).toContain("Raycast V1 focus lens");
    expect(name).toContain("+ 1 more");
  });

  it("a stored summary that names the object is the name, verbatim", async () => {
    expect(
      await nameFor({
        proposalType: "create",
        targetType: "entity",
        data: {
          changeType: "create",
          targetType: "entity",
          summary: 'Create Task "Renew the Acme contract"',
          data: { profileSlug: "task", title: "Renew the Acme contract" },
        },
      })
    ).toBe('Create Task "Renew the Acme contract"');
  });

  it("a create with no stored summary is named from its payload title", async () => {
    const name = await nameFor({
      proposalType: "create",
      targetType: "entity",
      data: {
        changeType: "create",
        targetType: "entity",
        data: { profileSlug: "person", title: "Ada Lovelace" },
      },
    });
    expect(name).not.toBe("Created");
    expect(name).toContain("Ada Lovelace");
  });

  it("matches the proposal read door's summary for the same row", async () => {
    // Sameness with `enrichProposalsForDisplay`'s own derivation — they share
    // ONE function, so a lineage row and the proposal page never disagree.
    const { proposalDisplaySummary } =
      await import("../../routers/proposals/display.js");
    const { buildRequestFromProposal } =
      await import("@synap-core/types/proposals");
    const row = {
      id: PROPOSAL_ID,
      proposalType: "graph",
      targetType: "entity",
      targetId: ENTITY_ID,
      workspaceId: WORKSPACE_ID,
      data: {
        changeType: "create",
        operations: [
          { op: "create_entity", profileSlug: "company", title: "Acme" },
        ],
      },
    };
    const expected = proposalDisplaySummary({
      proposalType: row.proposalType,
      request: buildRequestFromProposal(row as never),
      profileSlug: undefined,
      targetName: undefined,
    });
    expect(await nameFor(row)).toBe(expected);
  });
});

describe("getReceiptNeighbors — the receipt row carries the same display name", () => {
  it("names the entity's source proposal by its display door, not 'Created'", async () => {
    h.entityRows = [{ sourceProposalId: PROPOSAL_ID }];
    h.proposalRows = [
      {
        id: PROPOSAL_ID,
        proposalType: "create",
        targetType: "entity",
        targetId: ENTITY_ID,
        status: "approved",
        workspaceId: WORKSPACE_ID,
        sessionId: null,
        sourceMessageId: null,
        agentUserId: null,
        data: {
          changeType: "create",
          targetType: "entity",
          data: { profileSlug: "company", title: "Acme Corp" },
        },
      },
    ];
    const out = await getReceiptNeighbors(
      OWNER,
      "entity",
      ENTITY_ID,
      NO_FACET_SCOPE,
      WORKSPACE_ID
    );
    const receipt = out.find((n) => n.kind === "proposal");
    expect(receipt?.name).not.toBe("Created");
    expect(receipt?.name).toContain("Acme Corp");
  });
});
