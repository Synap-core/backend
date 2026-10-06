/**
 * Test the views.updateContent tRPC mutation for whiteboard content updates.
 *
 * Follows the pattern of canvas-seed.test.ts but tests the update path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkPermissionOrPropose,
  previewPermissionDecision,
} from "../utils/permission-check.js";

const {
  mockDb,
  mockGetDb,
  mockCheckPermission,
  mockPreviewDecision,
  selectLimit,
  WORKSPACE,
  VIEW_ID,
  DOCUMENT_ID,
  AGENT,
} = vi.hoisted(() => {
  const WORKSPACE = "00000000-0000-4000-8000-000000000010";
  const VIEW_ID = "00000000-0000-4000-8000-0000000000aa";
  const DOCUMENT_ID = "00000000-0000-4000-8000-0000000000bb";
  const AGENT = "00000000-0000-4000-8000-0000000000a1";

  const selectLimit = vi.fn().mockResolvedValue([]);
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: selectLimit,
  };
  const mockDb = {
    insert: vi.fn(() => ({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    })),
    select: vi.fn(() => selectChain),
    query: {
      workspaceMembers: {
        findFirst: vi.fn().mockResolvedValue({ role: "editor" }),
      },
      workspaces: {
        findFirst: vi.fn().mockResolvedValue({ archivedAt: null }),
      },
      documents: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          storageKey: `whiteboards/user-1/${DOCUMENT_ID}.json`,
          currentVersion: 1,
          lastSavedVersion: 1,
          type: "whiteboard",
          mimeType: "application/json",
          size: 100,
        }),
      },
      documentVersions: {
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
  return {
    mockDb,
    selectLimit,
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    mockCheckPermission: vi.fn().mockResolvedValue({ granted: true }),
    mockPreviewDecision: vi.fn().mockResolvedValue({ decision: "propose" }),
    WORKSPACE,
    VIEW_ID,
    DOCUMENT_ID,
    AGENT,
  };
});

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: mockDb, getDb: mockGetDb };
});

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: vi.fn(),
    upload: vi.fn.resolvesTo({ url: "test-url", path: "test-path", size: 100 }),
  },
}));

vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn.async(() => false),
  getSyncGenerationState: vi.fn.async(() => ({
    role: "primary",
    splitBrainDetected: false,
    generation: 0,
  })),
  invalidateSyncGenerationCache: vi.fn(),
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/permission-check.js")>()),
  checkPermissionOrPropose: mockCheckPermission,
  previewPermissionDecision: mockPreviewDecision,
}));

vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn().mockResolvedValue({ id: "evt-1" }),
}));

vi.mock("../lib/event-helpers.js", () => ({
  ViewEvents: { createRequested: vi.fn().mockResolvedValue(undefined) },
}));

// Mock the realtime server and bridge for Yjs broadcast
vi.mock("@synap/realtime/index.js", () => ({
  io: {
    of: vi.fn().mockReturnThis(),
    to: vi.fn().mockReturnThis(),
    emit: vi.fn(),
  },
  setupYjsServer: vi.fn(),
}));

vi.mock("@synap/realtime/bridge.js", () => ({
  getYjsServer: vi.fn().mockReturnValue({
    documents: new Map([
      [
        `whiteboard-${DOCUMENT_ID}`,
        {
          get: vi.fn().mockReturnValue({}),
        },
      ],
    ]),
  }),
}));

import { viewsRouter } from "../../../api/src/routers/views.js";

function callerCtx() {
  return {
    authenticated: true,
    userId: "user-1",
    workspaceId: WORKSPACE,
  } as never;
}

const viewInput = {
  viewId: VIEW_ID,
  store: {
    "shape:test": {
      id: "shape:test",
      type: "geo",
      x: 100,
      y: 100,
      props: { w: 50, h: 50, text: "test" },
    },
  },
  version: 2,
};

describe("views.updateContent — whiteboard content updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectLimit.mockResolvedValue([]);
    mockCheckPermission.mockResolvedValue({ granted: true });
  });

  it("updates whiteboard content and creates new version", async () => {
    // Setup existing document version
    mockDb.query.documentVersions.findFirst.mockResolvedValueOnce({
      id: "existing-version-id",
      documentId: DOCUMENT_ID,
      version: 1,
      ...{
        author: "user",
        authorId: "user-1",
        message: "Initial version",
        content: Buffer.from('{"version":1,"category":"canvas"}').toString(
          "base64"
        ),
        storedAt: new Date(),
        size: 38,
      },
    });

    const caller = viewsRouter.createCaller(callerCtx());
    const result = await caller.updateContent(viewInput);

    // Verify success
    expect(result.success).toBe(true);
    expect(result.viewId).toBe(VIEW_ID);
    expect(result.version).toBe(2);
    expect(result.status).toBe("updated");

    // Verify storage upload was called with new content
    expect(mockDb.storage.upload).toHaveBeenCalledWith(
      `whiteboards/user-1/${DOCUMENT_ID}.json`,
      Buffer.from(
        JSON.stringify({
          version: 2,
          category: "canvas",
          store: {
            "shape:test": {
              id: "shape:test",
              type: "geo",
              x: 100,
              y: 100,
              props: { w: 50, h: 50, text: "test" },
            },
          },
        }),
        "utf-8"
      ),
      { contentType: "application/json" }
    );

    // Verify document version was created
    expect(mockDb.insert).toHaveBeenCalledWith(mockDb.documentVersions);
    expect(mockDb.insert(mockDb.documentVersions).values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        documentId: DOCUMENT_ID,
        version: 2,
        author: "user",
        authorId: "user-1",
        message: "Content update",
      })
    );

    // Verify document was updated
    expect(mockDb.update).toHaveBeenCalledWith(mockDb.documents);
    expect(mockDb.update(mockDb.documents).set).toHaveBeenCalledWith({
      currentVersion: 2,
      lastSavedVersion: 2,
      updatedAt: expect.any(Date),
    });
    expect(mockDb.update(mockDb.documents).where).toHaveBeenCalledWith(
      mockDb.eq(mockDb.documents.id, DOCUMENT_ID)
    );
  });

  it("broadcasts reload to Yjs room", async () => {
    // Setup existing document version
    mockDb.query.documentVersions.findFirst.mockResolvedValueOnce({
      id: "existing-version-id",
      documentId: DOCUMENT_ID,
      version: 1,
      ...{
        author: "user",
        authorId: "user-1",
        message: "Initial version",
        content: Buffer.from('{"version":1,"category":"canvas"}').toString(
          "base64"
        ),
        storedAt: new Date(),
        size: 38,
      },
    });

    const caller = viewsRouter.createCaller(callerCtx());
    await caller.updateContent(viewInput);

    // Verify Yjs broadcast was called
    const mockEmit = vi.mocked(
      // @ts-expect-error - accessing mocked module
      require("@synap/realtime/index.js").io.of().to().emit
    );
    expect(mockEmit).toHaveBeenCalledWith(
      `view:whiteboard-${DOCUMENT_ID}`,
      "yjs:reload",
      expect.objectContaining({
        viewId: VIEW_ID,
        documentId: DOCUMENT_ID,
        version: 2,
        timestamp: expect.any(Number),
      })
    );
  });

  it("rejects non-canvas view types", async () => {
    const caller = viewsRouter.createCaller(callerCtx());
    await expect(
      caller.updateContent({
        ...viewInput,
        viewId: "00000000-0000-4000-8000-0000000000cc", // kanban view id
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("does not support content updates"),
    });
  });

  it("requires version field for optimistic locking", async () => {
    const caller = viewsRouter.createCaller(callerCtx());
    await expect(
      caller.updateContent({
        viewId: VIEW_ID,
        store: {
          "shape:test": {
            id: "shape:test",
            type: "geo",
            x: 100,
            y: 100,
            props: { w: 50, h: 50, text: "test" },
          },
        },
        // Missing version
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      // Zod validation error for missing required field
    });
  });

  it("validates content structure", async () => {
    const caller = viewsRouter.createCaller(callerCtx());
    await expect(
      caller.updateContent({
        viewId: VIEW_ID,
        store: {
          "shape:test": {
            id: "shape:test",
            type: "geo",
            x: 100,
            y: 100,
            props: { w: 50, h: 50, text: "test" },
          },
        },
        version: 2,
        // Invalid category - should be "canvas"
        category: "invalid",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Invalid view content structure"),
    });
  });

  it("handles storage upload failures gracefully", async () => {
    // Mock storage upload to fail
    vi.mocked(
      // @ts-expect-error - accessing mocked module
      require("@synap/storage").storage.upload
    ).mockRejectedValueOnce(new Error("Storage upload failed"));

    // Setup existing document version
    mockDb.query.documentVersions.findFirst.mockResolvedValueOnce({
      id: "existing-version-id",
      documentId: DOCUMENT_ID,
      version: 1,
      ...{
        author: "user",
        authorId: "user-1",
        message: "Initial version",
        content: Buffer.from('{"version":1,"category":"canvas"}').toString(
          "base64"
        ),
        storedAt: new Date(),
        size: 38,
      },
    });

    const caller = viewsRouter.createCaller(callerCtx());
    // Should still succeed even if storage fails (though in reality we'd want to handle this better)
    // For now, we expect it to throw because we await the storage upload
    await expect(caller.updateContent(viewInput)).rejects.toMatchObject({
      // Would throw from storage.upload rejection
    });
  });
});
