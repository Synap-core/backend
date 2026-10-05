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
  existingRows: [] as unknown[],
  docRows: [] as unknown[],
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
  // `select({ id })` = the already-finalized probe; `select()` = the re-read.
  const chain = (cols?: unknown) => {
    const rows = cols ? h.existingRows : h.docRows;
    const o: Record<string, unknown> = {};
    o.from = () => o;
    o.where = () => o;
    o.limit = () => Promise.resolve(rows);
    return o;
  };
  return {
    db: { select: (cols?: unknown) => chain(cols) },
    eq: vi.fn(),
    documents: { id: "id", storageKey: "storage_key" },
    eventRepository: {},
    EntityBodyService: class {
      setBody = h.setBody;
    },
    // file-upload.ts imports these; unused by the code under test.
    and: vi.fn(),
    entities: {},
    workspaceMembers: {},
    materializeEntity: vi.fn(),
    resolveImportEntityPlacement: vi.fn(),
  };
});
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

  it("refuses a token some document already owns (409)", async () => {
    h.existingRows = [{ id: "doc-0" }];
    const r = await storeDocumentFromPresignedUpload({
      userId: USER,
      uploadToken: token,
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(h.setBody).not.toHaveBeenCalled();
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
