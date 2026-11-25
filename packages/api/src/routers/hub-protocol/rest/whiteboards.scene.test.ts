/**
 * The board READ door: Hub `GET /whiteboards/:viewId/scene` and MCP
 * `synap_read_board`, both through the ONE function `readBoardScene`.
 *
 * Driven through the real route and the real reader; only the I/O seams are
 * mocked: the view and document rows (`db.query`), the room floor
 * (`resolveDocumentRoomAccess`), object storage, and the realtime bridge
 * (`fetch`, answering with a REAL encoded Y.Doc). So a test sees what the
 * door decides: who reads, which source answers, and that a failed read is an
 * error with a reason, never an empty board.
 *
 * Cannot see: a real open room on a running realtime server, and the stored
 * file of a real board (NEEDS-DOGFOOD on a pod).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { ROOM_META_KEYS, ROOM_META_MAP } from "@synap/events/realtime-schemas";

const USER = "0aaaaaaa-0000-4000-8000-000000000001";
const VIEW = "1b1b1b1b-0000-4000-8000-0000000000aa";
const DOC = "2c2c2c2c-0000-4000-8000-0000000000bb";
const WS = "3d3d3d3d-0000-4000-8000-0000000000cc";
const OTHER_WS = "4e4e4e4e-0000-4000-8000-0000000000dd";
const SAVED_AT = new Date("2026-11-10T09:00:00.000Z");

const RECORDS = {
  "page:page": { typeName: "page", id: "page:page", name: "Page 1" },
  "shape:s": {
    typeName: "shape",
    id: "shape:s",
    type: "sticky",
    parentId: "page:page",
    x: 10,
    y: 20,
    rotation: 0,
    props: { w: 240, h: 200, content: "Call Bob", color: "yellow" },
    meta: {},
  },
};

const m = vi.hoisted(() => ({
  view: null as Record<string, unknown> | null,
  doc: null as Record<string, unknown> | null,
  access: "edit" as "edit" | "read" | "none",
  accessCalls: [] as Array<[string, string]>,
  viewVisible: true,
  storageBody: null as string | null,
  storageError: null as Error | null,
  storageCalls: [] as string[],
  fetchImpl: null as null | ((url: string) => Promise<Response>),
  fetchCalls: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        views: { findFirst: async () => m.view },
        documents: { findFirst: async () => m.doc },
      },
    },
  };
});
vi.mock("@synap/storage", () => ({
  storage: {
    downloadBuffer: async (key: string) => {
      m.storageCalls.push(key);
      if (m.storageError) throw m.storageError;
      return Buffer.from(m.storageBody ?? "", "utf-8");
    },
  },
}));
vi.mock("../../../utils/document-edit-access.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/document-edit-access.js")
  >()),
  resolveDocumentRoomAccess: async (userId: string, documentId: string) => {
    m.accessCalls.push([userId, documentId]);
    return m.access;
  },
}));
vi.mock("../../views.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../views.js")>()),
  assertViewAccess: async () => {
    if (!m.viewVisible) throw new Error("FORBIDDEN");
  },
}));

vi.stubGlobal("fetch", async (url: string) => {
  m.fetchCalls.push(String(url));
  if (!m.fetchImpl) throw new Error("fetch not set");
  return m.fetchImpl(String(url));
});

const { registerWhiteboardsRoutes } = await import("./whiteboards.js");
const { readHandlers } = await import("../../mcp/handlers/read.js");
const { restDoorAllowed, mcpToolAllowed } =
  await import("../../../access/grant-door-fence.js");

/** The bridge's answer for an open room: a real encoded Y.Doc. */
function liveRoom(records: Record<string, unknown>) {
  const doc = new Y.Doc();
  const map = doc.getMap(`tl_map_${DOC}`);
  for (const [k, v] of Object.entries(records)) map.set(k, v);
  const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  return async () =>
    new Response(JSON.stringify({ roomId: `whiteboard-${DOC}`, state }), {
      status: 200,
    });
}
/** The bridge's own closed-room answer (`handleYjsGetState`: `{ error, roomId }`). */
const roomClosed = async () =>
  new Response(
    JSON.stringify({
      error: "Room not active — load from database instead",
      roomId: `whiteboard-${DOC}`,
    }),
    { status: 404 }
  );

function app(vars: Record<string, unknown> = {}) {
  const a = new OpenAPIHono();
  a.use("*", async (c, next) => {
    const all: Record<string, unknown> = {
      userId: USER,
      scopes: ["hub-protocol.read"],
      keyType: "user_pat",
      keyWorkspaceId: null,
      ...vars,
    };
    for (const [k, v] of Object.entries(all)) c.set(k as never, v as never);
    await next();
  });
  registerWhiteboardsRoutes(a as never);
  return a;
}
const get = (vars?: Record<string, unknown>, id = VIEW) =>
  app(vars).request(`/whiteboards/${id}/scene`);

beforeEach(() => {
  m.view = {
    id: VIEW,
    type: "whiteboard",
    name: "Planning",
    workspaceId: WS,
    userId: USER,
    documentId: DOC,
    yjsRoomId: `whiteboard-${DOC}`,
  };
  m.doc = {
    storageKey: `whiteboards/${USER}/${DOC}.json`,
    updatedAt: SAVED_AT,
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
  };
  m.access = "edit";
  m.accessCalls = [];
  m.viewVisible = true;
  m.storageBody = JSON.stringify({ store: RECORDS });
  m.storageError = null;
  m.storageCalls = [];
  m.fetchImpl = roomClosed;
  m.fetchCalls = [];
});

describe("GET /whiteboards/:viewId/scene: which source answers", () => {
  it("an open room answers from its live Y.Doc; storage is not read", async () => {
    m.fetchImpl = liveRoom(RECORDS);
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({
      viewId: VIEW,
      documentId: DOC,
      workspaceId: WS,
      title: "Planning",
      source: "live",
      access: "edit",
    });
    expect(body.scene.shapes).toEqual([
      expect.objectContaining({
        id: "shape:s",
        type: "sticky",
        x: 10,
        y: 20,
        text: "Call Bob",
      }),
    ]);
    expect(m.fetchCalls).toEqual([
      `http://localhost:4001/yjs/${encodeURIComponent(`whiteboard-${DOC}`)}/state`,
    ]);
    expect(m.storageCalls).toEqual([]);
  });

  it("a closed room (bridge 404) answers from the stored file, as of its last save", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.source).toBe("stored");
    expect(body.asOf).toBe(SAVED_AT.toISOString());
    expect(body.legacyFormat).toBeUndefined();
    expect(body.scene.counts).toMatchObject({ shapes: 1, records: 2 });
    expect(m.storageCalls).toEqual([`whiteboards/${USER}/${DOC}.json`]);
  });

  it("a stored body in the legacy `yjs:` form is decoded and marked", async () => {
    const doc = new Y.Doc();
    const map = doc.getMap(`tl_map_${DOC}`);
    map.set("shape:s", RECORDS["shape:s"]);
    m.storageBody = `yjs:${Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")}`;
    const body = (await (await get()).json()) as Record<string, any>;
    expect(body.legacyFormat).toBe(true);
    expect(body.scene.shapes.map((s: { id: string }) => s.id)).toEqual([
      "shape:s",
    ]);
  });

  it("frameId / offset / limit reach the reader; a bad limit is a 400", async () => {
    const res = await app().request(
      `/whiteboards/${VIEW}/scene?offset=0&limit=1&frameId=shape:s`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.scene.window).toEqual({
      frameId: "shape:s",
      offset: 0,
      matched: 1,
      nextOffset: null,
    });
    expect(
      (await app().request(`/whiteboards/${VIEW}/scene?limit=0`)).status
    ).toBe(400);
  });

  it("a board never saved (no storageKey) is empty by fact: source `new`", async () => {
    m.doc = { ...m.doc, storageKey: null };
    const body = (await (await get()).json()) as Record<string, any>;
    expect(body.source).toBe("new");
    expect(body.scene.counts.shapes).toBe(0);
    expect(m.storageCalls).toEqual([]);
  });
});

describe("GET /whiteboards/:viewId/scene: a failed read is an error, never an empty board", () => {
  /** The bridge's answer for an open room, with optional extra reply fields. */
  const openRoom = (
    records: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    meta?: Record<string, unknown>
  ) => {
    const doc = new Y.Doc();
    for (const [k, v] of Object.entries(records))
      doc.getMap(`tl_map_${DOC}`).set(k, v);
    for (const [k, v] of Object.entries(meta ?? {}))
      doc.getMap(ROOM_META_MAP).set(k, v);
    const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
    return async () =>
      new Response(
        JSON.stringify({ roomId: `whiteboard-${DOC}`, state, ...extra }),
        { status: 200 }
      );
  };

  it("an open room the realtime server FLAGGED load-failed → 502 live_unreadable with its message", async () => {
    // Even with records in it: the server's flag says the map is not the board.
    m.fetchImpl = openRoom(RECORDS, {
      loadFailed: true,
      loadError: "The board's saved content could not be loaded.",
    });
    const res = await get();
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, string>;
    expect(body.reason).toBe("live_unreadable");
    expect(body.error).toContain(
      "The board's saved content could not be loaded."
    );
  });

  it("a `synap-room.loadError` KEY inside a healthy room (a client's stale copy) is not a failure", async () => {
    m.fetchImpl = openRoom(
      RECORDS,
      {},
      {
        [ROOM_META_KEYS.loadError]: "stale mark from another day",
      }
    );
    const res = await get();
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as Record<string, any>).scene.counts.shapes
    ).toBe(1);
  });

  it("a stored key that names no object (S3 NoSuchKey) is a board never saved: `new`, empty", async () => {
    m.storageError = Object.assign(
      new Error("The specified key does not exist."),
      {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      }
    );
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      source: "new",
      scene: { counts: { shapes: 0 } },
    });
  });

  it("an open room that is EMPTY while the saved file is not → 502 live_unreadable, never an empty live board", async () => {
    m.fetchImpl = liveRoom({});
    const res = await get();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: "live_unreadable" });
    expect(m.storageCalls).toEqual([`whiteboards/${USER}/${DOC}.json`]);
  });

  it("an empty open room with no saved file, or an empty saved file, is a genuine empty board", async () => {
    m.fetchImpl = liveRoom({});
    m.doc = { ...m.doc, storageKey: null };
    let res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      source: "live",
      scene: { counts: { shapes: 0, records: 0 } },
    });
    m.doc = { ...m.doc, storageKey: `whiteboards/${USER}/${DOC}.json` };
    m.storageBody = JSON.stringify({ store: {} });
    res = await get();
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, any>).source).toBe("live");
  });

  it("a non-empty open room never pays the extra storage read", async () => {
    m.fetchImpl = liveRoom(RECORDS);
    expect((await get()).status).toBe(200);
    expect(m.storageCalls).toEqual([]);
  });

  it("a 404 that is not the bridge's closed-room answer → 503 live_unavailable, stored file not read", async () => {
    m.fetchImpl = async () => new Response("Not Found", { status: 404 });
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "live_unavailable" });
    expect(m.storageCalls).toEqual([]);
  });

  it("bridge unreachable → 503 live_unavailable, and the stale stored file is NOT served", async () => {
    m.fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "live_unavailable" });
    expect(m.storageCalls).toEqual([]);
  });

  it("bridge refuses (401/503) → 503 live_unavailable", async () => {
    m.fetchImpl = async () => new Response("{}", { status: 401 });
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "live_unavailable" });
  });

  it("room state that cannot be decoded → 502 live_unreadable", async () => {
    m.fetchImpl = async () =>
      new Response(JSON.stringify({ nope: 1 }), { status: 200 });
    const res = await get();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: "live_unreadable" });
  });

  it("storage down → 503 stored_unavailable", async () => {
    m.storageError = new Error("ECONNREFUSED");
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "stored_unavailable" });
  });

  it("a stored file that is not a board → 502 stored_unreadable", async () => {
    m.storageBody = "<html>";
    const res = await get();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: "stored_unreadable" });
  });
});

describe("GET /whiteboards/:viewId/scene: who may read", () => {
  it("the floor is the room's own predicate, asked for the caller and the board's document", async () => {
    m.access = "read";
    const body = (await (await get()).json()) as Record<string, any>;
    expect(m.accessCalls).toEqual([[USER, DOC]]);
    expect(body.access).toBe("read");
  });

  it("a caller the room would refuse gets 404, and nothing is read", async () => {
    m.access = "none";
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ reason: "not_found" });
    expect(m.fetchCalls).toEqual([]);
    expect(m.storageCalls).toEqual([]);
  });

  it("no such view → 404", async () => {
    m.view = null;
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ reason: "not_found" });
  });

  it("a key bound to another space → 404 before the floor is asked", async () => {
    const res = await get({ keyWorkspaceId: OTHER_WS });
    expect(res.status).toBe(404);
    expect(m.accessCalls).toEqual([]);
    expect((await get({ keyWorkspaceId: WS })).status).toBe(200);
  });

  it("missing hub-protocol.read → 403; a malformed id → 400", async () => {
    expect((await get({ scopes: ["hub-protocol.write"] })).status).toBe(403);
    expect((await get({}, "not-a-uuid")).status).toBe(400);
    expect(m.accessCalls).toEqual([]);
  });

  it("a view of another type the caller may not see → 404, not 400 (no type oracle)", async () => {
    m.view = { ...m.view, type: "kanban" };
    m.access = "none";
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ reason: "not_found" });
  });

  it("a visible view of another type → 400 not_a_board", async () => {
    m.view = { ...m.view, type: "kanban" };
    const res = await get();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "not_a_board" });
  });

  it("a whiteboard with no document: 409 to someone who sees it, 404 to someone who does not", async () => {
    m.view = { ...m.view, documentId: null };
    const seen = await get();
    expect(seen.status).toBe(409);
    expect(await seen.json()).toMatchObject({ reason: "not_initialized" });
    m.viewVisible = false;
    expect((await get()).status).toBe(404);
  });
});

describe("MCP synap_read_board: the same reader", () => {
  const call = (
    args: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) =>
    readHandlers.synap_read_board!({
      toolName: "synap_read_board",
      args,
      userId: USER,
      apiKeyScopes: ["mcp.read"],
      keyWorkspaceId: null,
      ...extra,
    } as never);
  const text = (r: { content: Array<{ type: string; text?: string }> }) =>
    r.content.map((c) => c.text ?? "").join("");

  it("returns the scene with each shape's text fenced as untrusted data", async () => {
    m.fetchImpl = liveRoom(RECORDS);
    const r = await call({ viewId: VIEW });
    expect(r.isError).toBeFalsy();
    const out = text(r as never);
    expect(out).toContain('"source":"live"');
    expect(out).toContain("BEGIN UNTRUSTED CONTENT");
    expect(out).toContain("Call Bob");
    expect(m.accessCalls).toEqual([[USER, DOC]]);
  });

  it("fences every typed string: board name, page names, titles, text, urls", async () => {
    m.view = { ...m.view, name: "Board name X" };
    m.fetchImpl = liveRoom({
      "page:p": { typeName: "page", id: "page:p", name: "Page name X" },
      "shape:f": {
        typeName: "shape",
        id: "shape:f",
        type: "frame",
        parentId: "page:p",
        x: 0,
        y: 0,
        props: { w: 500, h: 500, name: "Frame name X" },
      },
      "shape:c": {
        typeName: "shape",
        id: "shape:c",
        type: "entityCard",
        parentId: "shape:f",
        x: 10,
        y: 10,
        props: { w: 100, h: 100, entityId: "e1", title: "Card title X" },
      },
      "shape:u": {
        typeName: "shape",
        id: "shape:u",
        type: "cell",
        parentId: "page:p",
        x: 0,
        y: 600,
        props: {
          w: 100,
          h: 100,
          cellKey: "url-embed",
          cellProps: JSON.stringify({ url: "https://evil.example/x" }),
        },
      },
      "shape:a": {
        typeName: "shape",
        id: "shape:a",
        type: "arrow",
        parentId: "page:p",
        x: 0,
        y: 0,
        props: { start: { x: 0, y: 0 }, end: { x: 5, y: 5 }, text: "Arrow X" },
      },
    });
    const body = JSON.parse(text((await call({ viewId: VIEW })) as never));
    const fenced = (v: unknown, raw: string) => {
      expect(typeof v).toBe("string");
      expect(v as string).toContain("BEGIN UNTRUSTED CONTENT");
      expect(v as string).toContain(raw);
    };
    const by = Object.fromEntries(
      body.scene.shapes.map((x: { id: string }) => [x.id, x])
    );
    fenced(body.title, "Board name X");
    fenced(body.scene.pages[0].name, "Page name X");
    fenced(by["shape:f"].title, "Frame name X");
    fenced(by["shape:c"].title, "Card title X");
    fenced(by["shape:u"].refs.url, "https://evil.example/x");
    fenced(body.scene.arrows[0].text, "Arrow X");
    // Ids are not typed text: left bare.
    expect(by["shape:c"].refs.entityId).toBe("e1");
  });

  it("a big board fits under the reply cap and pages on with no shape skipped or repeated", async () => {
    const big: Record<string, unknown> = {};
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const id = `shape:s${String(i).padStart(2, "0")}`;
      ids.push(id);
      big[id] = {
        typeName: "shape",
        id,
        type: "sticky",
        parentId: "page:page",
        x: 0,
        y: i * 300,
        props: { w: 240, h: 200, content: `${i}:` + "w".repeat(2_000) },
      };
    }
    m.fetchImpl = liveRoom(big);
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null && pages < 50) {
      const out = text((await call({ viewId: VIEW, offset })) as never);
      expect(out.length).toBeLessThanOrEqual(16_000);
      const body = JSON.parse(out);
      expect(body.truncated).toBeUndefined();
      expect(body.scene.shapes.length).toBeGreaterThan(0);
      // The fit keeps the untrusted fence on what it kept.
      expect(body.scene.shapes[0].text).toContain("BEGIN UNTRUSTED CONTENT");
      seen.push(...body.scene.shapes.map((x: { id: string }) => x.id));
      offset = body.scene.window.nextOffset;
      pages++;
    }
    expect(seen).toEqual(ids);
    expect(pages).toBeGreaterThan(3);
  });

  it("a failed read is a tool error naming the reason", async () => {
    m.fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const r = await call({ viewId: VIEW });
    expect(r.isError).toBe(true);
    expect(text(r as never)).toContain("reason: live_unavailable");
  });

  it("a missing or short id is refused before any read; a bound key reads only its space", async () => {
    expect((await call({})).isError).toBe(true);
    expect((await call({ viewId: "1b1b1b1b" })).isError).toBe(true);
    expect(m.accessCalls).toEqual([]);
    const r = await call({ viewId: VIEW }, { keyWorkspaceId: OTHER_WS });
    expect(text(r as never)).toContain("reason: not_found");
  });
});

describe("grant fence: a scoped key reads a board only when its grant reads views, documents and entities unbounded", () => {
  const grantOf = (permissions: string[], workspaceIds: string[] | null) =>
    ({
      scopes: [
        { permissions, workspaceIds, projectIds: null, entityIds: null },
      ],
      clientId: null,
    }) as never;
  const ALL = ["view.read", "document.read", "entity.read"];

  it("Hub route and MCP tool share one declaration", () => {
    const path = `/whiteboards/${VIEW}/scene`;
    expect(restDoorAllowed("GET", path, grantOf(ALL, null))).toBe(true);
    expect(mcpToolAllowed("synap_read_board", true, grantOf(ALL, null))).toBe(
      true
    );
    // Pinned to a space: the reader is not narrowed by a grant, so refused.
    expect(restDoorAllowed("GET", path, grantOf(ALL, [WS]))).toBe(false);
    expect(mcpToolAllowed("synap_read_board", true, grantOf(ALL, [WS]))).toBe(
      false
    );
    // Missing a subject the scene reads: refused.
    const noEntity = grantOf(["view.read", "document.read"], null);
    expect(restDoorAllowed("GET", path, noEntity)).toBe(false);
    expect(mcpToolAllowed("synap_read_board", true, noEntity)).toBe(false);
  });
});
