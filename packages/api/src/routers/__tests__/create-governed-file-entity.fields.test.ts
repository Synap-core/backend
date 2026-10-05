/**
 * Hub `/files` door parity + the `--workspace` pin, at the governed seam.
 *
 * `synap upload --workspace X` produced an entity with workspaceId NULL. Root
 * cause (server side): the governed core hard-coded `profileSlug: "file"` — a
 * POD-scope kind — and never passed `targetWorkspaceId`, so placement (decision
 * D1: a workspace is a context signal for a pod-scope kind) filed it pod-wide.
 * The CLI did send workspaceId. Fix: an EXPLICIT pin threads `targetWorkspaceId`
 * (rung 1); the door also honours `profileSlug` + `properties` like `/upload`.
 *
 * Drives the real `createGovernedFileEntityForStoredDocument` and captures the
 * exact input `entities.create` receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  scope: "pod" as "pod" | "workspace",
  ctxWorkspace: undefined as unknown,
}));

vi.mock("@synap/database", () => ({
  db: {},
  ProfileResolutionService: class {
    getEntityScope = async () => h.scope;
  },
}));
vi.mock("../file-upload.js", async () => {
  // Keep the REAL property shaping; only the storing half is irrelevant here.
  const actual =
    await vi.importActual<typeof import("../file-upload.js")>(
      "../file-upload.js"
    );
  return { ...actual, storeDocumentFromBuffer: vi.fn() };
});
vi.mock("../entities.js", () => ({
  entitiesRouter: { createCaller: () => ({ create: h.create }) },
}));
vi.mock("../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: async (
    _u: string,
    _s: string[],
    ws: unknown
  ) => {
    h.ctxWorkspace = ws;
    return {};
  },
}));

import { createGovernedFileEntityForStoredDocument } from "../create-governed-file-entity.js";

const WS = "11111111-1111-4111-8111-111111111111";
const stored = {
  documentId: "doc-1",
  storageKey: "files/x/clip.mp4",
  storageUrl: "u",
  size: 42,
  document: { id: "doc-1", storageKey: "files/x/clip.mp4" },
};
const base = {
  mimeType: "video/mp4",
  filename: "clip.mp4",
  userId: "user-1",
  workspaceId: WS,
  scopes: ["hub-protocol.write"],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.scope = "pod";
  h.create.mockResolvedValue({ id: "ent-1" });
});

describe("governed file entity — fields + pin", () => {
  it("unpinned `file` (pod-scope) stays a context signal: no targetWorkspaceId", async () => {
    await createGovernedFileEntityForStoredDocument(stored, base);
    const input = h.create.mock.calls[0]![0];
    expect(input.profileSlug).toBe("file");
    expect(input.targetWorkspaceId).toBeUndefined();
    expect(input.properties).toEqual({ mimeType: "video/mp4", fileSize: 42 });
    expect(h.ctxWorkspace).toBeNull();
  });

  it("an explicit pin lands the entity in that workspace (rung 1)", async () => {
    await createGovernedFileEntityForStoredDocument(stored, {
      ...base,
      pinWorkspace: true,
    });
    const input = h.create.mock.calls[0]![0];
    expect(input.targetWorkspaceId).toBe(WS);
    expect(h.ctxWorkspace).toBe(WS);
  });

  it("honours profileSlug + properties like `/upload` (brand-asset shaping)", async () => {
    h.scope = "workspace";
    const r = await createGovernedFileEntityForStoredDocument(stored, {
      ...base,
      profileSlug: "brand-asset",
      properties: { variant: "dark" },
    });
    expect(r).toEqual({
      status: "created",
      fileEntityId: "ent-1",
      documentId: "doc-1",
    });
    const input = h.create.mock.calls[0]![0];
    expect(input.profileSlug).toBe("brand-asset");
    expect(input.properties).toMatchObject({
      variant: "dark",
      "asset-document-id": "doc-1",
      "asset-kind": "video",
      mimeType: "video/mp4",
      fileSize: 42,
      documentId: "doc-1",
    });
    expect(h.ctxWorkspace).toBe(WS);
  });
});
