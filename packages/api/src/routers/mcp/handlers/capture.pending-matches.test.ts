import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * C2-b: `synap_capture`'s structured lane runs the looser pending text scan
 * (`findPendingTextMatches`, the one `ask`'s pending block uses) on each new
 * entity title and returns the hits as ADVICE (`pendingMatches`, each with its
 * reviewUrl). Never a refusal: the write goes on exactly as before.
 *
 * Driven through the real MCP capture handler; stubbed at module seams (the
 * submit core, intake side-effects, the scan itself), as in
 * `capture.stored-scope.test.ts`.
 *
 * Rows that rule out a wrong rule: a hit is returned with the write still
 * `proposed` (rules out "a fuzzy twin refuses"); a linked entity is not
 * scanned and each proposal appears once (rules out a scan of every op); the
 * proposal the call itself returned is not advice about itself; a failed scan
 * drops the advice, never the write.
 */

const h = vi.hoisted(() => ({
  proposalRows: [] as Array<Record<string, unknown>>,
  selectThrows: false,
  submitResult: undefined as unknown,
  structureResult: undefined as unknown,
  executeResult: undefined as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      // Permissive builder: the graph lane composes read scopes with
      // `.from().innerJoin()…` before any row read, so every builder method
      // returns the chain; awaiting it yields the fixture proposal rows (the
      // only awaited select in the lanes under test is the read-back).
      select: vi.fn(() => {
        const chain: Record<string | symbol, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") {
                return (
                  resolve: (v: unknown) => unknown,
                  reject: (e: unknown) => unknown
                ) =>
                  h.selectThrows
                    ? reject(new Error("db down"))
                    : resolve(h.proposalRows);
              }
              return () => chain;
            },
          }
        );
        return chain;
      }),
    },
    // What rungs 1–2 derive for THIS call — the value an echo would report.
    resolveProjectPlacement: vi.fn(async () => ({
      projectId: "P-RUNG2-GUESS",
      rung: 2,
    })),
    resolveIdentity: vi.fn(async () => ({
      match: null,
      crossKindCandidates: [],
    })),
  };
});

vi.mock("../../../services/capture-agent/submit-capture-graph.js", () => ({
  submitCaptureGraph: vi.fn(async () => h.submitResult),
  dryRunCaptureGraph: vi.fn(),
}));
vi.mock("../../../services/capture-agent/capture-narrative.js", () => ({
  buildCaptureNarrativeSummary: () => "summary",
}));
vi.mock("../../../services/intake/ensure-intake-session.js", () => ({
  ensureIntakeSession: vi.fn(async () => ({
    sessionId: "S-REQUESTED",
    status: "verified",
    requestedSessionIgnored: false,
  })),
}));
// The run's receipt (W-A3): the ONE mint point, stubbed at its seam — the
// capture handler only needs its answer.
vi.mock("../../../utils/permission-check.js", () => ({
  resolveAgentRunReceipt: vi.fn(async () => "S-RUN-RECEIPT"),
}));
vi.mock("../../../services/intake/record-structure-intake.js", () => ({
  recordStructureIntake: vi.fn(async () => null),
}));
vi.mock(
  "../../../services/intake/record-session-run-manifest.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../services/intake/record-session-run-manifest.js")
    >()),
    runFactsFromStructureMeta: () => ({}),
  })
);
vi.mock("../../../utils/pending-capture-dedup.js", () => ({
  computeCaptureGraphIdempotencyKey: () => "k".repeat(64),
  findPendingTextMatches: vi.fn(),
}));
vi.mock("../../capture.js", () => ({
  captureRouter: {
    createCaller: () => ({
      structure: async () => h.structureResult,
      execute: async () => h.executeResult,
    }),
  },
}));
vi.mock("../../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: async () => ({}),
}));
vi.mock("../../../services/messaging/open-process-channel.js", () => ({
  newProcessFlowId: () => "flow-1",
  openProcessChannel: async () => ({
    channel: { id: "channel-1" },
    messageIds: ["message-1"],
  }),
}));

const { captureHandlers } = await import("./capture.js");
const { findPendingTextMatches } = vi.mocked(
  await import("../../../utils/pending-capture-dedup.js")
);
const { submitCaptureGraph } = vi.mocked(
  await import("../../../services/capture-agent/submit-capture-graph.js")
);

function ctx(args: Record<string, unknown>) {
  return {
    toolName: "synap_capture",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.write"],
    agentUserId: "agent-1",
    sessionId: "S-REQUESTED",
    requestedWorkspaceId: undefined,
    confinedWorkspaceId: undefined,
    workspaceAccessible: false,
    caller: {},
    lensCaller: {},
  } as never;
}

async function call(args: Record<string, unknown>) {
  const result = await captureHandlers.synap_capture!(ctx(args));
  const block = (result.content as Array<{ type: string; text: string }>)[0];
  return JSON.parse(block.text) as Record<string, unknown>;
}

const filed = (proposalId: string, deduped = false) => ({
  proposalId,
  entityCount: 1,
  relationCount: 0,
  bindingCount: 0,
  reviewUrl: `https://x/open/${proposalId}`,
  summary: "summary",
  applied: false,
  ...(deduped ? { deduped: true } : {}),
  sessionId: "S-REQUESTED",
  scope: { workspaceId: null, projectId: null, sessionId: "S-REQUESTED" },
  writeReceipt: {
    state: "pending",
    proposalId,
    effectiveWorkspaceId: null,
    projectId: null,
    source: "agent",
  },
});

const match = (proposalId: string, score: number) => ({
  proposalId,
  proposalType: "import.graph",
  entityTitle: "Acme onboarding plan",
  profileSlug: "note",
  reviewUrl: `https://x/open/${proposalId}`,
  score,
});

beforeEach(() => {
  h.proposalRows = [];
  h.selectThrows = false;
  findPendingTextMatches.mockReset();
  submitCaptureGraph.mockClear();
  h.submitResult = filed("prop-new");
});

describe("synap_capture — fuzzy pending twins are advice (C2-b)", () => {
  it("returns pendingMatches with their reviewUrl, and the write is still filed", async () => {
    findPendingTextMatches.mockResolvedValue([match("prop-old", 2)]);
    const out = await call({
      entities: [{ profileSlug: "note", title: "Acme onboarding notes" }],
    });
    expect(submitCaptureGraph).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("proposed");
    expect(out.proposalId).toBe("prop-new");
    expect(out.pendingMatches).toEqual([
      expect.objectContaining({
        proposalId: "prop-old",
        reviewUrl: "https://x/open/prop-old",
      }),
    ]);
    expect(out.pendingMatchesHint).toMatch(/Advice only/);
    expect(findPendingTextMatches).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "user-1",
        query: "Acme onboarding notes",
      })
    );
  });

  it("scans each NEW titled entity once, keeps each proposal once at its best score", async () => {
    findPendingTextMatches.mockImplementation(async (_db, params) =>
      params.query === "Acme onboarding notes"
        ? [match("prop-a", 2), match("prop-b", 2)]
        : [match("prop-a", 3)]
    );
    const out = await call({
      entities: [
        { profileSlug: "note", title: "Acme onboarding notes" },
        { profileSlug: "note", title: "Acme onboarding checklist" },
        {
          profileSlug: "company",
          title: "Acme",
          existingEntityId: "11111111-1111-4111-8111-111111111111",
        },
      ],
    });
    expect(findPendingTextMatches).toHaveBeenCalledTimes(2);
    const matches = out.pendingMatches as Array<{
      proposalId: string;
      score: number;
    }>;
    expect(matches.map((m) => [m.proposalId, m.score])).toEqual([
      ["prop-a", 3],
      ["prop-b", 2],
    ]);
  });

  it("the proposal the call returned is not advice about itself", async () => {
    h.submitResult = filed("prop-twin", true);
    findPendingTextMatches.mockResolvedValue([match("prop-twin", 2)]);
    const out = await call({
      entities: [{ profileSlug: "note", title: "Acme onboarding notes" }],
    });
    expect(out.status).toBe("duplicate");
    expect(out.pendingMatches).toBeUndefined();
  });

  it("a failed scan drops the advice, never the write", async () => {
    findPendingTextMatches.mockRejectedValue(new Error("db down"));
    const out = await call({
      entities: [{ profileSlug: "note", title: "Acme onboarding notes" }],
    });
    expect(submitCaptureGraph).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("proposed");
    expect(out.pendingMatches).toBeUndefined();
  });
});
