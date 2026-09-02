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
        return chain([]);
      },
    }),
  };

  return { ...actual, getDb: async () => fakeDb };
});

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getTemporalNeighbors } from "./graph-service.js";

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
    // Title comes from the vocabulary door in PAST mood — this is history, not
    // a button. A hand-written label map here would be the fork the vocabulary
    // SSOT exists to prevent. `entity` is the generic base kind, which the
    // vocabulary suppresses on purpose ("Updated entity" says nothing), so the
    // verb stands alone here.
    expect(proposal?.name).toBe("Updated");

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
