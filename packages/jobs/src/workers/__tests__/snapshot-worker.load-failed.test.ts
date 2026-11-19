/**
 * A whiteboard snapshot is never taken of a room that failed to load its
 * board: the realtime bridge's state reply says so (`loadFailed`, the server's
 * own flag), and the worker then stores no version and announces nothing.
 * The restore worker treats the bridge's 409 (a failed room takes no restore)
 * as a failed job. Seams mocked: the bridge (`fetch`), the database, the
 * version upload and the realtime broadcast.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  upload: vi.fn(),
  broadcast: vi.fn(),
  broadcastError: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  db: {
    query: {
      views: { findFirst: async () => ({ id: "view-1" }) },
      documents: {
        findFirst: async () => ({
          id: "doc-1",
          type: "whiteboard",
          mimeType: "application/json",
          currentVersion: 3,
        }),
      },
    },
    insert: () => ({
      values: (v: unknown) => {
        m.insert(v);
        return { returning: async () => [{ id: "version-1" }] };
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
  eq: (_c: unknown, v: unknown) => ({ v }),
  claimDocumentRevision: vi.fn(),
  INHERIT_LAST_AUTHOR: Symbol("inherit"),
  AUTOSAVE_CHECKPOINT: Symbol("autosave"),
  emitDocumentContentReplaced: vi.fn(),
  readDocumentVersionBuffer: vi.fn(),
  storedVersionValues: () => ({}),
  uploadDocumentVersionSnapshot: async (args: unknown) => {
    m.upload(args);
    return {};
  },
}));
vi.mock("@synap/database/schema", () => ({
  documents: { id: "documents.id" },
  documentVersions: {},
  documentSessions: {},
  views: { id: "views.id" },
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../utils/realtime-broadcast.js", () => ({
  broadcastSuccess: async (...args: unknown[]) => m.broadcast(...args),
  broadcastError: async (...args: unknown[]) => m.broadcastError(...args),
}));

const { handleWhiteboardSnapshot, handleWhiteboardRestore } =
  await import("../snapshot-worker.js");

const job = {
  data: {
    viewId: "view-1",
    documentId: "doc-1",
    yjsRoomId: "whiteboard-doc-1",
    message: "Manual snapshot",
    userId: "user-1",
  },
} as never;

const bridgeReply = (extra: Record<string, unknown>) =>
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          roomId: "whiteboard-doc-1",
          state: "AAA=",
          encoding: "base64",
          byteLength: 2,
          ...extra,
        }),
        { status: 200 }
      )
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleWhiteboardSnapshot and a room that failed to load", () => {
  it("refuses: no version stored, nothing announced", async () => {
    bridgeReply({
      loadFailed: true,
      loadError: "The board's saved content could not be loaded.",
    });
    await expect(handleWhiteboardSnapshot(job)).rejects.toThrow(
      /failed to load the saved board/
    );
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.broadcast).not.toHaveBeenCalled();
  });

  it("CONTROL: a loaded room is snapshotted as before", async () => {
    bridgeReply({});
    await handleWhiteboardSnapshot(job);
    expect(m.upload).toHaveBeenCalledTimes(1);
    expect(m.broadcast).toHaveBeenCalledWith(
      "user-1",
      "whiteboard.snapshot.saved",
      expect.objectContaining({ viewId: "view-1" })
    );
  });
});

describe("handleWhiteboardRestore and a room that failed to load", () => {
  const restoreJob = {
    data: {
      viewId: "view-1",
      versionId: "version-1",
      yjsRoomId: "whiteboard-doc-1",
      content: "AAA=",
      userId: "user-1",
    },
  } as never;

  it("the bridge's 409 load-failed is a failed job: nothing announced as restored", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: "The board's saved content could not be loaded.",
            reason: "load-failed",
            applied: false,
          }),
          { status: 409 }
        )
    );
    await expect(handleWhiteboardRestore(restoreJob)).rejects.toThrow(/409/);
    expect(m.broadcast).not.toHaveBeenCalled();
  });

  it("a board nobody has open (applied: false) is never announced as restored", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ success: true, applied: false }), {
          status: 200,
        })
    );
    await handleWhiteboardRestore(restoreJob);
    expect(m.broadcast).not.toHaveBeenCalled();
    expect(m.broadcastError).toHaveBeenCalledWith(
      "user-1",
      "whiteboard.restore.failed",
      expect.stringContaining("not open")
    );
  });

  it("CONTROL: an open room that took the state is announced as restored", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ success: true, applied: true }), {
          status: 200,
        })
    );
    await handleWhiteboardRestore(restoreJob);
    expect(m.broadcast).toHaveBeenCalledWith(
      "user-1",
      "whiteboard.restored",
      expect.objectContaining({ viewId: "view-1" })
    );
  });
});
