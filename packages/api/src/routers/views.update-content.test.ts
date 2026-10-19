/**
 * Contract test for views.updateContent — a canvas view's content save.
 *
 * `version` is the CONTENT FORMAT version (ViewContentSchema: literal 1, what
 * WhiteboardCanvas sends), not the document version; the document version is
 * the server's `currentVersion + 1`.
 *
 * The door: load the view → assertViewAccess(write) → canvas views only →
 * validate the content → push a whiteboard's content to its storage key →
 * snapshot a new document version (currentVersion + 1) → bump the document →
 * broadcast `yjs:reload` to the view's presence room.
 *
 * The view under test is pod-wide (workspaceId NULL) and owned by the caller,
 * so assertViewAccess decides by identity and touches no database.
 * DB is mocked — asserts control flow, not Postgres semantics.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const VIEW_ID = "00000000-0000-4000-8000-0000000000aa";
const DOCUMENT_ID = "00000000-0000-4000-8000-0000000000bb";
const OWNER = "user-1";
const STORAGE_KEY = `whiteboards/${OWNER}/${DOCUMENT_ID}.json`;

const { mockDb, insertValues, updateSet, updateWhere, upload, snapshot } =
  vi.hoisted(() => {
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const mockDb = {
      insert: vi.fn(() => ({ values: insertValues })),
      update: vi.fn(() => ({ set: updateSet })),
      query: {
        views: { findFirst: vi.fn() },
        documents: { findFirst: vi.fn() },
      },
    };
    return {
      mockDb,
      insertValues,
      updateSet,
      updateWhere,
      upload: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockResolvedValue({ storageKey: "snap-key" }),
    };
  });

vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: mockDb,
    getDb: vi.fn().mockResolvedValue(mockDb),
    uploadDocumentVersionSnapshot: snapshot,
    storedVersionValues: (s: { storageKey: string }) => ({
      storageKey: s.storageKey,
    }),
  };
});

vi.mock("@synap/storage", () => ({
  storage: { buildPath: vi.fn(), upload },
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
  getSyncGenerationState: vi.fn(async () => ({
    role: "primary",
    splitBrainDetected: false,
    generation: 0,
  })),
  invalidateSyncGenerationCache: vi.fn(),
}));

import { viewsRouter } from "./views.js";

function whiteboardView(overrides: Record<string, unknown> = {}) {
  return {
    id: VIEW_ID,
    type: "whiteboard",
    workspaceId: null,
    userId: OWNER,
    documentId: DOCUMENT_ID,
    ...overrides,
  };
}

function presence() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const of = vi.fn(() => ({ to }));
  return { socketIO: { of }, of, to, emit };
}

function caller(socketIO?: unknown) {
  return viewsRouter.createCaller({
    authenticated: true,
    userId: OWNER,
    socketIO,
  } as never);
}

const store = {
  "shape:test": {
    id: "shape:test",
    type: "geo",
    x: 100,
    y: 100,
    props: { w: 50, h: 50, text: "test" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.query.views.findFirst.mockResolvedValue(whiteboardView());
  mockDb.query.documents.findFirst.mockResolvedValue({
    id: DOCUMENT_ID,
    storageKey: STORAGE_KEY,
    currentVersion: 4,
    type: "whiteboard",
    mimeType: "application/json",
  });
});

describe("views.updateContent — a whiteboard save", () => {
  it("pushes the content to the document's storage key", async () => {
    await caller().updateContent({ viewId: VIEW_ID, store, version: 1 });

    expect(upload).toHaveBeenCalledTimes(1);
    const [key, body, opts] = upload.mock.calls[0];
    expect(key).toBe(STORAGE_KEY);
    expect(JSON.parse((body as Buffer).toString("utf-8"))).toEqual({
      version: 1,
      category: "canvas",
      store,
    });
    expect(opts).toEqual({ contentType: "application/json" });
  });

  it("snapshots version currentVersion + 1 and bumps the document to it", async () => {
    const result = await caller().updateContent({
      viewId: VIEW_ID,
      store,
      version: 1,
    });

    expect(snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER, documentId: DOCUMENT_ID })
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: DOCUMENT_ID,
        version: 5,
        storageKey: "snap-key",
        author: "user",
        authorId: OWNER,
        message: "Content update",
      })
    );
    expect(updateSet).toHaveBeenCalledWith({
      currentVersion: 5,
      lastSavedVersion: 5,
      updatedAt: expect.any(Date),
    });
    expect(updateWhere).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      viewId: VIEW_ID,
      version: 5,
      status: "updated",
    });
  });

  it("tells the view's presence room to reload, with the new version", async () => {
    const p = presence();
    const result = await caller(p.socketIO).updateContent({
      viewId: VIEW_ID,
      store,
      version: 1,
    });

    expect(p.of).toHaveBeenCalledWith("/presence");
    expect(p.to).toHaveBeenCalledWith(`view:whiteboard-${DOCUMENT_ID}`);
    expect(p.emit).toHaveBeenCalledWith(
      "yjs:reload",
      expect.objectContaining({
        viewId: VIEW_ID,
        documentId: DOCUMENT_ID,
        version: 5,
        timestamp: expect.any(Number),
      })
    );
    expect(result.broadcastSuccess).toBe(true);
  });

  it("a failed storage push fails the save before any version is written", async () => {
    upload.mockRejectedValueOnce(new Error("storage down"));

    await expect(
      caller().updateContent({ viewId: VIEW_ID, store, version: 1 })
    ).rejects.toThrow("storage down");
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });
});

describe("views.updateContent — refusals write nothing", () => {
  function expectNoWrites() {
    expect(upload).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  }

  it("a missing view is NOT_FOUND", async () => {
    mockDb.query.views.findFirst.mockResolvedValue(undefined);
    await expect(
      caller().updateContent({ viewId: VIEW_ID, store, version: 1 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expectNoWrites();
  });

  it("someone else's pod-wide view is FORBIDDEN", async () => {
    mockDb.query.views.findFirst.mockResolvedValue(
      whiteboardView({ userId: "someone-else" })
    );
    await expect(
      caller().updateContent({ viewId: VIEW_ID, store, version: 1 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expectNoWrites();
  });

  it("a non-canvas view does not take content", async () => {
    mockDb.query.views.findFirst.mockResolvedValue(
      whiteboardView({ type: "kanban" })
    );
    await expect(
      caller().updateContent({ viewId: VIEW_ID, store, version: 1 })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("does not support content updates"),
    });
    expectNoWrites();
  });

  it("a content format other than version 1 is refused", async () => {
    await expect(
      caller().updateContent({ viewId: VIEW_ID, store, version: 2 })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid view content structure",
    });
    expectNoWrites();
  });

  it("the content format version is required", async () => {
    await expect(
      caller().updateContent({ viewId: VIEW_ID, store } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mockDb.query.views.findFirst).not.toHaveBeenCalled();
    expectNoWrites();
  });
});
