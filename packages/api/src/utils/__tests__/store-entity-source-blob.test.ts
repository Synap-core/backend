/**
 * storeEntitySourceBlob — size guards, property contract, the `documentId`
 * no-clobber guard, and the governance gate (unit, mocked storage/db).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const uploadMock = vi.fn();
const storageDeleteMock = vi.fn();
const buildPathMock = vi.fn(
  (userId: string, kind: string, id: string, ext: string) =>
    `users/${userId}/${kind}/${id}.${ext}`
);

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (...args: unknown[]) =>
      buildPathMock(...(args as [string, string, string, string])),
    upload: (...args: unknown[]) => uploadMock(...args),
    delete: (...args: unknown[]) => storageDeleteMock(...args),
  },
}));

const docCreateMock = vi.fn();
const docDeleteMock = vi.fn();
const entityUpdateMock = vi.fn();

// TOTAL mock — every symbol the module under test imports from @synap/database
// must be listed here. `entities`/`and`/`eq`/`isNull` are used by the
// documentId no-clobber UPDATE; omitting one makes it `undefined` at runtime
// with NO type error (the "total vi.mock breaks on a new import" trap).
vi.mock("@synap/database", () => ({
  eventRepository: {},
  documentVersionSnapshotFromUpload: (input: {
    metadata: { url: string; path: string; size: number; checksum?: string };
    mimeType: string;
    extractedText?: string;
  }) => ({
    storageUrl: input.metadata.url,
    storageKey: input.metadata.path,
    size: input.metadata.size,
    mimeType: input.mimeType,
    checksum: input.metadata.checksum ?? "",
    contentPreview: input.extractedText ?? "",
    metadata: input.metadata,
  }),
  entities: {
    id: "entities.id",
    userId: "entities.user_id",
    documentId: "entities.document_id",
  },
  documents: { id: "documents.id" },
  and: (...a: unknown[]) => ({ _and: a }),
  eq: (a: unknown, b: unknown) => ({ _eq: [a, b] }),
  isNull: (a: unknown) => ({ _isNull: a }),
  DocumentRepository: class {
    create = docCreateMock;
    delete = docDeleteMock;
  },
  EntityRepository: class {
    update = entityUpdateMock;
  },
}));

const checkPermissionOrProposeMock = vi.fn();
vi.mock("../permission-check.js", () => ({
  checkPermissionOrPropose: (...a: unknown[]) =>
    checkPermissionOrProposeMock(...a),
}));

import {
  storeEntitySourceBlob,
  attachSourceBlob,
  discardSourceBlob,
  discardProposalSourceBlob,
  entityBodyDocumentIdFrom,
  SourceBlobTooLargeError,
  SourceBlobEmptyError,
  SourceBlobDeniedError,
  SourceBlobOwnershipError,
  SOURCE_BLOB_MAX_BYTES,
} from "../store-entity-source-blob.js";

/**
 * Minimal drizzle chain stand-in for `db.update(...).set(...).where(...).returning()`
 * plus the `query.documents.findFirst` read the ownership gate performs.
 *
 * `docRow` is what that read returns — the LOADED row both the attach and the
 * discard now authorize against. `null` = the document does not exist.
 */
function makeDb(
  returning: Array<{ id: string }>,
  docRow: { id: string; userId: string; storageKey: string | null } | null = {
    id: "doc-1",
    userId: "u1",
    storageKey: "users/u1/entity/e1.wav",
  }
) {
  const returningMock = vi.fn().mockResolvedValue(returning);
  const whereMock = vi.fn(() => ({ returning: returningMock }));
  const setMock = vi.fn(() => ({ where: whereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));
  const docFindFirstMock = vi.fn().mockResolvedValue(docRow ?? undefined);
  return {
    db: {
      update: updateMock,
      query: { documents: { findFirst: docFindFirstMock } },
    } as never,
    updateMock,
    setMock,
    whereMock,
    docFindFirstMock,
  };
}

describe("storeEntitySourceBlob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadMock.mockResolvedValue({
      url: "https://storage.example/wav",
      path: "users/u1/entity/e1.wav",
      size: 4,
    });
    docCreateMock.mockResolvedValue({ id: "doc-1" });
    docDeleteMock.mockResolvedValue(undefined);
    entityUpdateMock.mockResolvedValue({});
    checkPermissionOrProposeMock.mockResolvedValue({ granted: true });
  });

  it("rejects empty buffers", async () => {
    await expect(
      storeEntitySourceBlob({
        database: makeDb([]).db,
        userId: "u1",
        entityId: "e1",
        buffer: Buffer.alloc(0),
        mimeType: "audio/wav",
      })
    ).rejects.toBeInstanceOf(SourceBlobEmptyError);
  });

  it("rejects oversize buffers", async () => {
    await expect(
      storeEntitySourceBlob({
        database: makeDb([]).db,
        userId: "u1",
        entityId: "e1",
        buffer: Buffer.alloc(SOURCE_BLOB_MAX_BYTES + 1),
        mimeType: "audio/wav",
      })
    ).rejects.toBeInstanceOf(SourceBlobTooLargeError);
  });

  it("uploads, creates document, and stamps provenance properties", async () => {
    const { db } = makeDb([{ id: "e1" }]);
    const result = await storeEntitySourceBlob({
      database: db,
      userId: "u1",
      entityId: "e1",
      buffer: Buffer.from("RIFF....WAVE"),
      mimeType: "audio/wav",
      filename: "output.wav",
      workspaceId: null,
    });

    expect(uploadMock).toHaveBeenCalledOnce();
    expect(docCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "output.wav",
        mimeType: "audio/wav",
        storageKey: "users/u1/entity/e1.wav",
        userId: "u1",
      }),
      "u1"
    );
    expect(entityUpdateMock).toHaveBeenCalledWith(
      "e1",
      {
        properties: expect.objectContaining({
          sourceFileDocumentId: "doc-1",
          sourceFileUrl: "https://storage.example/wav",
          sourceFileSize: 4,
          sourceFileMimeType: "audio/wav",
          sourceFileName: "output.wav",
        }),
      },
      "u1"
    );
    expect(result.status).toBe("stored");
    if (result.status !== "stored") throw new Error("unreachable");
    expect(result.documentId).toBe("doc-1");
    expect(result.storageKey).toBe("users/u1/entity/e1.wav");
  });

  // T3 — the regression the embedding worker / retrieval join / Typesense
  // enrichment all depend on: they key off `entities.document_id`, which this
  // door never set, so an attached source file was invisible to all three.
  it("sets entities.documentId, guarded by IS NULL so a body is never clobbered", async () => {
    const { db, updateMock, setMock, whereMock } = makeDb([{ id: "e1" }]);
    const res = await attachSourceBlob({
      database: db,
      userId: "u1",
      entityId: "e1",
      staged: {
        documentId: "doc-1",
        storageKey: "k",
        storageUrl: "u",
        size: 4,
        mimeType: "audio/wav",
      },
    });
    expect(updateMock).toHaveBeenCalledOnce();
    expect(setMock).toHaveBeenCalledWith({ documentId: "doc-1" });
    // The no-clobber guard must be IN THE PREDICATE, not a prior read.
    expect(JSON.stringify(whereMock.mock.calls[0])).toContain("_isNull");
    expect(res.linkedAsBody).toBe(true);
  });

  it("reports linkedAsBody:false when the entity already has a body document", async () => {
    const { db } = makeDb([]); // guarded UPDATE matched no row
    const res = await attachSourceBlob({
      database: db,
      userId: "u1",
      entityId: "e1",
      staged: {
        documentId: "doc-1",
        storageKey: "k",
        storageUrl: "u",
        size: 4,
        mimeType: "audio/wav",
      },
    });
    expect(res.linkedAsBody).toBe(false);
  });

  // T5 — the write is a mutation of an existing entity's properties, so it is
  // governed. Before this it bypassed the gate entirely.
  it("routes the attach through checkPermissionOrPropose", async () => {
    const { db } = makeDb([{ id: "e1" }]);
    await storeEntitySourceBlob({
      database: db,
      userId: "u1",
      entityId: "e1",
      buffer: Buffer.from("x"),
      mimeType: "audio/wav",
    });
    expect(checkPermissionOrProposeMock).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "entity", action: "update" })
    );
  });

  it("on a PROPOSED verdict keeps the blob staged and attaches NOTHING", async () => {
    checkPermissionOrProposeMock.mockResolvedValue({
      granted: false,
      proposalId: "p-1",
      proposalType: "entity.update",
      summary: "s",
      reasoning: "r",
      reviewPath: "/open/p-1",
      reviewUrl: "https://pod/open/p-1",
    });
    const { db, updateMock } = makeDb([{ id: "e1" }]);
    const result = await storeEntitySourceBlob({
      database: db,
      userId: "u1",
      entityId: "e1",
      buffer: Buffer.from("x"),
      mimeType: "audio/wav",
    });
    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") throw new Error("unreachable");
    // The bytes exist (so approval can attach them) …
    expect(uploadMock).toHaveBeenCalledOnce();
    expect(result.staged.documentId).toBe("doc-1");
    // … but nothing was written to the entity.
    expect(entityUpdateMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    // And the blob is NOT discarded — a rejection is what discards it.
    expect(docDeleteMock).not.toHaveBeenCalled();
  });

  it("on a DENIED verdict discards the staged blob (no orphan)", async () => {
    checkPermissionOrProposeMock.mockResolvedValue({
      denied: true,
      reason: "nope",
    });
    const { db } = makeDb([{ id: "e1" }]);
    await expect(
      storeEntitySourceBlob({
        database: db,
        userId: "u1",
        entityId: "e1",
        buffer: Buffer.from("x"),
        mimeType: "audio/wav",
      })
    ).rejects.toBeInstanceOf(SourceBlobDeniedError);
    expect(storageDeleteMock).toHaveBeenCalledWith("users/u1/entity/e1.wav");
    expect(docDeleteMock).toHaveBeenCalledWith("doc-1", "u1");
    expect(entityUpdateMock).not.toHaveBeenCalled();
  });

  // T2 — a stored binary used to produce a `documents` row with
  // `currentVersion = 1` and NO `document_versions` row at all, so the
  // retrieval join (`version = currentVersion`) matched nothing and the
  // embedding worker read an empty `content`. The v1 row is now written from
  // the ALREADY-uploaded bytes (`preUploadedVersion`) — no second upload — and
  // carries the text the caller extracted upstream.
  it("writes a v1 document version carrying the caller's extracted text", async () => {
    const { db } = makeDb([{ id: "e1" }]);
    await storeEntitySourceBlob({
      database: db,
      userId: "u1",
      entityId: "e1",
      buffer: Buffer.from("%PDF-1.7 binary"),
      mimeType: "application/pdf",
      filename: "contract.pdf",
      extractedText: "Master services agreement between Acme and Ada.",
    });

    const created = docCreateMock.mock.calls[0][0] as {
      preUploadedVersion?: { snapshot: { contentPreview: string } };
    };
    expect(created.preUploadedVersion?.snapshot.contentPreview).toBe(
      "Master services agreement between Acme and Ada."
    );
    // The bytes were uploaded exactly ONCE — the version row reuses them.
    expect(uploadMock).toHaveBeenCalledOnce();
  });

  it("records truncation rather than silently keeping a short body", async () => {
    const { db } = makeDb([{ id: "e1" }]);
    await storeEntitySourceBlob({
      database: db,
      userId: "u1",
      entityId: "e1",
      buffer: Buffer.from("%PDF"),
      mimeType: "application/pdf",
      extractedText: "clipped body",
      extractedTextTruncated: true,
    });
    const created = docCreateMock.mock.calls[0][0] as {
      metadata?: Record<string, unknown>;
      preUploadedVersion?: { message?: string };
    };
    expect(created.metadata).toMatchObject({ extractedTextTruncated: true });
    expect(created.preUploadedVersion?.message).toContain("truncated");
  });

  it("still writes a v1 version (empty body) when no text was extracted", async () => {
    const { db } = makeDb([{ id: "e1" }]);
    await storeEntitySourceBlob({
      database: db,
      userId: "u1",
      entityId: "e1",
      buffer: Buffer.from("RIFF"),
      mimeType: "audio/wav",
    });
    const created = docCreateMock.mock.calls[0][0] as {
      preUploadedVersion?: { snapshot: { contentPreview: string } };
    };
    // The row must exist regardless — its absence is what broke the join.
    expect(created.preUploadedVersion).toBeDefined();
    expect(created.preUploadedVersion?.snapshot.contentPreview).toBe("");
  });
});

/**
 * P0 — the staged `documentId` / `storageKey` travel through
 * `proposals.data.sourceFile`, which is patchable JSONB. Both phases that act
 * on them must authorize against the LOADED `documents` row.
 */
describe("cross-tenant refusal", () => {
  const VICTIM_DOC = {
    documentId: "doc-victim",
    storageKey: "users/victim/entity/secret.pdf",
    storageUrl: "https://storage.example/secret.pdf",
    size: 10,
    mimeType: "application/pdf",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    entityUpdateMock.mockResolvedValue({});
    docDeleteMock.mockResolvedValue(undefined);
  });

  it("attach REFUSES a documentId owned by someone else, and writes nothing", async () => {
    const { db, updateMock } = makeDb([{ id: "e1" }], {
      id: "doc-victim",
      userId: "victim",
      storageKey: "users/victim/entity/secret.pdf",
    });
    await expect(
      attachSourceBlob({
        database: db,
        userId: "attacker",
        entityId: "e-attacker",
        staged: VICTIM_DOC,
      })
    ).rejects.toBeInstanceOf(SourceBlobOwnershipError);
    // Neither leg ran: no provenance properties, and — the actual leak — no
    // `entities.document_id` pointing at the victim's document.
    expect(entityUpdateMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("attach refuses when the document does not exist at all", async () => {
    const { db } = makeDb([{ id: "e1" }], null);
    await expect(
      attachSourceBlob({
        database: db,
        userId: "u1",
        entityId: "e1",
        staged: VICTIM_DOC,
      })
    ).rejects.toBeInstanceOf(SourceBlobOwnershipError);
    expect(entityUpdateMock).not.toHaveBeenCalled();
  });

  it("attach floors the documentId link on the OWNER too", async () => {
    const { db, whereMock } = makeDb([{ id: "e1" }]);
    await attachSourceBlob({
      database: db,
      userId: "u1",
      entityId: "e1",
      staged: {
        documentId: "doc-1",
        storageKey: "users/u1/entity/e1.wav",
        storageUrl: "u",
        size: 4,
        mimeType: "audio/wav",
      },
    });
    // The guarded UPDATE carries BOTH the no-clobber guard and an owner floor.
    const predicate = JSON.stringify(whereMock.mock.calls[0]);
    expect(predicate).toContain("_isNull");
    expect(predicate).toContain("entities.user_id");
  });

  it("discard REFUSES another user's document — no object delete, no row delete", async () => {
    const { db } = makeDb([], {
      id: "doc-victim",
      userId: "victim",
      storageKey: "users/victim/entity/secret.pdf",
    });
    await expect(
      discardSourceBlob({
        database: db,
        userId: "attacker",
        staged: VICTIM_DOC,
      })
    ).rejects.toBeInstanceOf(SourceBlobOwnershipError);
    expect(storageDeleteMock).not.toHaveBeenCalled();
    expect(docDeleteMock).not.toHaveBeenCalled();
  });

  it("discard deletes the LOADED row's storage key, never the caller-supplied one", async () => {
    const { db } = makeDb([], {
      id: "doc-1",
      userId: "u1",
      storageKey: "users/u1/entity/real.wav",
    });
    await discardSourceBlob({
      database: db,
      userId: "u1",
      // A crafted key pointing at someone else's object.
      staged: { documentId: "doc-1", storageKey: "users/victim/secret.pdf" },
    });
    expect(storageDeleteMock).toHaveBeenCalledWith("users/u1/entity/real.wav");
    expect(storageDeleteMock).not.toHaveBeenCalledWith(
      "users/victim/secret.pdf"
    );
  });

  it("a system scan (userId null) deletes as the document's OWN owner", async () => {
    const { db } = makeDb([], {
      id: "doc-1",
      userId: "owner-1",
      storageKey: "users/owner-1/entity/x.wav",
    });
    await discardSourceBlob({
      database: db,
      userId: null,
      staged: { documentId: "doc-1", storageKey: "whatever" },
    });
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "users/owner-1/entity/x.wav"
    );
    expect(docDeleteMock).toHaveBeenCalledWith("doc-1", "owner-1");
  });

  it("a reference to an already-deleted document is a no-op, not a failure", async () => {
    const { db } = makeDb([], null);
    await expect(
      discardSourceBlob({
        database: db,
        userId: null,
        staged: { documentId: "gone", storageKey: "k" },
      })
    ).resolves.toBeUndefined();
    expect(storageDeleteMock).not.toHaveBeenCalled();
    expect(docDeleteMock).not.toHaveBeenCalled();
  });

  it("discardProposalSourceBlob logs an ownership refusal instead of throwing", async () => {
    const { db } = makeDb([], {
      id: "doc-victim",
      userId: "victim",
      storageKey: "k",
    });
    await expect(
      discardProposalSourceBlob({
        database: db,
        userId: "attacker",
        proposalData: { sourceFile: VICTIM_DOC },
      })
    ).resolves.toBeUndefined();
    expect(storageDeleteMock).not.toHaveBeenCalled();
    expect(docDeleteMock).not.toHaveBeenCalled();
  });
});

/**
 * TASK 2 — `entities.documentId` answers two questions since source blobs
 * started setting it. A reader that means "has a body" must subtract the
 * source-blob meaning, or a genuine long-form body arriving via dedup is
 * silently discarded (the B3 regression, reintroduced).
 */
describe("entityBodyDocumentIdFrom", () => {
  it("returns the body document when the entity has one", () => {
    expect(
      entityBodyDocumentIdFrom({ documentId: "doc-body", properties: {} })
    ).toBe("doc-body");
  });

  it("returns undefined when documentId is only a SOURCE BLOB link", () => {
    expect(
      entityBodyDocumentIdFrom({
        documentId: "doc-pdf",
        properties: { sourceFileDocumentId: "doc-pdf" },
      })
    ).toBeUndefined();
  });

  it("still reports the body when a source blob is attached ALONGSIDE one", () => {
    expect(
      entityBodyDocumentIdFrom({
        documentId: "doc-body",
        properties: { sourceFileDocumentId: "doc-pdf" },
      })
    ).toBe("doc-body");
  });

  it("returns undefined for an entity with no document at all", () => {
    expect(entityBodyDocumentIdFrom({ properties: {} })).toBeUndefined();
    expect(entityBodyDocumentIdFrom({ documentId: null })).toBeUndefined();
  });
});
