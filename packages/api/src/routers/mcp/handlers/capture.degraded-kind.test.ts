import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `synap_capture`'s `profileSlug` reaches the degraded fallback (ticket
 * fb83317d), and the agent is told the kind it actually got.
 *
 * Driven through the real MCP capture handler with the tRPC capture router
 * stubbed (same seams as `capture.stored-scope.test.ts`). The router's own
 * half — resolving the hint to a kind and filing it — is pinned through the
 * real `capture.structure` in `routers/__tests__/capture.degraded-kind-hint.test.ts`.
 */

const h = vi.hoisted(() => ({
  proposalRows: [] as Array<Record<string, unknown>>,
  selectThrows: false,
  submitResult: undefined as unknown,
  structureResult: undefined as unknown,
  executeResult: undefined as unknown,
  structureInputs: [] as unknown[],
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
}));
vi.mock("../../capture.js", () => ({
  captureRouter: {
    createCaller: () => ({
      structure: async (input: unknown) => {
        h.structureInputs.push(input);
        return h.structureResult;
      },
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

function ctx(args: Record<string, unknown>) {
  return {
    toolName: "synap_capture",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.write"],
    agentUserId: "agent-1",
    // The session THIS call carried — what a receipt echo would report.
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

const degraded = (profileSlug: string) => ({
  proposals: [{ tempId: "t1", profileSlug, title: "Call the accountant" }],
  relations: [],
  sessionId: "S-REQUESTED",
  degraded: true,
  degradedReason: "is_invalid_response",
});

beforeEach(() => {
  h.structureInputs = [];
  h.executeResult = {
    status: "applied",
    created: [{ title: "Call the accountant" }],
    sessionId: null,
  };
});

describe("synap_capture degraded fallback — the caller's kind", () => {
  it("forwards `profileSlug` to structure, and names the kind that was filed", async () => {
    h.structureResult = degraded("task");
    const out = await call({
      text: "Call the accountant",
      profileSlug: "task",
    });

    expect(h.structureInputs).toEqual([
      expect.objectContaining({ profileSlug: "task" }),
    ]);
    expect(out.degraded).toBe(true);
    expect(out.degradedNotice).toMatch(
      /saved as a raw `task` \(the kind you passed\)/
    );
    expect(out.degradedNotice).not.toMatch(/RAW NOTE/);
  });

  it("a hint the pod could not honour (filed as a note) still says RAW NOTE", async () => {
    h.structureResult = degraded("note");
    const out = await call({
      text: "Call the accountant",
      profileSlug: "crm-lead",
    });

    expect(out.degradedNotice).toMatch(/RAW NOTE/);
  });
});
