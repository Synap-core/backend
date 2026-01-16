import { describe, it, expect, vi, beforeEach } from "vitest";
import { documentsHandler } from "../documents-executor.js";

// Mock dependencies
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock("@synap/database", () => {
  return {
    getDb: vi.fn(),
    EventRepository: vi.fn(),
    DocumentRepository: vi.fn().mockImplementation(() => ({
      create: mockCreate,
      update: mockUpdate,
      delete: mockDelete,
    })),
  };
});

describe("DocumentsExecutor", () => {
  let mockStep: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStep = {
      run: vi.fn((_name, fn) => fn()),
    };
  });

  it("should handle create action", async () => {
    const event = {
      name: "documents.create.validated",
      data: {
        title: "Test Doc",
        type: "markdown",
        language: "en",
        content: "content",
        projectId: "p-1",
      },
      user: { userId: "user-1" },
    };

    const result = await documentsHandler({ event, step: mockStep } as any);

    // Should run upload step then create step
    expect(mockStep.run).toHaveBeenNthCalledWith(
      1,
      "upload-file",
      expect.any(Function)
    );
    expect(mockStep.run).toHaveBeenNthCalledWith(
      2,
      "create-document",
      expect.any(Function)
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Test Doc",
        userId: "user-1",
      }),
      "user-1"
    );
    expect(result).toEqual({ success: true, action: "create" });
  });

  it("should handle update action", async () => {
    const event = {
      name: "documents.update.validated",
      data: { id: "doc-1", title: "Updated" },
      user: { userId: "user-1" },
    };

    await documentsHandler({ event, step: mockStep } as any);

    expect(mockStep.run).toHaveBeenCalledWith(
      "update-document",
      expect.any(Function)
    );
    expect(mockUpdate).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({ title: "Updated" }),
      "user-1"
    );
  });

  it("should handle delete action", async () => {
    const event = {
      name: "documents.delete.validated",
      data: { id: "doc-1" },
      user: { userId: "user-1" },
    };

    await documentsHandler({ event, step: mockStep } as any);

    expect(mockStep.run).toHaveBeenCalledWith(
      "delete-document",
      expect.any(Function)
    );
    expect(mockDelete).toHaveBeenCalledWith("doc-1", "user-1");
  });
});
