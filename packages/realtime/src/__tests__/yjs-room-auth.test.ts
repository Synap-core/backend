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
 *
 *  5. ROOM TICKETS (0432) — a pod app's `synap_rt_…` ticket opens ONE room
 *     ONCE: another document, expired, reused, or another person's are
 *     refused; a read ticket never writes (driven through the real hooks);
 *     the socket gets the lesser of ticket and floor and ends with the app's
 *     connection; `/presence` never takes a ticket. The ticket store is a
 *     table here with the store's rules (claim: this document, unclaimed,
 *     unexpired); the store itself runs on PGlite in
 *     `packages/database/src/realtime-room-tickets.pglite.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOC = "11111111-1111-4111-8111-111111111111";
const DOC_POD = "33333333-3333-4333-8333-333333333333"; // no workspace
const BOARD = "44444444-4444-4444-8444-444444444444"; // a canvas document
const MINDMAP = "55555555-5555-4555-8555-555555555555"; // a canvas document

/** `documents.type`, as a table: documentId → type. */
const DOC_TYPES: Record<string, string> = {
  [DOC]: "markdown",
  [DOC_POD]: "markdown",
  [BOARD]: "whiteboard",
  [MINDMAP]: "mindmap",
};

const EDITOR = "user-editor";
const READER = "user-reader";
const STRANGER = "user-stranger"; // e.g. a member of some OTHER workspace

/** The api floor, as a table: [user][doc] → access. */
const FLOOR: Record<string, Record<string, "edit" | "read">> = {
  [EDITOR]: {
    [DOC]: "edit",
    [DOC_POD]: "edit",
    [BOARD]: "edit",
    [MINDMAP]: "edit",
  },
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
  findDocument: vi.fn(),
  tickets: new Map<
    string,
    {
      userId: string;
      documentId: string;
      access: "read" | "edit";
      apiKeyId: string;
      expiresAt: number;
      consumed: boolean;
    }
  >(),
}));

vi.mock("@synap/api/document-access", () => ({
  resolveDocumentRoomAccess: mocks.resolveAccess,
}));

vi.mock("@synap/auth", () => ({
  getKratosSessionByToken: mocks.byToken,
  getKratosSessionByCookie: mocks.byCookie,
}));

vi.mock("@synap/database", () => ({
  db: { query: { documents: { findFirst: mocks.findDocument } } },
  eq: (_column: unknown, value: unknown) => ({ value }),
  and: vi.fn(),
  claimDocumentRevision: vi.fn(),
  INHERIT_LAST_AUTHOR: Symbol("inherit"),
}));

vi.mock("@synap/database/schema", () => ({
  documents: { id: "documents.id" },
  documentSessions: {},
}));

vi.mock("@synap/storage", () => ({ storage: {} }));

/** A Synap app's device token, resolved by the one lookup. */
const DEVICE_TOKEN = `synap_pd_${"d".repeat(43)}`;
vi.mock("@synap/database/person-devices", () => ({
  isPersonDeviceToken: (raw: unknown) =>
    typeof raw === "string" && raw.startsWith("synap_pd_"),
  resolvePersonDeviceSession: async (_db: unknown, raw: string) =>
    raw === DEVICE_TOKEN
      ? {
          identity: { id: EDITOR, traits: { email: "e@x" } },
          active: true,
          device: {
            id: "device-editor",
            clientId: "synap-desktop",
            authTime: null,
          },
        }
      : null,
  liveDeviceIds: async () => new Set<string>(),
}));

/** The ticket store, as a table with its rules (see header, item 5). */
vi.mock("@synap/database/realtime-room-tickets", () => {
  const live = (raw: string) => {
    const t = mocks.tickets.get(raw);
    return t && !t.consumed && t.expiresAt > Date.now() ? t : null;
  };
  return {
    isRoomTicket: (raw: unknown) =>
      typeof raw === "string" &&
      raw.startsWith("synap_rt_") &&
      raw.length > "synap_rt_".length,
    peekRoomTicket: async (_db: unknown, raw: string) => {
      const t = live(raw);
      return t
        ? { userId: t.userId, documentId: t.documentId, access: t.access }
        : null;
    },
    claimRoomTicket: async (_db: unknown, raw: string, documentId: string) => {
      const t = live(raw);
      if (!t || t.documentId !== documentId) return null;
      t.consumed = true;
      return { userId: t.userId, access: t.access, apiKeyId: t.apiKeyId };
    },
    liveTicketConnections: async () => new Set<string>(),
  };
});

import { Server as SocketIOServer } from "socket.io";
import {
  authorizeRoomAccess,
  insecureYjsAllowed,
  installReadOnlySync,
  roomFitsDocumentType,
  setupYjsServer,
} from "../yjs-server.js";
import { declaredEditorSchema } from "../document-room.js";
import { sweepDeviceSockets, trackedDeviceIds } from "../device-sockets.js";
import {
  sweepTicketSockets,
  trackedTicketConnections,
} from "../ticket-sockets.js";
import { verifyHandshakeUser } from "../session-auth.js";

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
  mocks.findDocument.mockImplementation(
    async ({ where }: { where: { value: string } }) =>
      DOC_TYPES[where.value] ? { type: DOC_TYPES[where.value] } : undefined
  );
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

  it("a whiteboard- room opens only a canvas document, a bare room only a non-canvas one", async () => {
    await expect(
      authorizeRoomAccess(`whiteboard-${BOARD}`, EDITOR)
    ).resolves.toBe("edit");
    await expect(
      authorizeRoomAccess(`whiteboard-${MINDMAP}`, EDITOR)
    ).resolves.toBe("edit");
    // The finding: a whiteboard room on a markdown document would persist a
    // Tldraw store over its body. Refused even for the document's editor.
    await expect(
      authorizeRoomAccess(`whiteboard-${DOC}`, EDITOR)
    ).resolves.toBe("none");
    // The reverse: a markdown room on a canvas document would write markdown back over it.
    await expect(authorizeRoomAccess(BOARD, EDITOR)).resolves.toBe("none");
  });

  it("asks the document's type only after the floor admitted the user", async () => {
    await expect(
      authorizeRoomAccess(`whiteboard-${BOARD}`, STRANGER)
    ).resolves.toBe("none");
    expect(mocks.findDocument).not.toHaveBeenCalled();
  });

  it("a document that vanished after the floor answered is refused, not opened", async () => {
    mocks.findDocument.mockResolvedValueOnce(undefined);
    await expect(authorizeRoomAccess(DOC, EDITOR)).resolves.toBe("none");
  });

  it.each([
    ["whiteboard-", "whiteboard", true],
    ["whiteboard-", "mindmap", true],
    ["whiteboard-", "markdown", false],
    ["whiteboard-", "text", false],
    ["", "markdown", true],
    ["", "code", true],
    ["", "whiteboard", false],
    ["", "mindmap", false],
  ])("roomFitsDocumentType(%s<id>, %s) = %s", (prefix, type, fits) => {
    expect(roomFitsDocumentType(`${prefix}${DOC}`, type)).toBe(fits);
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

let lastSocket: { disconnect: ReturnType<typeof vi.fn> } | null = null;

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
    once: vi.fn(),
    disconnect: vi.fn(),
  };
  lastSocket = socket;
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

  it("admits the editor of a board to its whiteboard room, refuses its markdown sibling", async () => {
    const board = await connect(`whiteboard-${BOARD}`, {
      userId: EDITOR,
      token: "tok-editor",
    });
    expect(board.err).toBeUndefined();
    expect(board.data.yjsAccess).toBe("edit");
    const mismatched = await connect(`whiteboard-${DOC}`, {
      userId: EDITOR,
      token: "tok-editor",
    });
    expect(mismatched.err).toBeInstanceOf(Error);
    expect(mismatched.data.yjsAccess).toBeUndefined();
  });

  it("admits a reader READ-ONLY", async () => {
    const r = await connect(DOC, { userId: READER, token: "tok-reader" });
    expect(r.err).toBeUndefined();
    expect(r.data.yjsAccess).toBe("read");
  });

  it("a socket admitted on a device token closes when its device ends", async () => {
    const r = await connect(DOC, { userId: EDITOR, token: DEVICE_TOKEN });
    expect(r.err).toBeUndefined();
    expect(trackedDeviceIds()).toContain("device-editor");
    const socket = lastSocket!;
    await sweepDeviceSockets(async () => new Set());
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("CONTROL — a socket admitted on a Kratos session is not tracked", async () => {
    await sweepDeviceSockets(async () => new Set());
    const r = await connect(DOC, { userId: EDITOR, token: "tok-editor" });
    expect(r.err).toBeUndefined();
    expect(trackedDeviceIds()).toEqual([]);
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

// ─── Room tickets (0432) ─────────────────────────────────────────────────────

let ticketSeq = 0;
/** A ticket in the store; returns the raw ticket. */
function ticket(
  over: Partial<{
    userId: string;
    documentId: string;
    access: "read" | "edit";
    apiKeyId: string;
    expiresAt: number;
  }> = {}
): string {
  const raw = `synap_rt_${String(++ticketSeq).padStart(43, "t")}`;
  mocks.tickets.set(raw, {
    userId: EDITOR,
    documentId: DOC,
    access: "edit",
    apiKeyId: "key-app-1",
    expiresAt: Date.now() + 60_000,
    consumed: false,
    ...over,
  });
  return raw;
}

describe("a pod app's room ticket opens one room, once", () => {
  it("an edit ticket of an editor opens its document's room as edit", async () => {
    const r = await connect(DOC, { userId: EDITOR, token: ticket() });
    expect(r.err).toBeUndefined();
    expect(r.data.yjsAccess).toBe("edit");
    // Never sent to Kratos.
    expect(mocks.byToken).not.toHaveBeenCalled();
  });

  it("opens a board's whiteboard room too", async () => {
    const r = await connect(`whiteboard-${BOARD}`, {
      userId: EDITOR,
      token: ticket({ documentId: BOARD }),
    });
    expect(r.err).toBeUndefined();
    expect(r.data.yjsAccess).toBe("edit");
  });

  it("refuses a ticket made for ANOTHER document", async () => {
    const r = await connect(DOC, {
      userId: EDITOR,
      token: ticket({ documentId: DOC_POD }),
    });
    expect(r.err).toBeInstanceOf(Error);
    expect(r.data.yjsAccess).toBeUndefined();
  });

  it("refuses an EXPIRED ticket", async () => {
    const r = await connect(DOC, {
      userId: EDITOR,
      token: ticket({ expiresAt: Date.now() - 1 }),
    });
    expect(r.err).toBeInstanceOf(Error);
  });

  it("refuses a REUSED ticket", async () => {
    const raw = ticket();
    expect((await connect(DOC, { userId: EDITOR, token: raw })).err).toBe(
      undefined
    );
    const again = await connect(DOC, { userId: EDITOR, token: raw });
    expect(again.err).toBeInstanceOf(Error);
    expect(again.data.yjsAccess).toBeUndefined();
  });

  it("refuses a ticket presented under another person's id", async () => {
    const r = await connect(DOC, {
      userId: READER,
      token: ticket({ userId: EDITOR }),
    });
    expect(r.err).toBeInstanceOf(Error);
  });

  it("a READ ticket never writes, even for the document's editor", async () => {
    const r = await connect(DOC, {
      userId: EDITOR,
      token: ticket({ access: "read" }),
    });
    expect(r.err).toBeUndefined();
    expect(r.data.yjsAccess).toBe("read");
    // The access the gate set, through the real y-socket.io hooks.
    const server = setupYjsServer({
      io: new SocketIOServer(),
    }) as unknown as { initSyncListeners: (s: any, d: Y.Doc) => void };
    const doc = new Y.Doc();
    const socket = fakeSocket(r.data.yjsAccess as "read");
    server.initSyncListeners(socket, doc);
    socket.handlers.get("sync-update")!(clientUpdate("hello"));
    expect(doc.getText("t").toString()).toBe("");
    expect(socket.emits).toContainEqual(["yjs-access", { access: "read" }]);
  });

  it("an edit ticket of a person whose floor is read is read-only", async () => {
    const r = await connect(DOC, {
      userId: READER,
      token: ticket({ userId: READER }),
    });
    expect(r.err).toBeUndefined();
    expect(r.data.yjsAccess).toBe("read");
  });

  it("refuses a ticket of a person the floor no longer admits", async () => {
    const r = await connect(DOC, {
      userId: STRANGER,
      token: ticket({ userId: STRANGER }),
    });
    expect(r.err).toBeInstanceOf(Error);
  });

  it("a ticket socket closes when the app's connection ends", async () => {
    await sweepTicketSockets(async () => new Set());
    const r = await connect(DOC, {
      userId: EDITOR,
      token: ticket({ apiKeyId: "key-app-2" }),
    });
    expect(r.err).toBeUndefined();
    expect(trackedTicketConnections()).toContain("key-app-2");
    const socket = lastSocket!;
    await sweepTicketSockets(async () => new Set(["key-app-other"]));
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(trackedTicketConnections()).not.toContain("key-app-2");
  });

  it("CONTROL — a ticket socket of a standing connection stays open", async () => {
    await sweepTicketSockets(async () => new Set());
    await connect(DOC, {
      userId: EDITOR,
      token: ticket({ apiKeyId: "key-app-3" }),
    });
    const socket = lastSocket!;
    await sweepTicketSockets(async () => new Set(["key-app-3"]));
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("/presence never takes a ticket (the default handshake check)", async () => {
    const r = await verifyHandshakeUser({ userId: EDITOR, token: ticket() });
    expect(r.ok).toBe(false);
    expect(mocks.byToken).not.toHaveBeenCalled();
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

// ─── The editor schema stamp (columns.md R1) ────────────────────────────────

describe("an editor the room has outgrown is served read-only", () => {
  function hooks() {
    const io = new SocketIOServer();
    return setupYjsServer({ io }) as unknown as {
      initSyncListeners: (s: any, d: Y.Doc) => void;
      startSynchronization: (s: any, d: Y.Doc) => void;
    };
  }
  /** An edit socket that declared `editorSchema` at the room gate. */
  function editor(schema?: number) {
    const socket = fakeSocket("edit");
    if (schema !== undefined) (socket.data as any).editorSchema = schema;
    return socket;
  }
  function stamped(version: number | null): Y.Doc {
    const doc = new Y.Doc();
    if (version !== null)
      doc.getMap("synap-room").set("schemaVersion", version);
    return doc;
  }

  it("the handshake's editorSchema is read strictly; none = 1 (every build before the stamp)", () => {
    expect(declaredEditorSchema({ editorSchema: 2 })).toBe(2);
    expect(declaredEditorSchema({})).toBe(1);
    expect(declaredEditorSchema({ editorSchema: "3" })).toBe(1);
    expect(declaredEditorSchema({ editorSchema: 0 })).toBe(1);
    expect(declaredEditorSchema(undefined)).toBe(1);
  });

  it.each([
    [
      "no stamp, no declared schema",
      null,
      undefined,
      "hello",
      { access: "edit" },
    ],
    ["stamp 2, editor 2", 2, 2, "hello", { access: "edit" }],
    ["stamp 2, editor 3 (newer)", 2, 3, "hello", { access: "edit" }],
    [
      "stamp 2, editor 1",
      2,
      1,
      "",
      { access: "read", reason: "editor-outdated" },
    ],
    [
      "stamp 2, a build that declares none",
      2,
      undefined,
      "",
      { access: "read", reason: "editor-outdated" },
    ],
  ] as const)("%s", (_label, stamp, schema, expected, told) => {
    const server = hooks();
    const doc = stamped(stamp);
    const socket = editor(schema);
    server.initSyncListeners(socket, doc);
    expect(socket.emits).toContainEqual(["yjs-access", told]);
    socket.handlers.get("sync-update")!(clientUpdate("hello"));
    expect(doc.getText("t").toString()).toBe(expected);
  });

  it("the stamp rising MID-SESSION drops the old editor's next update, and tells it once", () => {
    const server = hooks();
    const doc = stamped(null);
    const socket = editor(1);
    server.initSyncListeners(socket, doc);
    socket.handlers.get("sync-update")!(clientUpdate("before "));
    expect(doc.getText("t").toString()).toBe("before ");
    // A newer editor joins and stamps the room (its update, applied as any other).
    doc.getMap("synap-room").set("schemaVersion", 2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    socket.handlers.get("sync-update")!(clientUpdate("after"));
    socket.handlers.get("sync-update")!(clientUpdate("again"));
    warn.mockRestore();
    expect(doc.getText("t").toString()).toBe("before ");
    const told = socket.emits.filter(
      ([e, p]) => e === "yjs-access" && p?.reason === "editor-outdated"
    );
    expect(told).toHaveLength(1);
  });

  it("an outgrown editor's sync-step-1 answer (its local state) is dropped; a current editor's is applied", () => {
    for (const [schema, expected] of [
      [1, ""],
      [2, "hello"],
    ] as const) {
      const server = hooks();
      const doc = Object.assign(stamped(2), {
        awareness: {
          getStates: () => new Map(),
          states: new Map(),
          meta: new Map(),
        },
      });
      const socket = editor(schema);
      server.startSynchronization(socket, doc);
      const step1 = socket.emits.find(([e]) => e === "sync-step-1")!;
      (step1[2] as (u: Uint8Array) => void)(clientUpdate("hello"));
      expect(doc.getText("t").toString(), `schema ${schema}`).toBe(expected);
    }
  });

  it("the room gate records the declared schema on the socket", async () => {
    const io = new SocketIOServer();
    setupYjsServer({ io });
    const child = await new Promise<any>((resolve) =>
      (io as any)._checkNamespace(`/yjs|${DOC}`, {}, resolve)
    );
    const gate = child._fns[1] as Gate;
    const socket: any = {
      nsp: { name: `/yjs|${DOC}` },
      handshake: { auth: { editorSchema: 2 } },
      data: {},
    };
    await new Promise<void>((resolve) => gate(socket, () => resolve()));
    expect(socket.data.editorSchema).toBe(2);
  });
});
