/**
 * Unit tests for the import:file:progress emit sequence in ImportOrchestrator.
 *
 * Scope: only the three emit-ordering rules:
 *   1. `processing` fires before work starts for each file.
 *   2. `done` fires on success (storage + processing succeeded).
 *   3. `error` fires (with message) and `done` is suppressed when storage throws.
 *
 * Strategy: mock `emitImportFileProgress` and `storage.upload`; stub every
 * other heavy dependency so the orchestrator can be instantiated without a
 * real DB, tRPC context, or intelligence service.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that pull in the modules.
// ---------------------------------------------------------------------------

const { emitImportFileProgressMock } = vi.hoisted(() => ({
  emitImportFileProgressMock: vi.fn().mockResolvedValue(undefined),
}));

const { storageUploadMock } = vi.hoisted(() => ({
  storageUploadMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/event-emit.js", () => ({
  emitImportFileProgress: emitImportFileProgressMock,
}));

vi.mock("@synap/storage", () => ({
  storage: { upload: storageUploadMock },
}));

// Stub heavy deps that are not exercised by these three test cases.
vi.mock("@synap/database", () => ({
  db: {},
  messages: {},
  MessageRole: { USER: "user", ASSISTANT: "assistant", SYSTEM: "system" },
  MessageAuthorType: { HUMAN: "human", AI_AGENT: "ai_agent" },
  getDb: vi.fn(),
  ProfileResolutionService: vi.fn(),
  eq: vi.fn(),
  workspaces: {},
  workspaceMembers: {},
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../routers/channels.js", () => ({
  channelsRouter: { createCaller: vi.fn(() => ({})) },
}));

vi.mock("../import/import-parsers.js", () => ({
  detectJsonChatShape: vi.fn().mockReturnValue(null),
}));

vi.mock("../import/import-adapters.js", () => ({
  adaptItems: vi.fn().mockReturnValue([]),
}));

vi.mock("../import/import-items.js", () => ({
  buildImportProposal: vi.fn(),
  importProposalToComposite: vi.fn(),
}));

vi.mock("../import/import-ai.js", () => ({
  aiEnrichImportItems: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../import/import-deep.js", () => ({
  deepStructureImportItems: vi.fn(),
  makeGraphResolver: vi.fn(),
}));

vi.mock("../utils/intelligence-routing.js", () => ({
  resolveIntelligenceService: vi.fn(),
}));

vi.mock("@synap/search", () => ({
  searchService: {},
}));

vi.mock("../utils/import-path.js", () => ({
  sanitizeImportPath: (p: string) => p,
  mimeFromPath: vi.fn().mockReturnValue(null),
}));

vi.mock("../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: vi.fn(),
}));

vi.mock("@synap/jobs", () => ({
  getBoss: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Subject under test — imported after all mocks are registered.
// ---------------------------------------------------------------------------

import { ImportOrchestrator } from "../services/import-orchestrator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = "user_test";
const WORKSPACE_ID = "ws_test";

function makeOrchestrator() {
  return new ImportOrchestrator({
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    trpcCtx: {},
  });
}

/** Encode a minimal file item for submitBatch. */
function makeItem(path: string, content = "hello") {
  return {
    path,
    contentBase64: Buffer.from(content).toString("base64"),
    mimeType: "application/octet-stream", // non-transformable — no deep processing
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("import:file:progress emit sequence", () => {
  beforeEach(() => {
    emitImportFileProgressMock.mockClear();
    storageUploadMock.mockClear();
    // Default: upload succeeds.
    storageUploadMock.mockResolvedValue(undefined);
  });

  it("emits `processing` before storage upload for each file", async () => {
    // Intercept upload to assert emit order at the point of call.
    let processingCalledBeforeUpload = false;
    storageUploadMock.mockImplementation(async () => {
      // At this point `processing` should already have been emitted.
      const calls = emitImportFileProgressMock.mock.calls;
      processingCalledBeforeUpload =
        calls.length > 0 && calls[calls.length - 1][0].status === "processing";
    });

    await makeOrchestrator().submitBatch([makeItem("file.bin")]);

    expect(processingCalledBeforeUpload).toBe(true);
  });

  it("emits `done` after a successful file (non-transformable)", async () => {
    await makeOrchestrator().submitBatch([makeItem("file.bin")]);

    const statuses = emitImportFileProgressMock.mock.calls.map(
      (c) => c[0].status
    );
    expect(statuses).toContain("processing");
    expect(statuses).toContain("done");
    expect(statuses).not.toContain("error");
  });

  it("emits `error` with message and suppresses `done` when storage throws", async () => {
    storageUploadMock.mockRejectedValue(new Error("S3 timeout"));

    await makeOrchestrator().submitBatch([makeItem("file.bin")]);

    const calls = emitImportFileProgressMock.mock.calls.map((c) => c[0]);
    const statuses = calls.map((c) => c.status);

    expect(statuses).toContain("processing");
    expect(statuses).toContain("error");
    expect(statuses).not.toContain("done");

    const errorCall = calls.find((c) => c.status === "error");
    expect(errorCall?.error).toBe("S3 timeout");
    expect(errorCall?.batchId).toBeTypeOf("string");
    expect(errorCall?.path).toBe("file.bin");
  });
});
