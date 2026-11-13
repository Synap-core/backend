/**
 * A version restore the open room will refuse is refused BY THE MUTATION.
 *
 * Before: `whiteboards.restoreVersion` only queued a `whiteboard-restore`
 * job; a room that failed to load its board (the realtime server's flag,
 * `YjsRoomStateReply.loadFailed`, #1043) answered the job's restore with 409,
 * the job threw where nobody saw it, and the person's "Restoring…" never
 * ended. Now the mutation asks the room first (`readLiveRecords`, the board
 * read door's live read) and throws CONFLICT with the reason, which the
 * client's mutation error handler shows; nothing is queued.
 *
 * Seams mocked: the view and version rows, the version content read, the
 * job queue, and the realtime bridge (`fetch`, a REAL encoded Y.Doc).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const USER = "0aaaaaaa-0000-4000-8000-000000000001";
const VIEW = "1b1b1b1b-0000-4000-8000-0000000000aa";
const DOC = "2c2c2c2c-0000-4000-8000-0000000000bb";
const VERSION = "3d3d3d3d-0000-4000-8000-0000000000cc";
const ROOM = `whiteboard-${DOC}`;

const m = vi.hoisted(() => ({
  sends: [] as unknown[],
  state: null as null | (() => Promise<Response>),
  /** The document the version row belongs to. */
  versionDoc: "2c2c2c2c-0000-4000-8000-0000000000bb",
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        views: {
          findFirst: async () => ({
            id: VIEW,
            userId: USER,
            documentId: DOC,
            yjsRoomId: null,
          }),
        },
        documentVersions: {
          findFirst: async () => ({ id: VERSION, documentId: m.versionDoc }),
        },
      },
    },
    readDocumentVersionContent: async () => "c3RhdGU=",
  };
});
// The read-only guard asks the sync state; the mocked db holds none (CI has no
// database for this suite), and a pod that is not read-only is the case here.
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
}));
vi.mock("@synap/jobs", () => ({
  getBoss: () => ({
    send: async (...args: unknown[]) => {
      m.sends.push(args);
    },
  }),
}));
vi.stubGlobal("fetch", async () => {
  if (!m.state) throw new Error("state not set");
  return m.state();
});

const { whiteboardsRouter } = await import("./whiteboards.js");
const caller = () =>
  whiteboardsRouter.createCaller({
    authenticated: true,
    userId: USER,
  } as never);

function roomState(extra: Record<string, unknown>) {
  return async () => {
    const doc = new Y.Doc();
    doc.getMap(`tl_map_${DOC}`).set("shape:a", { id: "shape:a" });
    const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
    return new Response(JSON.stringify({ roomId: ROOM, state, ...extra }), {
      status: 200,
    });
  };
}

beforeEach(() => {
  m.sends = [];
  m.versionDoc = DOC;
});

describe("whiteboards.restoreVersion refuses what the room will refuse", () => {
  it("a room that failed to load: CONFLICT with the reason, nothing queued", async () => {
    m.state = roomState({
      loadFailed: true,
      loadError: "The board's saved content could not be loaded.",
    });
    await expect(
      caller().restoreVersion({ viewId: VIEW, versionId: VERSION })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("could not be loaded"),
    });
    expect(m.sends).toHaveLength(0);
  });

  it("a realtime server that does not answer: SERVICE_UNAVAILABLE, nothing queued", async () => {
    m.state = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      caller().restoreVersion({ viewId: VIEW, versionId: VERSION })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(m.sends).toHaveLength(0);
  });

  it("a loaded open room, or a closed one, is restored (queued)", async () => {
    m.state = roomState({});
    await expect(
      caller().restoreVersion({ viewId: VIEW, versionId: VERSION })
    ).resolves.toMatchObject({ status: "restoring" });
    m.state = async () =>
      new Response(JSON.stringify({ error: "Room not active", roomId: ROOM }), {
        status: 404,
      });
    await expect(
      caller().restoreVersion({ viewId: VIEW, versionId: VERSION })
    ).resolves.toMatchObject({ status: "restoring" });
    expect(m.sends).toHaveLength(2);
  });

  it("a version of ANOTHER document is not found: never restored into this board", async () => {
    m.state = roomState({});
    m.versionDoc = "9e9e9e9e-0000-4000-8000-0000000000ff";
    await expect(
      caller().restoreVersion({ viewId: VIEW, versionId: VERSION })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(m.sends).toHaveLength(0);
  });
});
