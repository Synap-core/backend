import { describe, it, expect, beforeEach, vi } from "vitest";
import { type EventRepository } from "../event-repository.js";
import { DocumentRepository } from "../document-repository.js";

// create() wraps the row insert (and, when content is supplied, the v1
// version snapshot insert) in `this.db.transaction(async (tx) => ...)` so the
// two writes commit atomically. The mock db must expose both a top-level
// insert/update/delete AND a `transaction` that hands the callback a tx whose
// `insert` behaves the same way.
const mockTx = {
  insert: vi.fn(),
} as any;

const mockDb = {
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(mockTx)),
} as any;

describe("DocumentRepository", () => {
  let docRepo: DocumentRepository;
  let mockEventRepo: EventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventRepo = {
      append: vi.fn(),
    } as any;

    mockTx.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ id: "doc-1", title: "Test Document" }]),
      }),
    });

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ id: "doc-1", title: "Test Document" }]),
      }),
    });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue([{ id: "doc-1", title: "Updated Document" }]),
        }),
      }),
    });

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "doc-1" }]),
      }),
    });

    docRepo = new DocumentRepository(mockDb, mockEventRepo);
  });

  describe("create", () => {
    it("should create document and emit completed event", async () => {
      const result = await docRepo.create(
        {
          title: "Test Document",
          type: "text",
          storageUrl: "s3://test/doc.txt",
          storageKey: "test/doc.txt",
          size: 1024,
          mimeType: "text/plain",
          userId: "user-1",
          workspaceId: "ws-1",
        },
        "user-1"
      );
      expect(result.title).toBe("Test Document");
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockTx.insert).toHaveBeenCalled();
      // Event `type` is `${subjectType}.${action}.${phase}` (see
      // create-unified-event.ts) with subjectType = "document" (singular, as
      // configured in DocumentRepository's `super(db, eventRepo, { subjectType: "document" })`).
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "document.create.completed",
          subjectId: "doc-1",
        })
      );
    });
  });

  describe("update", () => {
    it("should update document and emit completed event", async () => {
      const updated = await docRepo.update(
        "doc-1",
        {
          title: "Updated Document",
        },
        "user-1"
      );

      expect(updated.title).toBe("Updated Document");
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "document.update.completed",
        })
      );
    });
  });

  describe("delete", () => {
    it("should delete document and emit completed event", async () => {
      await docRepo.delete("doc-1", "user-1");
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "document.delete.completed",
        })
      );
    });
  });
});
