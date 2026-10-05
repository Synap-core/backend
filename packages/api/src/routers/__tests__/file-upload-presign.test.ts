/**
 * The presigned (large-file) upload lane + the shared upload rules.
 *
 * Drives the REAL `requestPresignedUpload` / `storeDocumentFromPresignedUpload`
 * against a mocked object store and DB boundary, and the REAL per-mime caps
 * (C4) and asset-kind mapping (C3).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getSignedUploadUrl: vi.fn(),
  getMetadata: vi.fn(),
  deleteObj: vi.fn(),
  setBody: vi.fn(),
  deleteBody: vi.fn(),
  materialize: vi.fn(),
  resolveProfile: vi.fn(),
  /** `documents` row already holding the key (read by storage_key). */
  existingRows: [] as unknown[],
  /** The post-write re-read (read by id). */
  docRows: [] as unknown[],
  entityRows: [] as unknown[],
  proposalRows: [] as unknown[],
}));

vi.mock("@synap/storage", () => {
  class StorageUploadUnavailableError extends Error {
    readonly code = "STORAGE_UPLOAD_UNAVAILABLE";
  }
  return {
    StorageUploadUnavailableError,
    storage: {
      getSignedUploadUrl: h.getSignedUploadUrl,
      getMetadata: h.getMetadata,
      delete: h.deleteObj,
    },
  };
});

vi.mock("@synap/database", () => {
  const documents = { id: "id", storageKey: "storage_key" };
  const entities = { id: "id", documentId: "document_id" };
  const proposals = { id: "id", status: "status", data: "data" };
  // Rows are dispatched by the table the query reads FROM, and — for
  // `documents` — by the column it filters on (`eq` returns its column):
  // storage_key = "who owns this key?", id = the post-write re-read.
  const chain = () => {
    let table: unknown;
    let cond: unknown;
    const o: Record<string, unknown> = {};
    o.from = (t: unknown) => ((table = t), o);
    o.where = (c: unknown) => ((cond = c), o);
    o.limit = () =>
      Promise.resolve(
        table === entities
          ? h.entityRows
          : table === proposals
            ? h.proposalRows
            : cond === documents.id
              ? h.docRows
              : h.existingRows
      );
    return o;
  };
  return {
    db: { select: () => chain() },
    eq: (col: unknown) => col,
    and: vi.fn(),
    drizzleSql: vi.fn(),
    documents,
    entities,
    proposals,
    eventRepository: {},
    EntityBodyService: class {
      setBody = h.setBody;
      deleteBody = h.deleteBody;
    },
    ProfileResolutionService: class {
      resolveProfile = h.resolveProfile;
    },
    // file-upload.ts imports these.
    workspaceMembers: {},
    workspaces: {},
    materializeEntity: h.materialize,
    resolveImportEntityPlacement: vi.fn(async () => WS_FOR_MOCK),
  };
});
const WS_FOR_MOCK = "11111111-1111-4111-8111-111111111111";
vi.mock("@synap/database/schema", () => ({ channelContextItems: {} }));
vi.mock("@synap/auth", () => ({ authMiddleware: vi.fn() }));
vi.mock("../../access/guest-containment.js", () => ({
  refuseGuestSession: vi.fn(),
}));

import {
  requestPresignedUpload,
  storeDocumentFromPresignedUpload,
  parsePresignedUploadKey,
} from "../file-upload-presign.js";
import {
  createFileEntityForStoredDocument,
  brandAssetKindForMimeType,
  maxUploadBytesForMimeType,
  maxBufferedUploadBytes,
  isAllowedMimeType,
  parseUploadEntityFields,
  uploadEntityProperties,
} from "../file-upload.js";
import { StorageUploadUnavailableError } from "@synap/storage";

const MB = 1024 * 1024;
const WS = "11111111-1111-4111-8111-111111111111";
const USER = "user-1";

beforeEach(() => {
  vi.clearAllMocks();
  h.existingRows = [];
  h.docRows = [{ id: "doc-1", storageKey: "k" }];
  h.entityRows = [];
  h.proposalRows = [];
  h.resolveProfile.mockResolvedValue({ id: "profile-1" });
  h.deleteObj.mockResolvedValue(undefined);
  h.getSignedUploadUrl.mockResolvedValue(
    "https://pod.example/synap-storage/k?sig"
  );
});

describe("C4 caps", () => {
  it.each([
    ["video/mp4", 500 * MB],
    ["audio/mpeg", 100 * MB],
    ["application/zip", 200 * MB],
    ["font/woff2", 5 * MB],
    ["image/png", 10 * MB],
    ["application/pdf", 10 * MB],
  ])("%s → %d bytes", (mime, cap) => {
    expect(maxUploadBytesForMimeType(mime)).toBe(cap);
  });

  it("the buffered doors never exceed 10MB, and fonts stay at 5MB", () => {
    expect(maxBufferedUploadBytes("video/mp4")).toBe(10 * MB);
    expect(maxBufferedUploadBytes("font/ttf")).toBe(5 * MB);
  });

  it("allows the four font types", () => {
    for (const m of ["font/woff2", "font/woff", "font/ttf", "font/otf"]) {
      expect(isAllowedMimeType(m)).toBe(true);
    }
  });
});

describe("C3 brandAssetKindForMimeType", () => {
  it.each([
    ["image/png", "image"],
    ["video/mp4", "video"],
    ["audio/wav", "audio"],
    ["font/woff2", "font"],
    ["application/pdf", "document"],
    ["application/zip", "other"],
  ])("%s → %s", (mime, kind) => {
    expect(brandAssetKindForMimeType(mime)).toBe(kind);
  });

  it("reaches the brand-asset entity properties (unless the caller set one)", () => {
    const props = uploadEntityProperties({
      profileSlug: "brand-asset",
      mimeType: "font/woff2",
      size: 10,
      filename: "a.woff2",
      documentId: "d",
      storageKey: "k",
    });
    expect(props["asset-kind"]).toBe("font");
    expect(props["asset-document-id"]).toBe("d");
  });
});

describe("parseUploadEntityFields (one parser for every door)", () => {
  it("reads profileSlug + properties JSON", () => {
    expect(
      parseUploadEntityFields({
        profileSlug: "brand-asset",
        properties: '{"variant":"dark"}',
      })
    ).toEqual({
      profileSlug: "brand-asset",
      storageKeyProperty: "storageKey",
      properties: { variant: "dark" },
    });
  });
  it("accepts an already-parsed object (JSON bodies)", () => {
    const r = parseUploadEntityFields({ properties: { a: 1 } });
    expect("error" in r ? null : r.properties).toEqual({ a: 1 });
  });
  it("rejects bad JSON and non-objects", () => {
    expect(parseUploadEntityFields({ properties: "{nope" })).toHaveProperty(
      "error"
    );
    expect(parseUploadEntityFields({ properties: "[1]" })).toHaveProperty(
      "error"
    );
  });
});

describe("requestPresignedUpload", () => {
  it("issues a signed PUT for a 400MB video, key bound to workspace + user", async () => {
    const r = await requestPresignedUpload({
      userId: USER,
      workspaceId: WS,
      filename: "launch.mp4",
      mimeType: "video/mp4",
      size: 400 * MB,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("PUT");
    expect(r.headers).toEqual({ "Content-Type": "video/mp4" });
    expect(parsePresignedUploadKey(r.uploadToken)).toEqual({
      workspaceId: WS,
      userId: USER,
      filename: "launch.mp4",
    });
    expect(h.getSignedUploadUrl).toHaveBeenCalledWith(r.uploadToken, {
      contentType: "video/mp4",
      contentLength: 400 * MB,
      expiresIn: 900,
    });
  });

  it("refuses over the per-mime cap (413) and disallowed mimes (415)", async () => {
    const big = await requestPresignedUpload({
      userId: USER,
      workspaceId: WS,
      filename: "a.woff2",
      mimeType: "font/woff2",
      size: 6 * MB,
    });
    expect(big).toMatchObject({ ok: false, status: 413 });
    const html = await requestPresignedUpload({
      userId: USER,
      workspaceId: WS,
      filename: "x.html",
      mimeType: "text/html",
      size: 10,
    });
    expect(html).toMatchObject({ ok: false, status: 415 });
    expect(h.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("answers 501 (typed) when storage cannot issue a reachable URL", async () => {
    h.getSignedUploadUrl.mockRejectedValueOnce(
      new StorageUploadUnavailableError("no public url")
    );
    const r = await requestPresignedUpload({
      userId: USER,
      workspaceId: WS,
      filename: "a.mp4",
      mimeType: "video/mp4",
      size: 20 * MB,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 501,
      code: "STORAGE_UPLOAD_UNAVAILABLE",
    });
  });
});

describe("storeDocumentFromPresignedUpload", () => {
  const token = `files/${WS}/uploads/${USER}/22222222-2222-4222-8222-222222222222/launch.mp4`;

  it("refuses another user's token", async () => {
    const r = await storeDocumentFromPresignedUpload({
      userId: "someone-else",
      uploadToken: token,
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  const priorDoc = {
    id: "doc-0",
    storageKey: token,
    storageUrl: "u0",
    size: 400 * MB,
    mimeType: "video/mp4",
  };

  it("a key whose document an ENTITY already references is finished — 409", async () => {
    h.existingRows = [priorDoc];
    h.entityRows = [{ id: "entity-0" }];
    const r = await storeDocumentFromPresignedUpload({
      userId: USER,
      uploadToken: token,
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(h.setBody).not.toHaveBeenCalled();
  });

  it("a key a PENDING proposal will claim is finished too — 409", async () => {
    h.existingRows = [priorDoc];
    h.proposalRows = [{ id: "proposal-0" }];
    const r = await storeDocumentFromPresignedUpload({
      userId: USER,
      uploadToken: token,
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(h.setBody).not.toHaveBeenCalled();
  });

  it("RESUMES an unclaimed document (retry after a failed entity create)", async () => {
    h.existingRows = [priorDoc];
    const r = await storeDocumentFromPresignedUpload({
      userId: USER,
      uploadToken: token,
    });
    expect(r).toMatchObject({
      ok: true,
      resumed: true,
      mimeType: "video/mp4",
      filename: "launch.mp4",
      workspaceId: WS,
      stored: {
        documentId: "doc-0",
        storageKey: token,
        storageUrl: "u0",
        size: 400 * MB,
      },
    });
    // No second documents row, no re-HEAD of the object.
    expect(h.setBody).not.toHaveBeenCalled();
    expect(h.getMetadata).not.toHaveBeenCalled();
  });

  it("a concurrent finalize losing the unique index (23505) is a 409, not a 500", async () => {
    h.getMetadata.mockResolvedValueOnce({ size: 10, contentType: "video/mp4" });
    h.setBody.mockRejectedValueOnce(
      Object.assign(new Error("dup"), { cause: { code: "23505" } })
    );
    const r = await storeDocumentFromPresignedUpload({
      userId: USER,
      uploadToken: token,
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("an unknown entity kind is refused BEFORE any row is written", async () => {
    h.resolveProfile.mockResolvedValueOnce(null);
    const r = await storeDocumentFromPresignedUpload({
      userId: USER,
      uploadToken: token,
      profileSlug: "no-such-kind",
    });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      code: "UNKNOWN_PROFILE",
    });
    expect(h.resolveProfile).toHaveBeenCalledWith("no-such-kind", USER, WS);
    expect(h.getMetadata).not.toHaveBeenCalled();
    expect(h.setBody).not.toHaveBeenCalled();
  });

  it("refuses a pod-scoped key (both request doors require a workspace)", async () => {
    expect(
      parsePresignedUploadKey(
        `files/pod/uploads/${USER}/22222222-2222-4222-8222-222222222222/a.mp4`
      )
    ).toBeNull();
  });

  it("a missing object is 404; any other storage failure THROWS (never folded into 404)", async () => {
    h.getMetadata.mockRejectedValueOnce(
      Object.assign(new Error("nf"), { name: "NotFound" })
    );
    expect(
      await storeDocumentFromPresignedUpload({
        userId: USER,
        uploadToken: token,
      })
    ).toMatchObject({ ok: false, status: 404 });

    h.getMetadata.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      storeDocumentFromPresignedUpload({ userId: USER, uploadToken: token })
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("adopts the verified object through the body door (stored-object mode)", async () => {
    h.getMetadata.mockResolvedValueOnce({
      size: 400 * MB,
      contentType: "video/mp4",
    });
    h.setBody.mockResolvedValueOnce({
      documentId: "doc-1",
      storageKey: token,
      storageUrl: "u",
      size: 400 * MB,
    });
    const r = await storeDocumentFromPresignedUpload({
      userId: USER,
      uploadToken: token,
      title: "Launch",
    });
    expect(r).toMatchObject({
      ok: true,
      resumed: false,
      mimeType: "video/mp4",
      filename: "launch.mp4",
      workspaceId: WS,
    });
    expect(h.setBody).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        title: "Launch",
        storedObject: {
          storageKey: token,
          size: 400 * MB,
          mimeType: "video/mp4",
          filename: "launch.mp4",
        },
      })
    );
  });

  it("deletes and refuses an object whose real type is not allowed", async () => {
    h.getMetadata.mockResolvedValueOnce({ size: 10, contentType: "text/html" });
    const r = await storeDocumentFromPresignedUpload({
      userId: USER,
      uploadToken: token,
    });
    expect(r).toMatchObject({ ok: false, status: 415 });
    expect(h.deleteObj).toHaveBeenCalledWith(token);
    expect(h.setBody).not.toHaveBeenCalled();
  });
});

describe("createFileEntityForStoredDocument — keepDocumentOnFailure", () => {
  const stored = {
    documentId: "doc-9",
    storageKey: "k",
    storageUrl: "u",
    size: 10,
    document: { id: "doc-9", storageKey: "k" },
  };
  const params = {
    userId: USER,
    workspaceId: WS,
    mimeType: "video/mp4",
    filename: "a.mp4",
  };

  it("the presigned finalize KEEPS the document + bytes when the create fails (so a retry resumes)", async () => {
    h.materialize.mockRejectedValueOnce(new Error("required prop missing"));
    await expect(
      createFileEntityForStoredDocument(stored, {
        ...params,
        keepDocumentOnFailure: true,
      })
    ).rejects.toThrow("required prop missing");
    expect(h.deleteBody).not.toHaveBeenCalled();
  });

  it("the buffered door still reverses the document on failure", async () => {
    h.materialize.mockRejectedValueOnce(new Error("boom"));
    await expect(
      createFileEntityForStoredDocument(stored, params)
    ).rejects.toThrow("boom");
    expect(h.deleteBody).toHaveBeenCalledWith({ documentId: "doc-9" });
  });
});
