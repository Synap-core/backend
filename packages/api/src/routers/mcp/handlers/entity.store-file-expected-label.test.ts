/**
 * BUG #9, the `synap_store_file` door: a stored file's `expectedLabel` must
 * reach the GOVERNANCE gate, not only the artifact.
 *
 * The door recorded `expectedLabel` on the session artifact, but its gates run
 * inside helpers — `createGovernedFileEntityFromBuffer` (→ `entities.create`,
 * which hands `input.expectedLabel` to `checkPermissionOrPropose` rung 0) and
 * `storeEntitySourceBlob` (attach mode, its own gate) — and neither received
 * the label. The approval then stamped the FIRST open slot of the kind, so two
 * files stored in reverse order swapped slots.
 *
 * Drives the REAL handler through the REAL `createGovernedFileEntityFromBuffer`
 * and captures what `entities.create` (the gated door) receives. That door's
 * own resolution of the label against the session is pinned by
 * `permission-check.auto-approve-satisfies-outputs.test.ts` (the 2,1,3,4 case)
 * and by the `entities.create` chunk of the expectedLabel tripwire.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  creates: [] as Array<Record<string, unknown>>,
  ctxSessions: [] as unknown[],
  attaches: [] as Array<Record<string, unknown>>,
  artifacts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ProfileResolutionService: class {
    getEntityScope = async () => "pod";
  },
}));
vi.mock("../../file-upload.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storeDocumentFromBuffer: async (p: { filename: string }) => ({
    documentId: `doc-${p.filename}`,
    storageKey: `files/${p.filename}`,
    storageUrl: "u",
    size: 4,
    document: { id: `doc-${p.filename}` },
  }),
}));
vi.mock("../../entities.js", () => ({
  entitiesRouter: {
    createCaller: () => ({
      create: async (input: Record<string, unknown>) => {
        h.creates.push(input);
        return { id: `ent-${String(input.title)}` };
      },
    }),
  },
}));
vi.mock("../../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: async (
    _u: string,
    _s: string[],
    _ws: unknown,
    _x: unknown,
    sessionId: unknown
  ) => {
    h.ctxSessions.push(sessionId);
    return {};
  },
}));
vi.mock("../../../utils/hub-protocol-rate-limit.js", () => ({
  checkHubRateLimit: () => undefined,
}));
vi.mock("../../../utils/store-entity-source-blob.js", () => ({
  storeEntitySourceBlob: async (input: Record<string, unknown>) => {
    h.attaches.push(input);
    return { status: "stored", documentId: "doc-attached" };
  },
}));
vi.mock("../../../services/focus-sessions/record-session-artifact.js", () => ({
  recordSessionArtifact: async (input: Record<string, unknown>) => {
    h.artifacts.push(input);
  },
}));

import { entityHandlers } from "./entity.js";
import type { McpToolContext } from "./shared.js";

const SESSION = "55555555-1111-4111-8111-111111111111";
const WS = "11111111-1111-4111-8111-111111111111";
const SLOT_A = "Signed contract (PDF)";
const SLOT_B = "Invoice scan";

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_store_file",
    args: { mimeType: "text/plain", content: "body", ...args },
    userId: "user-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "agent-1",
    sessionId: SESSION,
    requestedWorkspaceId: WS,
  } as unknown as McpToolContext;
}

const store = entityHandlers.synap_store_file!;

beforeEach(() => {
  h.creates = [];
  h.ctxSessions = [];
  h.attaches = [];
  h.artifacts = [];
});

describe("synap_store_file — the declared slot reaches the gate", () => {
  it("two files stored in REVERSE slot order each give the gate their own slot", async () => {
    // Titled unlike their slots, so only the declared label can bind them.
    await store(
      ctx({ filename: "b.txt", title: "scan-0042", expectedLabel: SLOT_B })
    );
    await store(
      ctx({ filename: "a.txt", title: "final.pdf", expectedLabel: SLOT_A })
    );

    // The gated door got each file's own claim, under the session handle.
    expect(h.creates.map((c) => [c.title, c.expectedLabel])).toEqual([
      ["scan-0042", SLOT_B],
      ["final.pdf", SLOT_A],
    ]);
    expect(h.ctxSessions).toEqual([SESSION, SESSION]);
    // ...and it is the SAME claim the artifact records for that object.
    expect(h.artifacts.map((a) => [a.refId, a.expectedLabel])).toEqual([
      ["ent-scan-0042", SLOT_B],
      ["ent-final.pdf", SLOT_A],
    ]);
  });

  it("no label: the gated door claims nothing (the key is absent, not empty)", async () => {
    await store(ctx({ filename: "c.txt" }));
    expect(h.creates[0]).not.toHaveProperty("expectedLabel");
  });

  it("attach mode gives the attach gate the label AND the session", async () => {
    await store(
      ctx({
        filename: "d.txt",
        attachToEntityId: "eeeeeeee-1111-4111-8111-111111111111",
        expectedLabel: SLOT_A,
      })
    );
    // Picked, not `toMatchObject` on the whole input: it holds the real `db`,
    // and a failure diff serialising it OOMs the worker (seen on the negctl).
    const { sessionId, expectedLabel } = h.attaches[0]!;
    expect({ sessionId, expectedLabel }).toEqual({
      sessionId: SESSION,
      expectedLabel: SLOT_A,
    });
    expect(h.artifacts[0]).toMatchObject({ expectedLabel: SLOT_A });
  });
});
