/**
 * A whiteboard room whose saved content FAILED to load is flagged on the
 * SERVER, takes no write, and is never saved over the stored file; a room that
 * loaded is never failed by anything a client sends.
 *
 * Before: `bindState` caught a failed storage read (or an unreadable body),
 * logged it, and served the room EMPTY; clients drew on it and the next save
 * replaced the stored board. Now the failure is a server-side flag
 * (`whiteboard-room-state.ts`), never a Y.Doc key: a key would travel to every
 * client, live in its IndexedDB copy, and fail the next HEALTHY room it joins.
 *   - every socket of a failed room is told `yjs-access` read / `load-failed`,
 *     its `sync-update`s and its sync-step-1 answer dropped;
 *   - `writeState` refuses to save it, and the session-close backup is skipped;
 *   - a `synap-room.loadError` key arriving from a client (or a legacy `yjs:`
 *     body) is ignored and stripped;
 *   - a stored key that names NO object is an empty board (never a failure),
 *     and its first save creates the object.
 *
 * Driven through the real persistence adapter and the real y-socket.io hooks
 * that `setupYjsServer` installs, on real Y.Docs; storage and the document row
 * are mocked (`isStorageObjectNotFound` is the real one, from the pure
 * `@synap/storage/interface` subpath).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const BOARD = "44444444-4444-4444-8444-444444444444";
const ROOM = `whiteboard-${BOARD}`;
const KEY = `whiteboards/u/${BOARD}.json`;

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
  WHITEBOARD_LOAD_FAILED_MESSAGE,
  whiteboardLoadFailed,
} from "../yjs-server.js";
import { whiteboardLoadFailure } from "../whiteboard-room-state.js";
import { roomMeta, ROOM_META_KEYS } from "../document-room.js";
import { StorageObjectNotFoundError } from "@synap/storage/interface";

type Persistence = {
  bindState: (name: string, doc: Y.Doc) => Promise<void>;
  writeState: (name: string, doc: Y.Doc) => Promise<void>;
};
type Hooks = {
  initSyncListeners: (s: unknown, d: Y.Doc) => void;
  startSynchronization: (s: unknown, d: Y.Doc) => void;
  persistence: Persistence;
};

const server = () =>
  setupYjsServer({ io: new SocketIOServer() }) as unknown as Hooks;

/** A room's Y.Doc as y-socket.io hands it to the hooks (named, with awareness). */
function roomDoc(): Y.Doc {
  return Object.assign(new Y.Doc(), {
    name: ROOM,
    awareness: {
      getStates: () => new Map(),
      states: new Map(),
      meta: new Map(),
    },
  });
}

function fakeSocket(access: "edit" | "read") {
  const handlers = new Map<string, (...args: any[]) => void>();
  const emits: Array<[string, ...any[]]> = [];
  return {
    data: { yjsAccess: access },
    handlers,
    emits,
    on(event: string, fn: (...args: any[]) => void) {
      handlers.set(event, fn);
      return this;
    },
    emit(event: string, ...args: any[]) {
      emits.push([event, ...args]);
      return true;
    },
  };
}

/** A client update that puts one tldraw record in the board's map. */
function clientShape(id: string): Uint8Array {
  const d = new Y.Doc();
  d.getMap(`tl_map_${BOARD}`).set(id, { typeName: "shape", id });
  return Y.encodeStateAsUpdate(d);
}

/**
 * A client's copy that still carries a `synap-room.loadError` key (an old
 * session, IndexedDB), plus one of its own shapes.
 */
function clientWithStaleMark(id: string): Uint8Array {
  const d = new Y.Doc();
  d.getMap("synap-room").set("loadError", "stale mark from an old session");
  d.getMap(`tl_map_${BOARD}`).set(id, { typeName: "shape", id });
  return Y.encodeStateAsUpdate(d);
}

const STORED = JSON.stringify({
  store: { "shape:a": { typeName: "shape", id: "shape:a" } },
});
const NO_SUCH_KEY = Object.assign(
  new Error("The specified key does not exist."),
  {
    name: "NoSuchKey",
    $metadata: { httpStatusCode: 404 },
  }
);

const accessEmits = (s: ReturnType<typeof fakeSocket>) =>
  s.emits.filter(([e]) => e === "yjs-access");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findDocument.mockResolvedValue({
    id: BOARD,
    type: "whiteboard",
    storageKey: KEY,
    userId: "u",
  });
  mocks.download.mockResolvedValue(Buffer.from(STORED, "utf-8"));
  mocks.upload.mockResolvedValue({ path: KEY });
});

describe("bindState flags a whiteboard room whose saved content failed to load", () => {
  it.each([
    [
      "storage throws",
      () => mocks.download.mockRejectedValue(new Error("ECONNREFUSED")),
    ],
    [
      "the body is not JSON",
      () => mocks.download.mockResolvedValue(Buffer.from("<html>")),
    ],
    [
      "the body is JSON but not a store",
      () => mocks.download.mockResolvedValue(Buffer.from("5")),
    ],
    [
      "the body is a JSON array",
      () => mocks.download.mockResolvedValue(Buffer.from("[1,2]")),
    ],
    [
      "a legacy yjs: body is corrupt",
      () => mocks.download.mockResolvedValue(Buffer.from("yjs:!!!!")),
    ],
  ])(
    "%s → flagged on the server, nothing written into the doc",
    async (_n, arrange) => {
      arrange();
      const doc = roomDoc();
      await server().persistence.bindState(ROOM, doc);
      expect(whiteboardLoadFailed(doc)).toBe(true);
      expect(whiteboardLoadFailure(doc)?.message).toBe(
        WHITEBOARD_LOAD_FAILED_MESSAGE
      );
      // The flag is the server's: no key a client would receive and keep.
      expect(roomMeta(doc).has(ROOM_META_KEYS.loadError)).toBe(false);
    }
  );

  it("CONTROL: a readable body loads its records and is not flagged", async () => {
    const doc = roomDoc();
    await server().persistence.bindState(ROOM, doc);
    expect(doc.getMap(`tl_map_${BOARD}`).get("shape:a")).toBeTruthy();
    expect(whiteboardLoadFailed(doc)).toBe(false);
  });

  it("a legacy yjs: body that carries a loadError key loads, unflagged, with the key removed", async () => {
    const legacy = new Y.Doc();
    legacy.getMap("synap-room").set("loadError", "persisted by a pre-fix save");
    legacy.getMap(`tl_map_${BOARD}`).set("shape:old", { typeName: "shape" });
    mocks.download.mockResolvedValue(
      Buffer.from(
        `yjs:${Buffer.from(Y.encodeStateAsUpdate(legacy)).toString("base64")}`
      )
    );
    const doc = roomDoc();
    await server().persistence.bindState(ROOM, doc);
    expect(whiteboardLoadFailed(doc)).toBe(false);
    expect(doc.getMap(`tl_map_${BOARD}`).get("shape:old")).toBeTruthy();
    expect(roomMeta(doc).has(ROOM_META_KEYS.loadError)).toBe(false);
  });
});

describe("a failed room is never saved over the stored file", () => {
  it("writeState refuses a flagged room, even after content reached it", async () => {
    mocks.download.mockRejectedValue(new Error("ECONNREFUSED"));
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    Y.applyUpdate(doc, clientShape("shape:drawn"));
    await s.persistence.writeState(ROOM, doc);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("CONTROL: an unflagged room with content is saved", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    await s.persistence.writeState(ROOM, doc);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload.mock.calls[0]![0]).toBe(KEY);
  });
});

describe("a failed room takes no write; every socket is told once", () => {
  async function failedRoom() {
    mocks.download.mockRejectedValue(new Error("ECONNREFUSED"));
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    return { s, doc };
  }

  it("a real failed load: each connecting socket (editor or reader) is told `load-failed` exactly once; edits dropped", async () => {
    const { s, doc } = await failedRoom();
    const editor = fakeSocket("edit");
    const reader = fakeSocket("read");
    s.initSyncListeners(editor, doc);
    s.initSyncListeners(reader, doc);
    for (const sock of [editor, reader]) {
      expect(accessEmits(sock)).toEqual([
        ["yjs-access", { access: "read", reason: "load-failed" }],
      ]);
    }
    editor.handlers.get("sync-update")!(clientShape("shape:x"));
    editor.handlers.get("sync-update")!(clientShape("shape:y"));
    expect(doc.getMap(`tl_map_${BOARD}`).size).toBe(0);
    expect(accessEmits(editor)).toHaveLength(1);
  });

  it("an editor's sync-step-1 answer (its local copy) is dropped", async () => {
    const { s, doc } = await failedRoom();
    const socket = fakeSocket("edit");
    s.startSynchronization(socket, doc);
    const step1 = socket.emits.find(([e]) => e === "sync-step-1")!;
    (step1[2] as (u: Uint8Array) => void)(clientShape("shape:local"));
    expect(doc.getMap(`tl_map_${BOARD}`).size).toBe(0);
  });

  it("CONTROL: in a loaded room the editor is told `edit` and its update lands", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    const socket = fakeSocket("edit");
    s.initSyncListeners(socket, doc);
    expect(accessEmits(socket)).toEqual([["yjs-access", { access: "edit" }]]);
    socket.handlers.get("sync-update")!(clientShape("shape:x"));
    expect(doc.getMap(`tl_map_${BOARD}`).get("shape:x")).toBeTruthy();
  });
});

describe("a client carrying a stale loadError key never fails a HEALTHY room", () => {
  it("its sync-step-1 answer lands, the room stays healthy, saves, and the key is stripped", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    const stale = fakeSocket("edit");
    s.startSynchronization(stale, doc);
    const step1 = stale.emits.find(([e]) => e === "sync-step-1")!;
    (step1[2] as (u: Uint8Array) => void)(clientWithStaleMark("shape:mine"));
    expect(whiteboardLoadFailed(doc)).toBe(false);
    expect(doc.getMap(`tl_map_${BOARD}`).get("shape:mine")).toBeTruthy();
    expect(roomMeta(doc).has(ROOM_META_KEYS.loadError)).toBe(false);

    // Another editor already connected keeps editing; nothing is dropped.
    const other = fakeSocket("edit");
    s.initSyncListeners(other, doc);
    other.handlers.get("sync-update")!(clientShape("shape:theirs"));
    expect(doc.getMap(`tl_map_${BOARD}`).get("shape:theirs")).toBeTruthy();
    expect(accessEmits(other)).toEqual([["yjs-access", { access: "edit" }]]);

    await s.persistence.writeState(ROOM, doc);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("the same key arriving by sync-update is ignored and stripped too", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    const socket = fakeSocket("edit");
    s.initSyncListeners(socket, doc);
    socket.handlers.get("sync-update")!(clientWithStaleMark("shape:z"));
    expect(whiteboardLoadFailed(doc)).toBe(false);
    expect(doc.getMap(`tl_map_${BOARD}`).get("shape:z")).toBeTruthy();
    expect(roomMeta(doc).has(ROOM_META_KEYS.loadError)).toBe(false);
  });
});

describe("a stored key that names no object is an empty board, not a failure", () => {
  it("loads empty and editable, and its first save creates the object", async () => {
    mocks.download.mockRejectedValue(NO_SUCH_KEY);
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    expect(whiteboardLoadFailed(doc)).toBe(false);
    const socket = fakeSocket("edit");
    s.initSyncListeners(socket, doc);
    expect(accessEmits(socket)).toEqual([["yjs-access", { access: "edit" }]]);
    socket.handlers.get("sync-update")!(clientShape("shape:first"));
    await s.persistence.writeState(ROOM, doc);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload.mock.calls[0]![0]).toBe(KEY);
  });

  it("an EMPTY save over a missing object is not refused as 'non-empty prior' (it creates the object)", async () => {
    mocks.download.mockRejectedValue(NO_SUCH_KEY);
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    doc.getMap("other").set("k", 1); // a non-tldraw change: the store stays empty
    await s.persistence.writeState(ROOM, doc);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: an empty save over an UNREADABLE prior (network error) is still refused", async () => {
    mocks.download.mockRejectedValue(new Error("ECONNRESET"));
    const s = server();
    const doc = Object.assign(roomDoc(), {});
    // Bypass bindState (it would flag the room): the guard alone is under test.
    doc.getMap("other").set("k", 1);
    await s.persistence.writeState(ROOM, doc);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("a derived storageKey is written to the row only after an upload succeeded", async () => {
    mocks.findDocument.mockResolvedValue({
      id: BOARD,
      type: "whiteboard",
      storageKey: null,
      userId: "u",
    });
    const s = server();
    const doc = roomDoc();
    doc.getMap(`tl_map_${BOARD}`).set("shape:a", { typeName: "shape" });
    mocks.upload.mockRejectedValue(new Error("S3 down"));
    await s.persistence.writeState(ROOM, doc);
    expect(mocks.upload).toHaveBeenCalledTimes(3);
    expect(
      mocks.updateSet.mock.calls.some(
        ([v]) => (v as { storageKey?: unknown }).storageKey
      )
    ).toBe(false);

    mocks.upload.mockResolvedValue({ path: KEY });
    await s.persistence.writeState(ROOM, doc);
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ storageKey: KEY })
    );
  });
});

describe("closing a failed room never overwrites the last good backup", () => {
  async function closeRoom(failed: boolean) {
    if (failed) mocks.download.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const s = server() as Hooks & {
      emit: (name: string, args: unknown[]) => void;
    };
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    // y-socket.io: last socket gone → the room is closing → writeState runs
    // the session-close snapshot (final save + `.bak`).
    s.emit("all-document-connections-closed", [doc]);
    await s.persistence.writeState(ROOM, doc);
    return mocks.upload.mock.calls.map(([key]) => key as string);
  }

  it("a flagged room: no save and no `.bak` upload", async () => {
    expect(await closeRoom(true)).toEqual([]);
  });

  it("CONTROL: a healthy room: final save, then the `.bak` copy", async () => {
    expect(await closeRoom(false)).toEqual([KEY, `${KEY}.bak`]);
  });
});

describe("the bridge's state reply carries the SERVER flag, not a doc key", () => {
  it("GET /yjs/:room/state: loadFailed + message for a flagged room; nothing for a healthy one (even with a stale key)", async () => {
    const { createServer } = await import("http");
    const { setupBridge } = await import("../bridge.js");
    const failed = roomDoc();
    mocks.download.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await server().persistence.bindState(ROOM, failed);
    const healthy = new Y.Doc();
    healthy.getMap("synap-room").set("loadError", "stale key");
    const docs = new Map<string, Y.Doc>([
      [ROOM, failed],
      ["whiteboard-healthy", healthy],
    ]);
    const http = createServer();
    setupBridge(new SocketIOServer(), http, () => ({ documents: docs }));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const port = (http.address() as { port: number }).port;
    try {
      const read = async (room: string) =>
        (await (
          await fetch(`http://127.0.0.1:${port}/yjs/${room}/state`)
        ).json()) as Record<string, unknown>;
      expect(await read(ROOM)).toMatchObject({
        roomId: ROOM,
        loadFailed: true,
        loadError: WHITEBOARD_LOAD_FAILED_MESSAGE,
      });
      const ok = await read("whiteboard-healthy");
      expect(ok.loadFailed).toBeUndefined();
      expect(typeof ok.state).toBe("string");
    } finally {
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
});

describe("a DATABASE error while loading a whiteboard room flags it on the server too", () => {
  it("findDocument throws: flagged, sockets told load-failed, updates dropped, nothing uploaded once the DB is back", async () => {
    mocks.findDocument.mockRejectedValueOnce(
      new Error("connection terminated")
    );
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    expect(whiteboardLoadFailed(doc)).toBe(true);
    expect(roomMeta(doc).has(ROOM_META_KEYS.loadError)).toBe(false);

    const editor = fakeSocket("edit");
    s.initSyncListeners(editor, doc);
    expect(accessEmits(editor)).toEqual([
      ["yjs-access", { access: "read", reason: "load-failed" }],
    ]);
    editor.handlers.get("sync-update")!(clientShape("shape:new"));
    const answer = fakeSocket("edit");
    s.startSynchronization(answer, doc);
    const step1 = answer.emits.find(([e]) => e === "sync-step-1")!;
    (step1[2] as (u: Uint8Array) => void)(clientShape("shape:idb"));
    expect(doc.getMap(`tl_map_${BOARD}`).size).toBe(0);

    // The DB is back (beforeEach's findDocument): the save still refuses.
    await s.persistence.writeState(ROOM, doc);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled(); // the stored board was never even read
  });
});

describe("only a definite missing KEY is an empty board", () => {
  it.each([
    [
      "a bare HTTP 404 (a proxy while MinIO restarts)",
      Object.assign(new Error("404"), { $metadata: { httpStatusCode: 404 } }),
    ],
    [
      "NoSuchBucket",
      Object.assign(new Error("bucket"), {
        name: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      }),
    ],
    [
      "a HEAD-style NotFound",
      Object.assign(new Error("nf"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      }),
    ],
  ])(
    "%s → a FAILED load: flagged, the first stroke never uploaded",
    async (_n, err) => {
      mocks.download.mockRejectedValue(err);
      const s = server();
      const doc = roomDoc();
      await s.persistence.bindState(ROOM, doc);
      expect(whiteboardLoadFailed(doc)).toBe(true);
      const editor = fakeSocket("edit");
      s.initSyncListeners(editor, doc);
      editor.handlers.get("sync-update")!(clientShape("shape:one"));
      await s.persistence.writeState(ROOM, doc);
      expect(mocks.upload).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "S3 NoSuchKey (by Code)",
      Object.assign(new Error("k"), { Code: "NoSuchKey" }),
    ],
    ["StorageObjectNotFoundError", new StorageObjectNotFoundError(KEY)],
  ])("%s → an empty, editable board", async (_n, err) => {
    mocks.download.mockRejectedValue(err);
    const doc = roomDoc();
    await server().persistence.bindState(ROOM, doc);
    expect(whiteboardLoadFailed(doc)).toBe(false);
  });
});

describe("the bridge refuses a restore into a room that failed to load", () => {
  it("POST /yjs/:room/restore → 409 load-failed, nothing applied; a healthy room still restores", async () => {
    const { createServer } = await import("http");
    const { setupBridge } = await import("../bridge.js");
    mocks.download.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const failed = roomDoc();
    await server().persistence.bindState(ROOM, failed);
    const healthy = new Y.Doc();
    const docs = new Map<string, Y.Doc>([
      [ROOM, failed],
      ["whiteboard-healthy", healthy],
    ]);
    const http = createServer();
    setupBridge(new SocketIOServer(), http, () => ({ documents: docs }));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const port = (http.address() as { port: number }).port;
    const state = Buffer.from(clientShape("shape:restored")).toString("base64");
    const restore = (room: string) =>
      fetch(`http://127.0.0.1:${port}/yjs/${room}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
    try {
      const refused = await restore(ROOM);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        reason: "load-failed",
        applied: false,
      });
      expect(failed.getMap(`tl_map_${BOARD}`).size).toBe(0);
      const ok = await restore("whiteboard-healthy");
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ applied: true });
    } finally {
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
});
