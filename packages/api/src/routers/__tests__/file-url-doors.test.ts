/**
 * The stored-file URL doors answer `{ url, expiresAt, mimeType }`: a display
 * door holding a stored ref with no mime decides drawability AFTER signing,
 * from the type the blob is served with. Drives the REAL Hono routes; the read
 * floor (covered on PGlite in utils/stored-file-access.pglite.test.ts), storage
 * and auth are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  loadDoc: vi.fn(),
  loadEntity: vi.fn(),
  findDoc: vi.fn(),
  findEntity: vi.fn(),
}));

vi.mock("@synap/storage", () => ({
  StorageUploadUnavailableError: class extends Error {},
  storage: {
    getSignedUrl: vi.fn(async (key: string) => `https://blobs.test/${key}`),
  },
}));
vi.mock("@synap/database", () => ({
  db: {
    query: {
      documents: { findFirst: h.findDoc },
      entities: { findFirst: h.findEntity },
    },
  },
  eq: vi.fn(),
  entities: { id: "id" },
  documents: { id: "id" },
  workspaces: {},
  eventRepository: {},
  EntityBodyService: class {},
  materializeEntity: vi.fn(),
  resolveImportEntityPlacement: vi.fn(),
}));
vi.mock("@synap/database/schema", () => ({ channelContextItems: {} }));
vi.mock("../../utils/stored-file-access.js", () => ({
  loadSignableDocument: h.loadDoc,
  loadSignableFileEntity: h.loadEntity,
}));
vi.mock("@synap/auth", () => ({
  authMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set("userId", "user-1");
    await next();
  },
}));
vi.mock("../../access/guest-containment.js", () => ({
  refuseGuestSession: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { fileUploadApp } from "../file-upload.js";

beforeEach(() => vi.clearAllMocks());

describe("GET /documents/:id/url", () => {
  it("answers the served mime type next to the signed URL", async () => {
    h.loadDoc.mockResolvedValue({
      id: "d1",
      storageKey: "k1",
      mimeType: "image/png",
    });
    const res = await fileUploadApp.request("/documents/d1/url");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.url).toBe("https://blobs.test/k1");
    expect(body.mimeType).toBe("image/png");
  });

  it("an unknown type is null, never absent", async () => {
    h.loadDoc.mockResolvedValue({ id: "d1", storageKey: "k1", mimeType: null });
    const body = (await (
      await fileUploadApp.request("/documents/d1/url")
    ).json()) as Record<string, unknown>;
    expect(body).toHaveProperty("mimeType", null);
  });

  it("unreadable but existing → 403; unknown → 404", async () => {
    h.loadDoc.mockResolvedValue(undefined);
    h.findDoc.mockResolvedValueOnce({ id: "d1" });
    expect((await fileUploadApp.request("/documents/d1/url")).status).toBe(403);
    h.findDoc.mockResolvedValueOnce(undefined);
    expect((await fileUploadApp.request("/documents/d1/url")).status).toBe(404);
  });
});

describe("GET /documents/:id/url?entityId= (the holder hint)", () => {
  const E = "6f1c2a3b-0000-4000-8000-000000000001";
  it("hands the hinted entity to the read floor", async () => {
    h.loadDoc.mockResolvedValue({ id: "d1", storageKey: "k1", mimeType: null });
    await fileUploadApp.request(`/documents/d1/url?entityId=${E}`);
    expect(h.loadDoc).toHaveBeenCalledWith(expect.any(String), "d1", {
      viaEntityId: E,
    });
  });

  it("no hint → the read floor's reverse lookup", async () => {
    h.loadDoc.mockResolvedValue({ id: "d1", storageKey: "k1", mimeType: null });
    await fileUploadApp.request("/documents/d1/url");
    expect(h.loadDoc).toHaveBeenCalledWith(expect.any(String), "d1", {
      viaEntityId: undefined,
    });
  });

  it("a hint that is not a uuid is a 400, never a query", async () => {
    const res = await fileUploadApp.request("/documents/d1/url?entityId=nope");
    expect(res.status).toBe(400);
    expect(h.loadDoc).not.toHaveBeenCalled();
  });
});

describe("GET /:entityId/url", () => {
  it("answers the served mime type next to the signed URL", async () => {
    h.loadEntity.mockResolvedValue({
      id: "e1",
      storageKey: "k2",
      mimeType: "video/mp4",
    });
    const res = await fileUploadApp.request("/e1/url");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).mimeType).toBe(
      "video/mp4"
    );
  });
});
