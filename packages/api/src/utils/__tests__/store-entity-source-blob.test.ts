/**
 * storeEntitySourceBlob — size guards + property contract (unit, mocked storage).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const uploadMock = vi.fn();
const buildPathMock = vi.fn(
  (userId: string, kind: string, id: string, ext: string) =>
    `users/${userId}/${kind}/${id}.${ext}`
);

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (...args: unknown[]) =>
      buildPathMock(...(args as [string, string, string, string])),
    upload: (...args: unknown[]) => uploadMock(...args),
  },
}));

const docCreateMock = vi.fn();
const entityUpdateMock = vi.fn();

vi.mock("@synap/database", () => ({
  eventRepository: {},
  DocumentRepository: class {
    create = docCreateMock;
  },
  EntityRepository: class {
    update = entityUpdateMock;
  },
}));

import {
  storeEntitySourceBlob,
  SourceBlobTooLargeError,
  SourceBlobEmptyError,
  SOURCE_BLOB_MAX_BYTES,
} from "../store-entity-source-blob.js";

describe("storeEntitySourceBlob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadMock.mockResolvedValue({
      url: "https://storage.example/wav",
      path: "users/u1/entity/e1.wav",
      size: 4,
    });
    docCreateMock.mockResolvedValue({ id: "doc-1" });
    entityUpdateMock.mockResolvedValue({});
  });

  it("rejects empty buffers", async () => {
    await expect(
      storeEntitySourceBlob({
        database: {} as never,
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
        database: {} as never,
        userId: "u1",
        entityId: "e1",
        buffer: Buffer.alloc(SOURCE_BLOB_MAX_BYTES + 1),
        mimeType: "audio/wav",
      })
    ).rejects.toBeInstanceOf(SourceBlobTooLargeError);
  });

  it("uploads, creates document, and stamps provenance properties", async () => {
    const buffer = Buffer.from("RIFF....WAVE");
    const result = await storeEntitySourceBlob({
      database: {} as never,
      userId: "u1",
      entityId: "e1",
      buffer,
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
    expect(result.documentId).toBe("doc-1");
    expect(result.storageKey).toBe("users/u1/entity/e1.wav");
  });
});
