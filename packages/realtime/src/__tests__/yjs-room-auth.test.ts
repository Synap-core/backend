/**
 * The `/yjs` gates (S0, Documents v2) + the `initialize()` tripwire.
 *
 * What is covered, each separately:
 *
 *  1. WHO — the handshake gate (y-socket.io's `authenticate`). Identity is
 *     server-proven: the Kratos session in `auth.token` must resolve to
 *     `auth.userId` (`verifyHandshakeUser`, shared with `/presence`). A forged
 *     `userId`, or no session at all, is refused. The old gate took `userId`
 *     at its word.
 *
 *  2. WHAT — the room gate. `authorizeRoomAccess` asks the api's ONE document
 *     floor (`resolveDocumentRoomAccess`, `@synap/api/document-access`) and the
 *     socket is admitted `edit`, `read`, or refused. The predicate itself —
 *     including "a no-workspace document does NOT admit a member of another
 *     workspace" — is driven for real on PGlite in
 *     `packages/api/src/utils/document-edit-access.pglite.test.ts`; here it is
 *     mocked as a table, and these tests pin that the gate FOLLOWS it (no
 *     fallback of its own).
 *
 *  3. READ-ONLY — a `read` socket is served the room but every update it sends
 *     is dropped. Driven through the REAL y-socket.io hooks on a real Y.Doc.
 *
 *  4. The `initialize()` tripwire (unchanged): YSocketIO@1.1.3's constructor
 *     leaves `nsp` null; without `initialize()` every `/yjs|{room}` connection
 *     is answered "Invalid namespace", silently.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOC = "11111111-1111-4111-8111-111111111111";
const DOC_POD = "33333333-3333-4333-8333-333333333333"; // no workspace

const EDITOR = "user-editor";
const READER = "user-reader";
const STRANGER = "user-stranger"; // e.g. a member of some OTHER workspace

/** The api floor, as a table: [user][doc] → access. */
const FLOOR: Record<string, Record<string, "edit" | "read">> = {
  [EDITOR]: { [DOC]: "edit", [DOC_POD]: "edit" },
  [READER]: { [DOC]: "read" },
};

/** Kratos, as a table: session token → identity id. */
const SESSIONS: Record<string, string> = {
  "tok-editor": EDITOR,
  "tok-reader": READER,
  "tok-stranger": STRANGER,
};

const mocks = vi.hoisted(() => ({
  resolveAccess: vi.fn(),
  byToken: vi.fn(),
  byCookie: vi.fn(),
}));

vi.mock("@synap/api/document-access", () => ({
  resolveDocumentRoomAccess: mocks.resolveAccess,
}));

vi.mock("@synap/auth", () => ({
  getKratosSessionByToken: mocks.byToken,
  getKratosSessionByCookie: mocks.byCookie,
}));

vi.mock("@synap/database", () => ({
  db: { query: {} },
  eq: vi.fn(),
  and: vi.fn(),
  claimDocumentRevision: vi.fn(),
  INHERIT_LAST_AUTHOR: Symbol("inherit"),
}));

vi.mock("@synap/database/schema", () => ({
  documents: { id: "documents.id" },
  documentSessions: {},
}));

vi.mock("@synap/storage", () => ({ storage: {} }));

import { Server as SocketIOServer } from "socket.io";
import {
  authorizeRoomAccess,
  insecureYjsAllowed,
  installReadOnlySync,
  setupYjsServer,
} from "../yjs-server.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAccess.mockImplementation(
    async (userId: string, documentId: string) =>
      FLOOR[userId]?.[documentId] ?? "none"
  );
  mocks.byToken.mockImplementation(async (token: string) =>
    SESSIONS[token] ? { active: true, identity: { id: SESSIONS[token] } } : null
  );
  mocks.byCookie.mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.ALLOW_INSECURE_YJS;
  vi.unstubAllEnvs();
});

// ─── The room floor ─────────────────────────────────────────────────────────

describe("authorizeRoomAccess follows the document's own floor", () => {
  it("an editor gets edit, a reader gets read, anyone else none", async () => {
    await expect(authorizeRoomAccess(DOC, EDITOR)).resolves.toBe("edit");
    await expect(authorizeRoomAccess(DOC, READER)).resolves.toBe("read");
    await expect(authorizeRoomAccess(DOC, STRANGER)).resolves.toBe("none");
  });

  it("a no-workspace document admits only who its floor admits (no any-member fallback)", async () => {
    await expect(authorizeRoomAccess(DOC_POD, EDITOR)).resolves.toBe("edit");
    await expect(authorizeRoomAccess(DOC_POD, STRANGER)).resolves.toBe("none");
  });

  it("asks the api floor with the room's document id, for whiteboard rooms too", async () => {
    await authorizeRoomAccess(`whiteboard-${DOC}`, READER);
    expect(mocks.resolveAccess).toHaveBeenCalledWith(READER, DOC);
  });

  it.each([
    ["a non-UUID room name", "not-a-uuid"],
    ["a whiteboard- prefix with a non-UUID id", "whiteboard-abc"],
    ["an empty room name", ""],
  ])("refuses %s without asking the floor", async (_label, roomName) => {
    await expect(authorizeRoomAccess(roomName, EDITOR)).resolves.toBe("none");
    expect(mocks.resolveAccess).not.toHaveBeenCalled();
  });

  it("propagates a floor error rather than swallowing it into an allow", async () => {
    mocks.resolveAccess.mockRejectedValueOnce(new Error("connection refused"));
    await expect(authorizeRoomAccess(DOC, EDITOR)).rejects.toThrow(
      "connection refused"
    );
  });
});

// ─── Both gates, as socket.io runs them ─────────────────────────────────────

type Gate = (socket: any, next: (err?: Error) => void) => unknown;

/** [0] = y-socket.io's `authenticate` wrapper, [1] = our room gate. */
function gatesOf(server: unknown): Gate[] {
  const nsp = (server as any).nsp;
  expect(nsp, "yServer.nsp is null — initialize() was not called").toBeTruthy();
  const fns = nsp._fns as Gate[];
  expect(fns).toHaveLength(2);
  return fns;
}

/** Run a fake socket through both gates; resolves with the error or the socket. */
async function connect(
  roomName: string,
  auth: Record<string, unknown>
): Promise<{ err?: Error; data: Record<string, unknown> }> {
  const io = new SocketIOServer();
  const gates = gatesOf(setupYjsServer({ io }));
  const socket = {
    nsp: { name: `/yjs|${roomName}` },
    handshake: { auth },
    data: {} as Record<string, unknown>,
  };
  for (const gate of gates) {
    const err = await new Promise<Error | undefined>((resolve) => {
      void gate(socket, resolve);
    });
    if (err) return { err, data: socket.data };
  }
  return { data: socket.data };
}

describe("the /yjs handshake: identity is server-proven", () => {
  it("admits an editor with a valid session, as edit", async () => {
    const r = await connect(DOC, { userId: EDITOR, token: "tok-editor" });
    expect(r.err).toBeUndefined();
    expect(r.data.yjsAccess).toBe("edit");
  });

  it("admits a reader READ-ONLY", async () => {
    const r = await connect(DOC, { userId: READER, token: "tok-reader" });
    expect(r.err).toBeUndefined();
    expect(r.data.yjsAccess).toBe("read");
  });

  it("refuses a FORGED userId (a real session, someone else's id)", async () => {
    const r = await connect(DOC, { userId: EDITOR, token: "tok-stranger" });
    expect(r.err).toBeInstanceOf(Error);
    expect(mocks.resolveAccess).not.toHaveBeenCalled();
  });

  it("refuses a userId with no session token (the old contract)", async () => {
    const r = await connect(DOC, { userId: EDITOR });
    expect(r.err).toBeInstanceOf(Error);
  });

  it("refuses an invalid or inactive session", async () => {
    expect(
      (await connect(DOC, { userId: EDITOR, token: "tok-unknown" })).err
    ).toBeInstanceOf(Error);
    mocks.byToken.mockResolvedValueOnce({
      active: false,
      identity: { id: EDITOR },
    });
    expect(
      (await connect(DOC, { userId: EDITOR, token: "tok-editor" })).err
    ).toBeInstanceOf(Error);
  });

  it("refuses a proven user the document's floor does not admit", async () => {
    const r = await connect(DOC, { userId: STRANGER, token: "tok-stranger" });
    expect(r.err).toBeInstanceOf(Error);
    expect(mocks.resolveAccess).toHaveBeenCalledWith(STRANGER, DOC);
  });

  it("ignores a claimed workspaceId entirely", async () => {
    const r = await connect(DOC, {
      userId: STRANGER,
      token: "tok-stranger",
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(r.err).toBeInstanceOf(Error);
  });

  it("fails CLOSED when Kratos is unreachable", async () => {
    mocks.byToken.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await connect(DOC, { userId: EDITOR, token: "tok-editor" });
    expect(r.err).toBeInstanceOf(Error);
  });

  it("fails CLOSED on a floor (DB) error", async () => {
    mocks.resolveAccess.mockRejectedValueOnce(new Error("connection refused"));
    const r = await connect(DOC, { userId: EDITOR, token: "tok-editor" });
    expect(r.err).toBeInstanceOf(Error);
  });
});

describe("ALLOW_INSECURE_YJS is dev-only", () => {
  it("opts IN outside production: a missing session passes", async () => {
    process.env.ALLOW_INSECURE_YJS = "true";
    const r = await connect(DOC, {});
    expect(r.err).toBeUndefined();
  });

  it("still refuses a positive denial of a proven user", async () => {
    process.env.ALLOW_INSECURE_YJS = "true";
    const r = await connect(DOC, { userId: STRANGER, token: "tok-stranger" });
    expect(r.err).toBeInstanceOf(Error);
  });

  it("is IGNORED in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.ALLOW_INSECURE_YJS = "true";
    expect(insecureYjsAllowed()).toBe(false);
    const r = await connect(DOC, {});
    expect(r.err).toBeInstanceOf(Error);
  });
});

// ─── Read-only rooms, through the real y-socket.io hooks ────────────────────

/** A socket double: records emits, lets the test fire client events. */
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

/** A client-side update that inserts `text` into the shared "t" type. */
function clientUpdate(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText("t").insert(0, text);
  return Y.encodeStateAsUpdate(d);
}

describe("a read socket is served, but its updates are dropped", () => {
  function hooks() {
    const io = new SocketIOServer();
    return setupYjsServer({ io }) as unknown as {
      initSyncListeners: (s: any, d: Y.Doc) => void;
      startSynchronization: (s: any, d: Y.Doc) => void;
    };
  }

  it.each([
    ["edit", "hello"],
    ["read", ""],
  ] as const)(
    "sync-update from a %s socket → doc reads %j",
    (access, expected) => {
      const server = hooks();
      const doc = new Y.Doc();
      const socket = fakeSocket(access);
      server.initSyncListeners(socket, doc);
      socket.handlers.get("sync-update")!(clientUpdate("hello"));
      expect(doc.getText("t").toString()).toBe(expected);
    }
  );

  it.each([
    ["edit", "hello"],
    ["read", ""],
  ] as const)(
    "the answer to sync-step-1 from a %s socket → doc reads %j",
    (access, expected) => {
      const server = hooks();
      // y-socket.io's Document carries an awareness; an empty one suffices.
      const doc = Object.assign(new Y.Doc(), {
        awareness: {
          getStates: () => new Map(),
          states: new Map(),
          meta: new Map(),
        },
      });
      const socket = fakeSocket(access);
      server.startSynchronization(socket, doc);
      const step1 = socket.emits.find(([e]) => e === "sync-step-1")!;
      const ack = step1[2] as (u: Uint8Array) => void;
      ack(clientUpdate("hello"));
      expect(doc.getText("t").toString()).toBe(expected);
    }
  );

  it("a reader is still SERVED the document (sync-step-1 answer)", () => {
    const server = hooks();
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "server text");
    const socket = fakeSocket("read");
    server.initSyncListeners(socket, doc);
    let reply: Uint8Array | undefined;
    socket.handlers.get("sync-step-1")!(
      Y.encodeStateVector(new Y.Doc()),
      (u: Uint8Array) => (reply = u)
    );
    const mirror = new Y.Doc();
    Y.applyUpdate(mirror, reply!);
    expect(mirror.getText("t").toString()).toBe("server text");
  });

  it("tells every socket its access", () => {
    const server = hooks();
    for (const access of ["edit", "read"] as const) {
      const socket = fakeSocket(access);
      server.initSyncListeners(socket, new Y.Doc());
      expect(socket.emits).toContainEqual(["yjs-access", { access }]);
    }
  });

  it("TRIPWIRE: refuses to boot when y-socket.io's hooks are gone", () => {
    expect(() => installReadOnlySync({})).toThrow(/cannot enforce read-only/);
  });
});

// ─── TRIPWIRE: initialize() ─────────────────────────────────────────────────

describe("TRIPWIRE: setupYjsServer must register the /yjs|* namespace", () => {
  it("registers a parent namespace (y-socket.io's initialize() was called)", () => {
    const io = new SocketIOServer();
    expect((io as any).parentNsps.size).toBe(0);
    setupYjsServer({ io });
    expect((io as any).parentNsps.size).toBeGreaterThan(0);
  });

  it("copies BOTH gates into a concrete /yjs|{room} child namespace", async () => {
    const io = new SocketIOServer();
    setupYjsServer({ io });
    const child = await new Promise<any>((resolve) =>
      (io as any)._checkNamespace(`/yjs|whiteboard-${DOC}`, {}, resolve)
    );
    expect(child, "no child namespace for /yjs|{room}").toBeTruthy();
    expect(child.name).toBe(`/yjs|whiteboard-${DOC}`);
    expect(child._fns).toHaveLength(2);
  });
});
