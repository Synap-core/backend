/**
 * The place door's write into a whiteboard (`applyWhiteboardRecords`, bridge
 * `POST /yjs/:roomId/apply`): the open room when there is one (one Y
 * transaction every client receives, saved at once), else the stored file,
 * under the room's lock; a room or file that failed to load takes no write;
 * a save that did not land is an error.
 *
 * THE RACE (the main risk): a person opens a CLOSED board while the door
 * writes its file. Driven both ways through the real persistence adapter that
 * `setupYjsServer` installs (the same `bindState` y-socket.io awaits on a
 * join), over an in-memory object store with a slow read so the two overlap:
 *   - write first, join during it: the join's load waits on the lock and
 *     loads the written file;
 *   - join first, write during its load: the write waits, then goes into the
 *     loaded room and saves it.
 * Without the lock either order loses the agent's shapes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const BOARD = "55555555-5555-4555-8555-555555555555";
const ROOM = `whiteboard-${BOARD}`;
const KEY = `whiteboards/u/${BOARD}.json`;
const MAP = `tl_map_${BOARD}`;

const mocks = vi.hoisted(() => ({
  findDocument: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
  updateSet: vi.fn(),
}));

vi.mock("@synap/api/document-access", () => ({
  resolveDocumentRoomAccess: vi.fn(),
}));
vi.mock("@synap/auth", () => ({
  getKratosSessionByToken: vi.fn(),
  getKratosSessionByCookie: vi.fn(),
  safeTokenEqual: (a: string, b: string) => a === b,
}));
vi.mock("@synap/database", () => ({
  db: {
    query: { documents: { findFirst: mocks.findDocument } },
    update: () => ({
      set: (values: unknown) => {
        mocks.updateSet(values);
        return { where: async () => undefined };
      },
    }),
  },
  eq: (_column: unknown, value: unknown) => ({ value }),
  and: vi.fn(),
  claimDocumentRevision: vi.fn(),
  INHERIT_LAST_AUTHOR: Symbol("inherit"),
}));
vi.mock("@synap/database/schema", () => ({
  documents: { id: "documents.id" },
  documentSessions: {},
}));
vi.mock("@synap/storage", () => ({
  storage: { downloadBuffer: mocks.download, upload: mocks.upload },
}));
vi.mock("@synap/database/person-devices", () => ({
  isPersonDeviceToken: () => false,
  resolvePersonDeviceSession: async () => null,
  liveDeviceIds: async () => new Set<string>(),
}));

import { Server as SocketIOServer } from "socket.io";
import {
  setupYjsServer,
  WhiteboardApplyError,
  type YjsServerInstance,
} from "../yjs-server.js";
import { markWhiteboardLoadFailed } from "../whiteboard-room-state.js";
import { parseYjsApplyRequest } from "../bridge.js";
import type { YjsRoomApplyRequest } from "@synap/events/realtime-schemas";

type Persistence = {
  bindState: (name: string, doc: Y.Doc) => Promise<void>;
  writeState: (name: string, doc: Y.Doc) => Promise<void>;
};
type Server = YjsServerInstance & { persistence: Persistence };

const server = () =>
  setupYjsServer({ io: new SocketIOServer() }) as unknown as Server;

function roomDoc(): Y.Doc {
  return Object.assign(new Y.Doc(), { name: ROOM });
}

const shape = (id: string, x = 0) => ({
  id,
  typeName: "shape",
  type: "geo",
  x,
  y: 0,
});
const AGENT = { userId: "u", agentUserId: "agent-1" };
/** A shape an agent placed that the person has not yet kept. */
const pendingShape = (id: string, x = 0) => ({
  ...shape(id, x),
  props: { w: 100, h: 50 },
  meta: { pending: true, placedBy: AGENT },
});
const put = (
  ...records: Array<ReturnType<typeof shape> | ReturnType<typeof pendingShape>>
): YjsRoomApplyRequest => ({
  documentId: BOARD,
  put: records,
  origin: "synap-place:u",
});

/** An in-memory object store whose reads can be slowed down. */
let stored: string | null;
let readDelayMs = 0;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storedRecords = () =>
  stored ? (JSON.parse(stored) as { store: Record<string, any> }).store : {};

beforeEach(() => {
  vi.clearAllMocks();
  stored = JSON.stringify({
    store: { "shape:a": shape("shape:a") },
  });
  readDelayMs = 0;
  mocks.findDocument.mockResolvedValue({
    id: BOARD,
    type: "whiteboard",
    storageKey: KEY,
    userId: "u",
  });
  mocks.download.mockImplementation(async () => {
    const snapshot = stored;
    if (readDelayMs) await tick(readDelayMs);
    if (snapshot === null) throw new Error("ECONNREFUSED");
    return Buffer.from(snapshot, "utf-8");
  });
  mocks.upload.mockImplementation(async (_key: string, body: Buffer) => {
    stored = body.toString("utf-8");
    return { path: KEY };
  });
});

describe("applyWhiteboardRecords: an OPEN board", () => {
  it("writes into the live doc in ONE transaction with the caller's origin, and saves at once", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    const origins: unknown[] = [];
    doc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));

    const reply = await s.applyWhiteboardRecords(
      ROOM,
      put(shape("shape:b"), shape("shape:c"))
    );

    expect(reply).toEqual({
      roomId: ROOM,
      applied: true,
      target: "live",
      put: 2,
      patched: 0,
      removed: 0,
      skipped: [],
    });
    expect(Object.keys(doc.getMap(MAP).toJSON()).sort()).toEqual([
      "shape:a",
      "shape:b",
      "shape:c",
    ]);
    expect(origins).toEqual(["synap-place:u"]);
    // Saved before the reply: the file holds it too.
    expect(Object.keys(storedRecords()).sort()).toEqual([
      "shape:a",
      "shape:b",
      "shape:c",
    ]);
  });

  it("a retry with the same ids REPLACES a still-pending shape, never duplicates", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    await s.applyWhiteboardRecords(ROOM, put(pendingShape("shape:b", 1)));
    await s.applyWhiteboardRecords(ROOM, put(pendingShape("shape:b", 2)));
    const map = doc.getMap(MAP).toJSON();
    expect(Object.keys(map).sort()).toEqual(["shape:a", "shape:b"]);
    expect(map["shape:b"].x).toBe(2);
  });

  it("NEVER resets a shape the person kept: the repeat is skipped and reported", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    await s.applyWhiteboardRecords(ROOM, put(pendingShape("shape:b", 1)));
    // The person keeps it (pending dropped) and moves it.
    doc.getMap(MAP).set("shape:b", {
      ...pendingShape("shape:b", 900),
      meta: { placedBy: AGENT },
    });
    const reply = await s.applyWhiteboardRecords(
      ROOM,
      put(pendingShape("shape:b", 0))
    );
    expect(reply).toMatchObject({ put: 0, skipped: ["shape:b"] });
    const kept = doc.getMap(MAP).toJSON()["shape:b"];
    expect(kept.x).toBe(900);
    expect(kept.meta.pending).toBeUndefined();
  });

  it("a patch merges into the LIVE record: a person's edit since the API read survives", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    doc.getMap(MAP).set("shape:a", {
      ...shape("shape:a", 5),
      props: { w: 100, h: 50, text: "typed by a person just now" },
    });
    const reply = await s.applyWhiteboardRecords(ROOM, {
      documentId: BOARD,
      patch: [{ shapeId: "shape:a", w: 300 }],
      origin: "o",
    });
    expect(reply).toMatchObject({ patched: 1, put: 0 });
    const rec = doc.getMap(MAP).toJSON()["shape:a"];
    expect(rec.x).toBe(5);
    expect(rec.props).toEqual({
      w: 300,
      h: 50,
      text: "typed by a person just now",
    });
  });

  it("a patch the shape cannot take is refused, nothing written", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    await expect(
      s.applyWhiteboardRecords(ROOM, {
        documentId: BOARD,
        patch: [{ shapeId: "shape:a", w: 3 }],
        origin: "o",
      })
    ).rejects.toMatchObject({ reason: "bad_request", status: 400 });
    await expect(
      s.applyWhiteboardRecords(ROOM, {
        documentId: BOARD,
        patch: [{ shapeId: "shape:nope", x: 3 }],
        put: [pendingShape("shape:new")],
        origin: "o",
      })
    ).rejects.toMatchObject({ reason: "shape_not_found" });
    expect(doc.getMap(MAP).has("shape:new")).toBe(false);
  });

  it("a removal takes what is in the board NOW: a child added since the API read goes too", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    doc.getMap(MAP).set("shape:late", {
      ...shape("shape:late"),
      parentId: "shape:a",
    });
    const reply = await s.applyWhiteboardRecords(ROOM, {
      documentId: BOARD,
      remove: ["shape:a"],
      origin: "o",
    });
    expect(reply.removed).toBe(2);
    expect(Object.keys(doc.getMap(MAP).toJSON())).toEqual([]);
  });

  it("removing the LAST shape is a real save, not save_failed", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    const reply = await s.applyWhiteboardRecords(ROOM, {
      documentId: BOARD,
      remove: ["shape:a"],
      origin: "o",
    });
    expect(reply).toMatchObject({ removed: 1, target: "live" });
    expect(storedRecords()).toEqual({});
  });

  it("removes by id", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    const reply = await s.applyWhiteboardRecords(ROOM, {
      documentId: BOARD,
      put: [shape("shape:b")],
      remove: ["shape:a"],
      origin: "o",
    });
    expect(reply.removed).toBe(1);
    expect(Object.keys(doc.getMap(MAP).toJSON())).toEqual(["shape:b"]);
    expect(Object.keys(storedRecords())).toEqual(["shape:b"]);
  });

  it("REFUSES a room that failed to load: nothing written, nothing saved", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    markWhiteboardLoadFailed(doc);
    const before = stored;
    await expect(
      s.applyWhiteboardRecords(ROOM, put(shape("shape:b")))
    ).rejects.toMatchObject({ reason: "load_failed", status: 409 });
    expect(doc.getMap(MAP).has("shape:b")).toBe(false);
    expect(stored).toBe(before);
  });

  it("a save that does not land is an ERROR (save_failed), never a success", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    mocks.upload.mockRejectedValue(new Error("minio down"));
    await expect(
      s.applyWhiteboardRecords(ROOM, put(pendingShape("shape:b")))
    ).rejects.toBeInstanceOf(WhiteboardApplyError);
    await expect(
      s.applyWhiteboardRecords(ROOM, put(pendingShape("shape:b")))
    ).rejects.toMatchObject({ reason: "save_failed" });
  }, 10_000);
});

describe("applyWhiteboardRecords: a CLOSED board", () => {
  it("writes into the stored file (loaded as a room would, saved back)", async () => {
    const s = server();
    const reply = await s.applyWhiteboardRecords(ROOM, put(shape("shape:b")));
    expect(reply.target).toBe("stored");
    expect(Object.keys(storedRecords()).sort()).toEqual(["shape:a", "shape:b"]);
  });

  it("a board never saved gets its first file", async () => {
    stored = null;
    mocks.download.mockRejectedValue(
      Object.assign(new Error("The specified key does not exist."), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      })
    );
    const s = server();
    const reply = await s.applyWhiteboardRecords(ROOM, put(shape("shape:b")));
    expect(reply.target).toBe("stored");
    expect(Object.keys(storedRecords())).toEqual(["shape:b"]);
  });

  it("REFUSES a stored file that cannot be loaded: the file is left as it is", async () => {
    mocks.download.mockRejectedValue(new Error("ECONNREFUSED"));
    const s = server();
    const before = stored;
    await expect(
      s.applyWhiteboardRecords(ROOM, put(shape("shape:b")))
    ).rejects.toMatchObject({ reason: "load_failed" });
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(stored).toBe(before);
  });

  it("no such board document is not_found", async () => {
    mocks.findDocument.mockResolvedValue(undefined);
    const s = server();
    await expect(
      s.applyWhiteboardRecords(ROOM, put(shape("shape:b")))
    ).rejects.toMatchObject({ reason: "not_found", status: 404 });
  });
});

describe("the join race: a person opens the board while the door writes", () => {
  it("write first, join during it → the join loads the written file", async () => {
    const s = server();
    readDelayMs = 30;
    const writing = s.applyWhiteboardRecords(ROOM, put(shape("shape:agent")));
    await tick(5); // the write holds the lock, reading the file
    const joined = roomDoc();
    const joining = s.persistence.bindState(ROOM, joined);
    await Promise.all([writing, joining]);
    expect(joined.getMap(MAP).has("shape:agent")).toBe(true);
    expect(storedRecords()).toHaveProperty("shape:agent");
  });

  it("join first, write during its load → the write lands in the loaded room and is saved", async () => {
    const s = server();
    readDelayMs = 30;
    const joined = roomDoc();
    const joining = s.persistence.bindState(ROOM, joined);
    await tick(5); // the join holds the lock, reading the file
    const writing = s.applyWhiteboardRecords(ROOM, put(shape("shape:agent")));
    const [, reply] = await Promise.all([joining, writing]);
    expect(reply.target).toBe("live");
    expect(joined.getMap(MAP).has("shape:agent")).toBe(true);
    expect(storedRecords()).toHaveProperty("shape:agent");
    // The room's own later save keeps it (it saves the doc that holds it).
    await s.persistence.writeState(ROOM, joined);
    expect(storedRecords()).toHaveProperty("shape:agent");
  });

  it("a room's own save never interleaves with the write", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    let inFlight = 0;
    let overlap = false;
    mocks.upload.mockImplementation(async (_k: string, body: Buffer) => {
      inFlight++;
      if (inFlight > 1) overlap = true;
      await tick(10);
      stored = body.toString("utf-8");
      inFlight--;
      return { path: KEY };
    });
    await Promise.all([
      s.persistence.writeState(ROOM, doc),
      s.applyWhiteboardRecords(ROOM, put(shape("shape:b"))),
      s.persistence.writeState(ROOM, doc),
    ]);
    expect(overlap).toBe(false);
    expect(storedRecords()).toHaveProperty("shape:b");
  });
});

describe("parseYjsApplyRequest (the bridge's body check)", () => {
  it("accepts shapes, pages and bindings for the room's own board", () => {
    const r = parseYjsApplyRequest(ROOM, {
      documentId: BOARD,
      origin: "o",
      put: [
        { id: "page:p", typeName: "page" },
        { id: "shape:s", typeName: "shape" },
        { id: "binding:b", typeName: "binding" },
      ],
      remove: ["shape:x"],
    });
    expect(r.ok).toBe(true);
  });
  it.each([
    [
      "a document room",
      BOARD,
      { documentId: BOARD, origin: "o", put: [shape("shape:s")] },
    ],
    [
      "another board's document",
      ROOM,
      {
        documentId: "66666666-6666-4666-8666-666666666666",
        origin: "o",
        put: [shape("shape:s")],
      },
    ],
    ["no origin", ROOM, { documentId: BOARD, put: [shape("shape:s")] }],
    ["nothing", ROOM, { documentId: BOARD, origin: "o", put: [] }],
    [
      "an id that does not match its typeName",
      ROOM,
      {
        documentId: BOARD,
        origin: "o",
        put: [{ id: "page:x", typeName: "shape" }],
      },
    ],
    [
      "a record that is not tldraw's",
      ROOM,
      {
        documentId: BOARD,
        origin: "o",
        put: [{ id: "synap-room", typeName: "meta" }],
      },
    ],
    [
      "a removal of a non-record key",
      ROOM,
      { documentId: BOARD, origin: "o", remove: ["synap-room"] },
    ],
    [
      "a patch that names no shape",
      ROOM,
      { documentId: BOARD, origin: "o", patch: [{ shapeId: "page:p" }] },
    ],
    [
      "a record larger than the cap",
      ROOM,
      {
        documentId: BOARD,
        origin: "o",
        put: [{ ...shape("shape:big"), props: { x: "a".repeat(300_000) } }],
      },
    ],
  ])("refuses %s", (_n, room, body) => {
    expect(parseYjsApplyRequest(room, body).ok).toBe(false);
  });
});
