/**
 * W0 — Yjs room authorization tests + the `initialize()` tripwire.
 *
 * Two things are covered here, and they are covered separately on purpose:
 *
 *  1. `authorizeRoomAccess()` — the security floor for every Yjs room. It
 *     derives the owning workspace FROM THE DOCUMENT, so a client can no longer
 *     claim membership of workspace A in the handshake and then open a document
 *     of workspace B. All three resolution branches are exercised.
 *
 *  2. The `initialize()` tripwire. `YSocketIO@1.1.3`'s constructor leaves `nsp`
 *     null — only `initialize()` registers the `/yjs|*` dynamic namespace, the
 *     `authenticate` gate and the `connection` handler. That call was missing
 *     for months and nothing noticed, because nothing asserted it: socket.io
 *     silently answered every `/yjs|{room}` connection with "Invalid namespace"
 *     (`Server._checkNamespace` returns `fn(false)` when `parentNsps` is empty).
 *     The test below asserts the namespace really resolves, not that a line of
 *     source exists.
 *
 * The DB layer is mocked with a small membership table so that "member of a
 * DIFFERENT workspace is denied" is a real assertion and not a tautology.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOC_WS = "11111111-1111-4111-8111-111111111111"; // doc with its own workspace
const DOC_VIEW = "22222222-2222-4222-8222-222222222222"; // doc scoped via its view
const DOC_POD = "33333333-3333-4333-8333-333333333333"; // genuinely pod-wide doc

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const USER_A = "user-a"; // member of WS_A only
const USER_B = "user-b"; // member of WS_B only
const USER_NONE = "user-none"; // member of nothing

const MEMBERSHIPS = [
  { workspaceId: WS_A, userId: USER_A },
  { workspaceId: WS_B, userId: USER_B },
];

// ─── Mock the DB layer ──────────────────────────────────────────────────────
// `eq`/`and` are mocked into inspectable structures so the membership mock can
// read the predicate it was handed and answer like a real table would.

const mocks = vi.hoisted(() => ({
  findDocument: vi.fn(),
  findView: vi.fn(),
  findMembership: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  db: {
    query: {
      documents: { findFirst: mocks.findDocument },
      views: { findFirst: mocks.findView },
      workspaceMembers: { findFirst: mocks.findMembership },
    },
  },
  eq: (col: string, val: unknown) => ({ col, val }),
  and: (...parts: unknown[]) => ({ parts }),
  readDocumentVersionContent: vi.fn(),
  storedVersionValues: vi.fn(() => ({})),
  uploadDocumentVersionSnapshot: vi.fn(),
}));

vi.mock("@synap/database/schema", () => ({
  documents: { id: "documents.id", workspaceId: "documents.workspace_id" },
  documentVersions: { id: "document_versions.id" },
  documentSessions: {
    documentId: "document_sessions.document_id",
    isActive: "document_sessions.is_active",
  },
  views: { documentId: "views.document_id", workspaceId: "views.workspace_id" },
  workspaceMembers: {
    workspaceId: "workspace_members.workspace_id",
    userId: "workspace_members.user_id",
  },
}));

vi.mock("@synap/storage", () => ({ storage: {} }));

import { Server as SocketIOServer } from "socket.io";
import { authorizeRoomAccess, setupYjsServer } from "../yjs-server.js";

/** Read a mocked `eq`/`and` predicate back into { column: value }. */
function readWhere(where: any): Record<string, unknown> {
  const parts = where?.parts ?? [where];
  const out: Record<string, unknown> = {};
  for (const p of parts) if (p?.col) out[p.col] = p.val;
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();

  // Behaves like the workspace_members table: match on whichever of
  // (workspace_id, user_id) the caller actually constrained.
  mocks.findMembership.mockImplementation(async ({ where }: any) => {
    const w = readWhere(where);
    const wsId = w["workspace_members.workspace_id"] as string | undefined;
    const userId = w["workspace_members.user_id"] as string | undefined;
    const row = MEMBERSHIPS.find(
      (m) =>
        (wsId === undefined || m.workspaceId === wsId) &&
        (userId === undefined || m.userId === userId)
    );
    return row ? { id: `${row.workspaceId}:${row.userId}` } : undefined;
  });

  mocks.findDocument.mockImplementation(async ({ where }: any) => {
    const id = readWhere(where)["documents.id"];
    if (id === DOC_WS) return { id: DOC_WS, workspaceId: WS_A };
    if (id === DOC_VIEW) return { id: DOC_VIEW, workspaceId: null };
    if (id === DOC_POD) return { id: DOC_POD, workspaceId: null };
    return undefined;
  });

  mocks.findView.mockImplementation(async ({ where }: any) => {
    const id = readWhere(where)["views.document_id"];
    if (id === DOC_VIEW) return { workspaceId: WS_B };
    if (id === DOC_POD) return { workspaceId: null };
    return undefined;
  });
});

// ────────────────────────────────────────────────────────────────────────────

describe("authorizeRoomAccess — branch 1: document carries its own workspace", () => {
  it("allows a member of the document's workspace", async () => {
    await expect(
      authorizeRoomAccess(`whiteboard-${DOC_WS}`, USER_A)
    ).resolves.toBe(true);
    // The workspace came from the document, so the view is never consulted.
    expect(mocks.findView).not.toHaveBeenCalled();
  });

  it("denies a member of a DIFFERENT workspace (the pod-wide hole this closes)", async () => {
    await expect(
      authorizeRoomAccess(`whiteboard-${DOC_WS}`, USER_B)
    ).resolves.toBe(false);
  });

  it("authorizes against the document's workspace, never a claimed one", async () => {
    await authorizeRoomAccess(`whiteboard-${DOC_WS}`, USER_A);
    const w = readWhere(mocks.findMembership.mock.calls[0][0].where);
    expect(w["workspace_members.workspace_id"]).toBe(WS_A);
  });

  it("works for a bare-UUID document room (TipTap), not just whiteboard-", async () => {
    await expect(authorizeRoomAccess(DOC_WS, USER_A)).resolves.toBe(true);
    await expect(authorizeRoomAccess(DOC_WS, USER_B)).resolves.toBe(false);
  });
});

describe("authorizeRoomAccess — branch 2: workspace resolved via the owning view", () => {
  it("allows a member of the VIEW's workspace when documents.workspace_id is NULL", async () => {
    await expect(
      authorizeRoomAccess(`whiteboard-${DOC_VIEW}`, USER_B)
    ).resolves.toBe(true);
    expect(mocks.findView).toHaveBeenCalledTimes(1);
  });

  it("denies a member of a different workspace than the view's", async () => {
    await expect(
      authorizeRoomAccess(`whiteboard-${DOC_VIEW}`, USER_A)
    ).resolves.toBe(false);
  });
});

describe("authorizeRoomAccess — branch 3: genuinely pod-wide surface", () => {
  it("allows any member of any workspace on this pod", async () => {
    await expect(
      authorizeRoomAccess(`whiteboard-${DOC_POD}`, USER_A)
    ).resolves.toBe(true);
    await expect(
      authorizeRoomAccess(`whiteboard-${DOC_POD}`, USER_B)
    ).resolves.toBe(true);
  });

  it("still denies someone who is a member of nothing", async () => {
    await expect(
      authorizeRoomAccess(`whiteboard-${DOC_POD}`, USER_NONE)
    ).resolves.toBe(false);
  });

  it("constrains the pod-wide lookup on the user, not on a workspace", async () => {
    await authorizeRoomAccess(`whiteboard-${DOC_POD}`, USER_A);
    const w = readWhere(mocks.findMembership.mock.calls[0][0].where);
    expect(w["workspace_members.user_id"]).toBe(USER_A);
    expect(w["workspace_members.workspace_id"]).toBeUndefined();
  });
});

describe("authorizeRoomAccess — rejection cases", () => {
  it.each([
    ["a non-UUID room name", "not-a-uuid"],
    ["a whiteboard- prefix with a non-UUID id", "whiteboard-abc"],
    ["an empty room name", ""],
    ["a UUID-ish string with the wrong shape", "1111-2222-3333"],
  ])("denies %s without touching the database", async (_label, roomName) => {
    await expect(authorizeRoomAccess(roomName, USER_A)).resolves.toBe(false);
    expect(mocks.findDocument).not.toHaveBeenCalled();
  });

  it("denies a well-formed room whose document does not exist", async () => {
    await expect(
      authorizeRoomAccess(
        "whiteboard-99999999-9999-4999-8999-999999999999",
        USER_A
      )
    ).resolves.toBe(false);
  });

  it("propagates a DB error rather than swallowing it into an allow", async () => {
    mocks.findDocument.mockRejectedValueOnce(new Error("connection refused"));
    await expect(
      authorizeRoomAccess(`whiteboard-${DOC_WS}`, USER_A)
    ).rejects.toThrow("connection refused");
  });
});

// ─── The room gate middleware (fail-closed + the escape hatch) ───────────────

type NextResult = Error | undefined;

/** Pull the room-gate middleware off the parent namespace `setupYjsServer` built. */
function roomGateOf(io: SocketIOServer, server: unknown) {
  const nsp = (server as any).nsp;
  expect(nsp, "yServer.nsp is null — initialize() was not called").toBeTruthy();
  const fns = nsp._fns as Array<(socket: any, next: any) => void>;
  // [0] is y-socket.io's own `authenticate` wrapper, [1] is our room gate.
  expect(fns).toHaveLength(2);
  return fns[1];
}

function runGate(
  gate: (socket: any, next: any) => void,
  roomName: string,
  auth: Record<string, unknown>
): Promise<NextResult> {
  return new Promise((resolve) => {
    gate(
      { nsp: { name: `/yjs|${roomName}` }, handshake: { auth } },
      (err?: Error) => resolve(err)
    );
  });
}

describe("room gate middleware", () => {
  let io: SocketIOServer;

  // No io.close(): these Servers are never attached to an http server, and
  // socket.io 4.8.3's close() dereferences the (absent) httpServer.
  afterEach(() => {
    delete process.env.ALLOW_INSECURE_YJS;
  });

  it("lets an authorized member through", async () => {
    io = new SocketIOServer();
    const gate = roomGateOf(io, setupYjsServer({ io }));
    await expect(
      runGate(gate, `whiteboard-${DOC_WS}`, { userId: USER_A })
    ).resolves.toBeUndefined();
  });

  it("rejects a member of another workspace", async () => {
    io = new SocketIOServer();
    const gate = roomGateOf(io, setupYjsServer({ io }));
    await expect(
      runGate(gate, `whiteboard-${DOC_WS}`, { userId: USER_B })
    ).resolves.toBeInstanceOf(Error);
  });

  it("rejects a handshake with no userId", async () => {
    io = new SocketIOServer();
    const gate = roomGateOf(io, setupYjsServer({ io }));
    await expect(
      runGate(gate, `whiteboard-${DOC_WS}`, {})
    ).resolves.toBeInstanceOf(Error);
  });

  it("fails CLOSED on a DB error", async () => {
    mocks.findDocument.mockRejectedValueOnce(new Error("connection refused"));
    io = new SocketIOServer();
    const gate = roomGateOf(io, setupYjsServer({ io }));
    await expect(
      runGate(gate, `whiteboard-${DOC_WS}`, { userId: USER_A })
    ).resolves.toBeInstanceOf(Error);
  });

  it("ALLOW_INSECURE_YJS=true opts IN to the old permissive behaviour", async () => {
    process.env.ALLOW_INSECURE_YJS = "true";
    mocks.findDocument.mockRejectedValueOnce(new Error("connection refused"));
    io = new SocketIOServer();
    const gate = roomGateOf(io, setupYjsServer({ io }));
    // DB error and a missing userId both pass only under the explicit opt-in.
    await expect(
      runGate(gate, `whiteboard-${DOC_WS}`, { userId: USER_A })
    ).resolves.toBeUndefined();
    await expect(
      runGate(gate, `whiteboard-${DOC_WS}`, {})
    ).resolves.toBeUndefined();
  });

  it("still denies a cross-workspace room even under ALLOW_INSECURE_YJS", async () => {
    // The escape hatch covers *missing/unavailable* auth, not a positive denial.
    process.env.ALLOW_INSECURE_YJS = "true";
    io = new SocketIOServer();
    const gate = roomGateOf(io, setupYjsServer({ io }));
    await expect(
      runGate(gate, `whiteboard-${DOC_WS}`, { userId: USER_B })
    ).resolves.toBeInstanceOf(Error);
  });
});

// ─── TRIPWIRE ───────────────────────────────────────────────────────────────

describe("TRIPWIRE: setupYjsServer must register the /yjs|* namespace", () => {
  let io: SocketIOServer;

  it("registers a parent namespace (y-socket.io's initialize() was called)", () => {
    io = new SocketIOServer();
    expect((io as any).parentNsps.size).toBe(0);

    setupYjsServer({ io });

    // Without initialize(), parentNsps stays empty and socket.io answers every
    // /yjs|{room} connection with "Invalid namespace" — silently, forever.
    expect((io as any).parentNsps.size).toBeGreaterThan(0);
  });

  it("resolves a concrete /yjs|{room} child namespace", async () => {
    io = new SocketIOServer();
    setupYjsServer({ io });

    const resolved = await new Promise<any>((resolve) =>
      (io as any)._checkNamespace(
        `/yjs|whiteboard-${DOC_WS}`,
        {},
        (nspOrFalse: any) => resolve(nspOrFalse)
      )
    );

    expect(resolved, "no child namespace for /yjs|{room}").toBeTruthy();
    expect(resolved.name).toBe(`/yjs|whiteboard-${DOC_WS}`);
  });

  it("copies BOTH gates into the child namespace", async () => {
    io = new SocketIOServer();
    setupYjsServer({ io });

    const child = await new Promise<any>((resolve) =>
      (io as any)._checkNamespace(`/yjs|whiteboard-${DOC_WS}`, {}, resolve)
    );

    // ParentNamespace.createChild copies the parent's _fns — if the room gate
    // were registered before initialize(), or on a second parent namespace,
    // this would be 1 (authenticate only) instead of 2.
    expect(child._fns).toHaveLength(2);
  });
});
