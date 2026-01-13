import { describe, it, expect, beforeEach, vi } from "vitest";

const { downloadMock, upsertMock, embeddingMock } = vi.hoisted(() => ({
  downloadMock: vi.fn<[], Promise<string>>(),
  upsertMock: vi.fn(),
  embeddingMock: vi.fn<[], Promise<number[]>>(),
}));

vi.mock("@synap/storage", () => ({
  r2: {
    download: downloadMock,
  },
}));

vi.mock("@synap/domain", () => ({
  vectorService: {
    upsertEntityEmbedding: upsertMock,
  },
}));

vi.mock("@synap/ai", () => ({
  generateEmbedding: embeddingMock,
}));

import { processEntityCreatedEvent } from "../src/functions/entity-embedding.js";

const stepRunner = {
  run: async <T>(name: string, handler: () => Promise<T> | T): Promise<T> => {
    try {
      return await handler();
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        {
          step: name,
        },
      );
    }
  },
};

describe("entity embedding worker", () => {
  const payload = {
    entityId: "entity-123",
    userId: "user-456",
    type: "note",
    title: "Sample note",
    preview: "preview",
    fileUrl: "https://storage/note.md",
    filePath: "users/user-456/notes/entity-123.md",
  };

  beforeEach(() => {
    downloadMock.mockReset();
    upsertMock.mockReset();
    embeddingMock.mockReset();
  });

  it("downloads content and indexes embedding when only filePath is provided", async () => {
    downloadMock.mockResolvedValue("Note body from storage");
    embeddingMock.mockResolvedValue(new Array(1536).fill(0.1));

    const result = await processEntityCreatedEvent(payload, stepRunner);

    expect(downloadMock).toHaveBeenCalledWith(payload.filePath);
    expect(embeddingMock).toHaveBeenCalled();
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: payload.entityId,
        userId: payload.userId,
        embedding: expect.any(Array),
      }),
    );
    expect(result).toEqual({ status: "indexed", entityId: payload.entityId });
  });

  it("skips indexing when content is unavailable", async () => {
    downloadMock.mockResolvedValue("");

    const result = await processEntityCreatedEvent(payload, stepRunner);

    expect(result.status).toBe("skipped");
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
