/**
 * A whiteboard room whose saved content FAILED to load is marked, takes no
 * write, and is never saved over the stored file.
 *
 * Before: `bindState` caught a failed storage read (or an unreadable body),
 * logged it, and served the room EMPTY; clients drew on it and the next save
 * replaced the stored board with what they drew (only "never overwrite a
 * non-empty store with an empty one" stood in the way). Document rooms already
 * marked such a room (`markDocumentRoomLoadFailed`); whiteboard rooms now do,
 * and the mark is ENFORCED on the server, not only shown to clients:
 *   - every socket is served the room read-only (`yjs-access` reason
 *     `load-failed`), its `sync-update`s and its sync-step-1 answer dropped;
 *   - `writeState` refuses to save the room.
 *
 * Driven through the real persistence adapter and the real y-socket.io hooks
 * that `setupYjsServer` installs, on real Y.Docs; storage and the document row
 * are mocked.
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
    update: () => ({ set: () => ({ where: async () => undefined }) }),
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
import { roomMeta, ROOM_META_KEYS } from "../document-room.js";

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

const STORED = JSON.stringify({
  store: { "shape:a": { typeName: "shape", id: "shape:a" } },
});

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

describe("bindState marks a whiteboard room whose saved content failed to load", () => {
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
      "a legacy yjs: body is corrupt",
      () => mocks.download.mockResolvedValue(Buffer.from("yjs:!!!!")),
    ],
  ])("%s → marked", async (_name, arrange) => {
    arrange();
    const doc = roomDoc();
    await server().persistence.bindState(ROOM, doc);
    expect(roomMeta(doc).get(ROOM_META_KEYS.loadError)).toBe(
      WHITEBOARD_LOAD_FAILED_MESSAGE
    );
    expect(whiteboardLoadFailed(doc)).toBe(true);
  });

  it("CONTROL: a readable body loads its records and leaves no mark", async () => {
    const doc = roomDoc();
    await server().persistence.bindState(ROOM, doc);
    expect(doc.getMap(`tl_map_${BOARD}`).get("shape:a")).toBeTruthy();
    expect(whiteboardLoadFailed(doc)).toBe(false);
  });
});

describe("a failed room is never saved over the stored file", () => {
  it("writeState refuses a marked room, even after content reached it", async () => {
    mocks.download.mockRejectedValue(new Error("ECONNREFUSED"));
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    // Content reaching the room anyway (e.g. a bridge restore) changes nothing.
    Y.applyUpdate(doc, clientShape("shape:drawn"));
    await s.persistence.writeState(ROOM, doc);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("CONTROL: an unmarked room with content is saved", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    await s.persistence.writeState(ROOM, doc);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload.mock.calls[0]![0]).toBe(KEY);
  });
});

describe("a failed room takes no write from any socket", () => {
  async function failedRoom() {
    mocks.download.mockRejectedValue(new Error("ECONNREFUSED"));
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    return { s, doc };
  }

  it("an EDITOR is told `read` / `load-failed` and its sync-update is dropped", async () => {
    const { s, doc } = await failedRoom();
    const socket = fakeSocket("edit");
    s.initSyncListeners(socket, doc);
    expect(socket.emits).toContainEqual([
      "yjs-access",
      { access: "read", reason: "load-failed" },
    ]);
    socket.handlers.get("sync-update")!(clientShape("shape:x"));
    expect(doc.getMap(`tl_map_${BOARD}`).size).toBe(0);
  });

  it("an editor's sync-step-1 answer (its local copy) is dropped", async () => {
    const { s, doc } = await failedRoom();
    const socket = fakeSocket("edit");
    s.startSynchronization(socket, doc);
    const step1 = socket.emits.find(([e]) => e === "sync-step-1")!;
    (step1[2] as (u: Uint8Array) => void)(clientShape("shape:local"));
    expect(doc.getMap(`tl_map_${BOARD}`).size).toBe(0);
  });

  it("a mark set mid-session drops the editor's NEXT update", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    const socket = fakeSocket("edit");
    s.initSyncListeners(socket, doc);
    socket.handlers.get("sync-update")!(clientShape("shape:before"));
    roomMeta(doc).set(ROOM_META_KEYS.loadError, "late");
    socket.handlers.get("sync-update")!(clientShape("shape:after"));
    const map = doc.getMap(`tl_map_${BOARD}`);
    expect(map.get("shape:before")).toBeTruthy();
    expect(map.get("shape:after")).toBeUndefined();
  });

  it("CONTROL: in a loaded room the editor is told `edit` and its update lands", async () => {
    const s = server();
    const doc = roomDoc();
    await s.persistence.bindState(ROOM, doc);
    const socket = fakeSocket("edit");
    s.initSyncListeners(socket, doc);
    expect(socket.emits).toContainEqual(["yjs-access", { access: "edit" }]);
    socket.handlers.get("sync-update")!(clientShape("shape:x"));
    expect(doc.getMap(`tl_map_${BOARD}`).get("shape:x")).toBeTruthy();
  });

  it("a DOCUMENT room's mark is left to its own contract (not read-only by this rule)", () => {
    const doc = Object.assign(new Y.Doc(), { name: BOARD });
    roomMeta(doc).set(ROOM_META_KEYS.loadError, "x");
    expect(whiteboardLoadFailed(doc)).toBe(false);
  });
});
