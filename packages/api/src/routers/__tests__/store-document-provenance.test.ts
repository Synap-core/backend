/**
 * `storeDocumentFromBuffer` records WHO stored a blob on the documents row:
 * an agent key → ai_agent, the pod's own background job → system, otherwise a
 * human upload. A system copy must never read as a human upload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ setBody: vi.fn() }));

vi.mock("@synap/storage", () => ({
  StorageUploadUnavailableError: class extends Error {},
  storage: {},
}));
vi.mock("@synap/database", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [{ id: "doc-1", storageKey: "k" }],
  };
  return {
    db: { select: () => chain },
    eq: vi.fn(),
    entities: {},
    documents: { id: "id" },
    workspaces: {},
    eventRepository: {},
    EntityBodyService: class {
      setBody = h.setBody;
    },
    materializeEntity: vi.fn(),
    resolveImportEntityPlacement: vi.fn(),
  };
});
vi.mock("@synap/database/schema", () => ({ channelContextItems: {} }));
vi.mock("../../utils/stored-file-access.js", () => ({
  loadSignableDocument: vi.fn(),
  loadSignableFileEntity: vi.fn(),
}));

import { storeDocumentFromBuffer } from "../file-upload.js";

const base = {
  userId: "owner-1",
  workspaceId: null,
  buffer: Buffer.from("x"),
  mimeType: "image/png",
  filename: "a.png",
};

beforeEach(() => {
  h.setBody.mockReset();
  h.setBody.mockResolvedValue({
    documentId: "doc-1",
    storageKey: "k",
    storageUrl: "u",
    size: 1,
  });
});

const provenanceOf = () =>
  (h.setBody.mock.calls[0]![0] as { provenance: unknown }).provenance;

describe("storeDocumentFromBuffer provenance", () => {
  it("a background copy is system, owned by the entity owner", async () => {
    await storeDocumentFromBuffer({ ...base, storedBySystem: true });
    expect(provenanceOf()).toEqual({
      createdByKind: "system",
      createdByUserId: "owner-1",
    });
  });

  it("an agent key is ai_agent", async () => {
    await storeDocumentFromBuffer({ ...base, actorAgentUserId: "agent-1" });
    expect(provenanceOf()).toEqual({
      createdByKind: "ai_agent",
      createdByUserId: "agent-1",
    });
  });

  it("otherwise a human upload", async () => {
    await storeDocumentFromBuffer(base);
    expect(provenanceOf()).toEqual({
      createdByKind: "human",
      createdByUserId: "owner-1",
    });
  });
});

describe("storeDocumentFromBuffer — a media copy is marked as one", () => {
  const metadataOf = () =>
    (h.setBody.mock.calls[0]![0] as { metadata?: unknown }).metadata;

  it("names the entity it is a picture of, so lists can leave it out", async () => {
    await storeDocumentFromBuffer({
      ...base,
      storedBySystem: true,
      mediaCopyOf: "entity-7",
    });
    expect(metadataOf()).toEqual({
      uploadKind: "media-copy",
      mediaCopyOf: "entity-7",
    });
  });

  it("an upload carries no media-copy mark", async () => {
    await storeDocumentFromBuffer(base);
    expect(metadataOf()).toBeUndefined();
  });
});
