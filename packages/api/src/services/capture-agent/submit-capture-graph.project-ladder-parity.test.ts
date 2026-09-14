import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ProfileResolutionService,
  resolveGraphWorkspaceFromSlugs,
  resolveProjectPlacement,
} from "@synap/database";

/**
 * ONE PROJECT LADDER FOR BOTH GRAPH TERMINALS (A3), and a DERIVED session never
 * places either of them (A1).
 *
 * Before: the pending row ran `insertPendingProposal`'s ladder (session →
 * channel → declared focus) while the auto-apply receipt stamped only the
 * caller's pin — the same graph landed in a project when proposed and in none
 * when auto-applied.
 *
 * Driven through the REAL `submitCaptureGraph`. The derivation is re-routed to
 * the REAL ladder (`resolveProjectPlacement`) over a fake executor whose session
 * row IS project-scoped — the barrel's own `deriveProposalProjectId` binds the
 * client-pg `db` a module mock cannot reach, so it is rebuilt here from the
 * ladder it delegates to. The PENDING terminal's derivation is observed at the
 * same seam: the `createEventBackedProposal` stub derives with exactly the
 * fields the pending insert forwards, so both terminals are judged by one rule.
 *
 * COVERAGE BOUNDARY: this proves the receipt and the pending input reach the
 * ladder with the same inputs and that the ladder's verdict is what the receipt
 * stores. It does not run the pending insert itself (see the database test
 * `derive-proposal-project-id.session-source.test.ts` for the forwarding there).
 */

const SESSION = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const P_SESSION = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const P_FOCUS = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let focusProjectId: string | null = null;

const fakeExecutor = {
  query: {
    focusSessions: { findFirst: async () => ({ projectId: P_SESSION }) },
    channels: { findFirst: async () => undefined },
    relations: { findMany: async () => [] },
  },
};

async function ladder(input: {
  projectId?: string | null;
  sessionId?: string | null;
  sessionSource?: "explicit" | "derived";
  threadId?: string | null;
  focusProjectId?: string | null;
}): Promise<string | null> {
  const placement = await resolveProjectPlacement(fakeExecutor as never, {
    explicitProjectId: input.projectId,
    sessionId: input.sessionId,
    sessionSource: input.sessionSource,
    channelId: input.threadId,
    focusProjectId: input.focusProjectId,
  });
  return placement.projectId;
}

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    resolveGraphWorkspaceFromSlugs: vi.fn(),
    deriveProposalProjectId: vi.fn(),
    db: {
      ...actual.db,
      update: () => ({ set: () => ({ where: async () => {} }) }),
    },
  };
});

vi.mock("../agent-identity-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../agent-identity-service.js")>();
  return {
    ...actual,
    getAgentFocusProjectId: vi.fn(async () => focusProjectId),
  };
});

const governance = { decision: "execute" as string };
vi.mock("@synap/database/agent-governance", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@synap/database/agent-governance")>();
  return {
    ...actual,
    resolveAgentGovernanceDecision: vi.fn(async () => ({
      decision: governance.decision,
    })),
  };
});

vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: { createCaller: () => ({}) },
}));
vi.mock("../../routers/relations.js", () => ({
  relationsRouter: { createCaller: () => ({}) },
}));

const database = await import("@synap/database");
const { submitCaptureGraph } = await import("./submit-capture-graph.js");
const dedup = await import("../../utils/pending-capture-dedup.js");
const proposalWriter = await import("../../utils/event-backed-proposal.js");
const materializer = await import("../../utils/materialize-composite.js");

const ENTITIES = [
  { ref: "n1", profileSlug: "note", title: "Ladder parity", properties: {} },
] as never;

/** Run one terminal and return the project the stored row would carry. */
async function storedProject(
  terminal: "applied" | "pending",
  input: { sessionSource?: "explicit" | "derived" }
): Promise<string | null> {
  governance.decision = terminal === "applied" ? "execute" : "propose";
  let stored: string | null | undefined;
  vi.spyOn(proposalWriter, "createAutoApprovedProposal").mockImplementation(
    async (row) => {
      stored = row.projectId ?? null;
      return {
        proposal: { id: row.id, data: row.data, projectId: stored },
      } as never;
    }
  );
  vi.spyOn(proposalWriter, "createEventBackedProposal").mockImplementation(
    async (row) => {
      // What the pending insert derives from the fields it is handed — the
      // rung-3.5 read `createPendingProposal` performs included.
      stored = await ladder({
        projectId: row.projectId,
        sessionId: row.sessionId,
        sessionSource: (row as { sessionSource?: "explicit" | "derived" })
          .sessionSource,
        threadId: row.threadId,
        focusProjectId:
          !row.projectId && row.agentUserId ? focusProjectId : null,
      });
      return { proposal: { id: "prop-pending", projectId: stored } } as never;
    }
  );
  const result = await submitCaptureGraph({
    userId: "user-1",
    agentUserId: "agent-1",
    workspaceId: null,
    sessionId: SESSION,
    ...(input.sessionSource ? { sessionSource: input.sessionSource } : {}),
    entities: ENTITIES,
  });
  // Branch proof — each terminal is the one the fixture asked for.
  expect(result.applied).toBe(terminal === "applied");
  return stored ?? null;
}

describe("submitCaptureGraph — one project ladder for both terminals", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    focusProjectId = null;
    vi.mocked(resolveGraphWorkspaceFromSlugs).mockResolvedValue(null);
    vi.mocked(database.deriveProposalProjectId).mockImplementation(ladder);
    vi.spyOn(dedup, "findPriorCaptureGraphProposal").mockResolvedValue(null);
    vi.spyOn(
      ProfileResolutionService.prototype,
      "resolveProfile"
    ).mockResolvedValue(null as never);
    vi.spyOn(materializer, "materializeCompositeGraph").mockResolvedValue({
      entities: [{ ref: "n1", entityId: "entity-1", linked: false }],
      relations: [],
      relationsFailed: [],
      projects: [],
      sessions: [],
      documents: [],
      created: 1,
    } as never);
  });

  it("(c) the same graph in an EXPLICIT session lands in the SAME project, auto-applied or pending", async () => {
    const applied = await storedProject("applied", {
      sessionSource: "explicit",
    });
    const pending = await storedProject("pending", {
      sessionSource: "explicit",
    });
    expect(applied).toBe(P_SESSION);
    expect(pending).toBe(P_SESSION);
  });

  it("(a) a DERIVED session gives NEITHER terminal a project", async () => {
    expect(
      await storedProject("applied", { sessionSource: "derived" }),
      "applied"
    ).toBeNull();
    expect(
      await storedProject("pending", { sessionSource: "derived" }),
      "pending"
    ).toBeNull();
  });

  it("(d) a DERIVED session + a declared focus: the focus places BOTH terminals", async () => {
    focusProjectId = P_FOCUS;
    expect(
      await storedProject("applied", { sessionSource: "derived" }),
      "applied"
    ).toBe(P_FOCUS);
    expect(
      await storedProject("pending", { sessionSource: "derived" }),
      "pending"
    ).toBe(P_FOCUS);
  });
});
