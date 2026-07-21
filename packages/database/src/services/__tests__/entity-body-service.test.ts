import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// DB-FREE unit tests. Postgres is down; we mock the two boundaries the service
// touches: `@synap/storage` (object store) and the DocumentRepository/db writes.
// We spy on DocumentRepository.prototype so setBody's create path never needs a
// real transaction, and drive getPreview/getBytes/deleteBody reads via a queued
// chainable `db.select` mock.
// ---------------------------------------------------------------------------

vi.mock("@synap/storage", () => {
  const size = (c: unknown) =>
    Buffer.isBuffer(c) ? c.length : Buffer.byteLength(String(c));
  return {
    storage: {
      buildPath: vi.fn(
        (userId: string, kind: string, id: string, ext: string) =>
          `${userId}/${kind}/${id}.${ext}`
      ),
      upload: vi.fn(async (path: string, content: unknown) => ({
        url: `mem://${path}`,
        path,
        size: size(content),
        checksum: "checksum-xyz",
      })),
      downloadBuffer: vi.fn(async () => Buffer.from("stored-bytes")),
      delete: vi.fn(async () => {}),
      getSignedUrl: vi.fn(async () => "signed://url"),
    },
  };
});

import { storage } from "@synap/storage";
import { DocumentRepository } from "../../repositories/document-repository.js";
import {
  EntityBodyService,
  type BodyProvenance,
} from "../entity-body-service.js";

const HUMAN: BodyProvenance = {
  createdByKind: "human",
  createdByUserId: "user-1",
};

// A chainable, awaitable stand-in for a drizzle select builder that resolves to
// the given rows regardless of which of from/where/orderBy/limit are called.
function chain(rows: unknown[]) {
  const obj: any = {
    from: () => obj,
    where: () => obj,
    orderBy: () => obj,
    limit: () => obj,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return obj;
}

describe("EntityBodyService", () => {
  let svc: EntityBodyService;
  let selectQueue: unknown[][];
  let createSpy: any;
  let deleteSpy: any;
  let db: any;

  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue = [];
    db = {
      select: vi.fn(() => chain(selectQueue.shift() ?? [])),
      // Terminal writes go through the spied DocumentRepository — not exercised
      // here — so these are inert stand-ins.
      insert: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    };
    createSpy = vi
      .spyOn(DocumentRepository.prototype, "create")
      .mockResolvedValue({ id: "doc-1" } as any);
    deleteSpy = vi
      .spyOn(DocumentRepository.prototype, "delete")
      .mockResolvedValue(undefined as any);
    svc = new EntityBodyService(db, { append: vi.fn() } as any);
  });

  // --- text mode: the heuristic branch --------------------------------------
  describe("setBody text-mode", () => {
    it("SHORT text → inlineContent, no document created", async () => {
      const res = await svc.setBody({
        entityId: "e-1",
        userId: "user-1",
        provenance: HUMAN,
        text: "a short note",
      });
      expect(res).toEqual({ inlineContent: "a short note" });
      expect(createSpy).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("LONG text → materializes a markdown document, returns documentId", async () => {
      const long = "x".repeat(700); // ≥ LONG_FORM_LENGTH (600)
      const res = await svc.setBody({
        entityId: "e-1",
        userId: "user-1",
        provenance: HUMAN,
        text: long,
      });
      expect(res).toEqual({ documentId: "doc-1" });
      // Uploaded the md body to the entity storage path.
      expect(storage.buildPath).toHaveBeenCalledWith(
        "user-1",
        "entity",
        "e-1",
        "md"
      );
      expect(createSpy).toHaveBeenCalledTimes(1);
      const arg = createSpy.mock.calls[0]![0] as any;
      expect(arg.type).toBe("markdown");
      expect(arg.mimeType).toBe("text/markdown");
      expect(arg.content).toBe(long);
    });

    it("materialize failure folds back to inlineContent", async () => {
      const long = "x".repeat(700);
      (storage.upload as any).mockRejectedValueOnce(new Error("minio down"));
      const res = await svc.setBody({
        entityId: "e-1",
        userId: "user-1",
        provenance: HUMAN,
        text: long,
      });
      expect(res).toEqual({ inlineContent: long });
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("empty text → {}", async () => {
      const res = await svc.setBody({
        entityId: "e-1",
        userId: "user-1",
        provenance: HUMAN,
        text: "",
      });
      expect(res).toEqual({});
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  // --- bytes mode: ALWAYS a document (no heuristic) -------------------------
  describe("setBody bytes-mode", () => {
    it("always creates a document + returns storage pointers", async () => {
      const bytes = Buffer.from("PNGDATA");
      const res = await svc.setBody({
        entityId: "e-1",
        userId: "user-1",
        workspaceId: "ws-1",
        provenance: HUMAN,
        bytes,
        mimeType: "image/png",
        filename: "pic.png",
      });
      expect(res.documentId).toBe("doc-1");
      expect(res.storageKey).toBeDefined();
      expect(res.storageUrl).toBeDefined();
      expect(res.size).toBe(bytes.length);

      // Two storage objects: the canonical current-content object + the v1
      // version snapshot object (so deleteBody can clean both).
      expect((storage.upload as any).mock.calls.length).toBe(2);

      const arg = createSpy.mock.calls[0]![0] as any;
      expect(arg.id).toBeDefined(); // explicit id so cleanup can target both objects
      expect(arg.mimeType).toBe("image/png");
      expect(arg.metadata).toMatchObject({
        originalFileName: "pic.png",
        uploadKind: "file-upload",
      });
      // Pre-uploaded snapshot handed to the repo → no double-upload.
      expect(arg.preUploadedVersion).toBeDefined();
      expect(arg.preUploadedVersion.versionId).toBeDefined();
      expect(arg.content).toBeUndefined();
    });
  });

  // --- url mode: external reference, NO storage upload ----------------------
  describe("setBody url-mode", () => {
    it("creates an external-reference document (storageKey NULL, no upload)", async () => {
      const res = await svc.setBody({
        entityId: "e-1",
        userId: "user-1",
        provenance: HUMAN,
        url: "https://example.com/doc",
      });
      expect(res).toEqual({ documentId: "doc-1" });
      expect(storage.upload).not.toHaveBeenCalled();

      const arg = createSpy.mock.calls[0]![0] as any;
      expect(arg.storageUrl).toBe("https://example.com/doc");
      expect(arg.storageKey).toBeNull();
      expect(arg.size).toBe(0);
      expect(arg.mimeType).toBeNull();
      expect(arg.metadata).toEqual({ external: true });
    });
  });

  // --- provenance stamped verbatim, never falsified ------------------------
  describe("provenance", () => {
    it("stamps ai_agent provenance verbatim (never re-labelled human)", async () => {
      const long = "x".repeat(700);
      await svc.setBody({
        entityId: "e-1",
        userId: "user-1",
        provenance: {
          createdByKind: "ai_agent",
          createdByUserId: "agent-9",
          agentUserId: "agent-9",
        },
        text: long,
      });
      const arg = createSpy.mock.calls[0]![0] as any;
      expect(arg.createdByKind).toBe("ai_agent");
      expect(arg.createdByUserId).toBe("agent-9");
      expect(arg.agentUserId).toBe("agent-9");
    });
  });

  // --- getPreview: DB-only latest version content --------------------------
  describe("getPreview", () => {
    it("returns latest version content", async () => {
      selectQueue.push([{ content: "preview body" }]);
      expect(await svc.getPreview("doc-1")).toBe("preview body");
      expect(storage.downloadBuffer).not.toHaveBeenCalled();
    });
    it("returns null when no versions", async () => {
      selectQueue.push([]);
      expect(await svc.getPreview("doc-1")).toBeNull();
    });
  });

  // --- getBytes: the 3-state resolver --------------------------------------
  describe("getBytes", () => {
    it("state 1: storageKey set → downloads bytes", async () => {
      selectQueue.push([
        {
          storageKey: "k/main.png",
          storageUrl: "mem://x",
          mimeType: "image/png",
        },
      ]);
      const res = await svc.getBytes("doc-1");
      expect(res).toEqual({
        kind: "bytes",
        buffer: Buffer.from("stored-bytes"),
        mimeType: "image/png",
      });
      expect(storage.downloadBuffer).toHaveBeenCalledWith("k/main.png");
    });

    it("state 2: storageKey NULL + storageUrl → external ref, NEVER fetches", async () => {
      selectQueue.push([
        { storageKey: null, storageUrl: "https://ext/doc", mimeType: null },
      ]);
      const res = await svc.getBytes("doc-1");
      expect(res).toEqual({ kind: "external", url: "https://ext/doc" });
      // Critical: no non-null-assert, no download of a NULL key (fixes B2).
      expect(storage.downloadBuffer).not.toHaveBeenCalled();
    });

    it("state 3: neither → falls back to inline version content", async () => {
      selectQueue.push([
        { storageKey: null, storageUrl: null, mimeType: null },
      ]);
      selectQueue.push([{ content: "inline fallback" }]);
      const res = await svc.getBytes("doc-1");
      expect(res).toEqual({ kind: "inline", content: "inline fallback" });
      expect(storage.downloadBuffer).not.toHaveBeenCalled();
    });

    it("missing document → null", async () => {
      selectQueue.push([]);
      expect(await svc.getBytes("nope")).toBeNull();
    });
  });

  // --- deleteBody: reverse-cascade cleans BOTH object sets ------------------
  describe("deleteBody", () => {
    it("deletes the row + the current-content object + every version object", async () => {
      // doc select, then versions select (documentId path).
      selectQueue.push([{ storageKey: "main-obj", userId: "user-1" }]);
      selectQueue.push([
        { storageKey: "v1-obj" },
        { storageKey: "v2-obj" },
        { storageKey: null },
      ]);

      await svc.deleteBody({ documentId: "doc-1" });

      expect(deleteSpy).toHaveBeenCalledWith("doc-1", "user-1");
      const deleted = (storage.delete as any).mock.calls.map(
        (c: unknown[]) => c[0]
      );
      expect(deleted).toContain("main-obj");
      expect(deleted).toContain("v1-obj");
      expect(deleted).toContain("v2-obj");
      expect(deleted).not.toContain(null);
    });

    it("no-op when neither documentId nor entity resolves a document", async () => {
      selectQueue.push([{ documentId: null }]); // entity has no documentId
      await svc.deleteBody({ entityId: "e-1" });
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });
});
