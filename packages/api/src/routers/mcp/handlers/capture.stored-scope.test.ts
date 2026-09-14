import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `synap_capture` REPORTS WHERE IT STORED THE WRITE — on every lane that wrote.
 *
 * Driven through the real MCP capture handler. Stubbed at module seams only:
 * the submit core (its own row-read is pinned in
 * `submit-capture-graph.stored-scope.test.ts`), the tRPC capture router, the
 * intake/channel side-effects, and the `db.select` the text lane's read-back
 * issues — so `readStoredProposalScope` runs for real against fixture rows.
 *
 * Every fixture differs from what the handler itself knows (the call's
 * `sessionId`, the rung-1–2 derived project), so an echo cannot pass.
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
vi.mock("../../../services/intake/record-structure-intake.js", () => ({
  recordStructureIntake: vi.fn(async () => null),
}));
vi.mock("../../../services/intake/record-session-run-manifest.js", () => ({
  runFactsFromStructureMeta: () => ({}),
}));
vi.mock("../../../utils/pending-capture-dedup.js", () => ({
  computeCaptureGraphIdempotencyKey: () => "k".repeat(64),
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

const TEXT = { text: "Ada prefers async standups" };

beforeEach(() => {
  h.proposalRows = [];
  h.selectThrows = false;
  h.structureResult = {
    proposals: [{ tempId: "t1", profileSlug: "note", title: "Ada" }],
    relations: [],
    sessionId: "S-REQUESTED",
  };
});

describe("graph lane", () => {
  it("(a) a dedup hit reports the PRIOR stored session + project, not the requested session", async () => {
    h.submitResult = {
      proposalId: "prop-prior",
      entityCount: 1,
      relationCount: 0,
      bindingCount: 0,
      reviewUrl: "https://x/open/prop-prior",
      summary: "summary",
      applied: false,
      deduped: true,
      sessionId: "S-PRIOR",
      scope: { workspaceId: null, projectId: "P-PRIOR", sessionId: "S-PRIOR" },
      writeReceipt: {
        state: "pending",
        proposalId: "prop-prior",
        effectiveWorkspaceId: null,
        projectId: "P-PRIOR",
        source: "agent",
      },
    };

    const out = await call({
      entities: [{ profileSlug: "note", title: "Ada prefers async" }],
    });

    expect(out.scope).toEqual({
      workspaceId: null,
      projectId: "P-PRIOR",
      sessionId: "S-PRIOR",
    });
    expect(out.sessionId).toBe("S-PRIOR");
    // `deduped` rides through to the shared `ok()` shaper.
    expect(out.status).toBe("duplicate");
  });
});

describe("text lane — proposed", () => {
  it("(b) reports the project + session the INSERT stored (declared focus, minted session)", async () => {
    h.executeResult = {
      status: "proposed",
      proposalId: "prop-text",
      sessionId: null,
      created: [],
    };
    h.proposalRows = [
      {
        id: "prop-text",
        workspaceId: null,
        projectId: "P-FOCUS",
        sessionId: "S-MINTED",
      },
    ];

    const out = await call(TEXT);

    expect(out.status).toBe("proposed");
    expect(out.scope).toEqual({
      workspaceId: null,
      projectId: "P-FOCUS",
      sessionId: "S-MINTED",
    });
    expect(out.sessionId).toBe("S-MINTED");
    expect(out.scopeUnverified).toBeUndefined();
  });

  it("a FAILED read-back is flagged, never passed off as a stored null", async () => {
    h.executeResult = {
      status: "proposed",
      proposalId: "prop-text",
      sessionId: null,
      created: [],
    };
    h.selectThrows = true;

    const out = await call(TEXT);

    expect(out.scopeUnverified).toBe("read-failed");
    expect((out.scope as { projectId: unknown }).projectId).toBeNull();
  });

  it("several proposals that do NOT share a scope are each named", async () => {
    h.executeResult = {
      status: "proposed",
      proposalIds: ["prop-1", "prop-2"],
      sessionId: null,
      created: [],
    };
    h.proposalRows = [
      { id: "prop-1", workspaceId: null, projectId: "P-1", sessionId: "S-1" },
      { id: "prop-2", workspaceId: null, projectId: "P-2", sessionId: "S-2" },
    ];

    const out = await call(TEXT);

    expect((out.scope as { projectId: unknown }).projectId).toBe("P-1");
    expect(out.proposalScopes).toEqual([
      {
        proposalId: "prop-1",
        workspaceId: null,
        projectId: "P-1",
        sessionId: "S-1",
      },
      {
        proposalId: "prop-2",
        workspaceId: null,
        projectId: "P-2",
        sessionId: "S-2",
      },
    ]);
  });
});

describe("text lane — applied", () => {
  it("reports no project and no session when execute linked and filed none", async () => {
    h.executeResult = {
      status: "applied",
      created: [{ title: "Ada" }],
      sessionId: null,
    };

    const out = await call(TEXT);

    expect(out.status).toBe("applied");
    expect(out.scope).toEqual({
      workspaceId: null,
      projectId: null,
      sessionId: null,
    });
    expect(
      (out.writeReceipt as { projectId?: unknown }).projectId
    ).toBeUndefined();
  });

  it("reports the LINKED project execute stored", async () => {
    h.executeResult = {
      status: "applied",
      created: [{ title: "Ada" }],
      sessionId: "S-RUN",
      project: { projectId: "P-LINKED", rung: 4, status: "linked" },
    };

    const out = await call(TEXT);

    expect(out.scope).toEqual({
      workspaceId: null,
      projectId: "P-LINKED",
      sessionId: "S-RUN",
    });
  });
});

describe("global lane", () => {
  it("reports no session and no project for a knowledge_keys row", async () => {
    const { knowledgeKeysRepository } = await import("@synap/database");
    vi.spyOn(knowledgeKeysRepository, "upsert").mockResolvedValue({
      key: "k",
    } as never);

    const out = await call({ text: "Runbook: rotate the key", global: true });

    expect(out.scope).toEqual({
      workspaceId: null,
      projectId: null,
      sessionId: null,
    });
    expect(
      (out.writeReceipt as { projectId?: unknown }).projectId
    ).toBeUndefined();
  });
});
