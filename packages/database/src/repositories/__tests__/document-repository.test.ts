import { describe, it, expect, beforeEach, vi } from "vitest";
import { type EventRepository } from "../event-repository.js";
import { DocumentRepository } from "../document-repository.js";

const mockDb = {
  // Document repo might assume underlying entities table or documents table logic
  // Based on code viewing, DocumentRepository likely extends EntityRepository logic or similar structure
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
} as any;

describe("DocumentRepository", () => {
  let docRepo: DocumentRepository;
  let mockEventRepo: EventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventRepo = {
      append: vi.fn(),
    } as any;

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
        },
        "user-1"
      );
      expect(result.title).toBe("Test Document");
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "documents.create.completed",
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
          type: "documents.update.completed",
        })
      );
    });
  });

  describe("delete", () => {
    it("should delete document and emit completed event", async () => {
      await docRepo.delete("doc-1", "user-1");
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "documents.delete.completed",
        })
      );
    });
  });
});
