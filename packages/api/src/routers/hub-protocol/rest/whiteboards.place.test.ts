/**
 * The board PLACE door: Hub `POST /whiteboards/:viewId/placements`, MCP
 * `synap_place_on_board` and the `whiteboard/*` approve executors, all through
 * `placeOnBoard` / its cores.
 *
 * Driven through the real route, the real door and the real record builder;
 * only the I/O seams are mocked: the view and document rows, the room floor
 * (`resolveDocumentRoomAccess`), the governance gate (a verdict per door),
 * the cell inserts, and the realtime bridge (`fetch`: the state read answers
 * with a REAL encoded Y.Doc; the apply is recorded and answered as the bridge
 * would). What the bridge then does with the records (open room vs stored
 * file, the lock, load-failed) is the realtime package's own test
 * (`whiteboard-apply.test.ts`).
 *
 * Cannot see: a real pod's governance ladder, a running realtime server, a
 * browser rendering the shapes (NEEDS-DOGFOOD).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const USER = "0aaaaaaa-0000-4000-8000-000000000001";
const AGENT = "0aaaaaaa-0000-4000-8000-0000000000a9";
const VIEW = "1b1b1b1b-0000-4000-8000-0000000000aa";
const DOC = "2c2c2c2c-0000-4000-8000-0000000000bb";
const WS = "3d3d3d3d-0000-4000-8000-0000000000cc";
const OTHER_WS = "4e4e4e4e-0000-4000-8000-0000000000dd";
const ENTITY = "5f5f5f5f-0000-4000-8000-0000000000ee";
const ROOM = `whiteboard-${DOC}`;

const RECORDS: Record<string, Record<string, unknown>> = {
  "page:page": {
    typeName: "page",
    id: "page:page",
    name: "Page 1",
    index: "a1",
    meta: {},
  },
  "shape:s": {
    typeName: "shape",
    id: "shape:s",
    type: "sticky",
    parentId: "page:page",
    index: "a3",
    x: 10,
    y: 20,
    rotation: 0,
    props: { w: 240, h: 200, content: "Call Bob", color: "yellow" },
    meta: {},
  },
  "shape:frame": {
    typeName: "shape",
    id: "shape:frame",
    type: "frame",
    parentId: "page:page",
    index: "a2",
    x: 1000,
    y: 0,
    rotation: 0,
    props: { w: 800, h: 600 },
    meta: {},
  },
};

type Verdict =
  | { granted: true }
  | { denied: true; reason: string }
  | {
      granted: false;
      proposalId: string;
      proposalType: string;
      summary: string;
      reasoning: string;
      reviewPath: string;
      reviewUrl: string;
    };

const m = vi.hoisted(() => ({
  view: null as Record<string, unknown> | null,
  doc: null as Record<string, unknown> | null,
  access: "edit" as "edit" | "read" | "none",
  existingCells: [] as Array<{ id: string; workspaceId: string | null }>,
  verdicts: {} as Record<string, unknown>,
  gateCalls: [] as Array<Record<string, unknown>>,
  cellInserts: [] as Array<Record<string, unknown>>,
  htmlCells: [] as Array<Record<string, unknown>>,
  stateImpl: null as null | (() => Promise<Response>),
  applyImpl: null as null | ((body: any) => Promise<Response>),
  applies: [] as any[],
  transitions: 0,
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
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => m.existingCells }),
        }),
      }),
    },
    transitionProposal: () => ({
      returning: async () => {
        m.transitions++;
        return [{ id: "p" }];
      },
    }),
  };
});
vi.mock("@synap/storage", () => ({
  storage: {
    downloadBuffer: async () => Buffer.from(JSON.stringify({ store: RECORDS })),
  },
}));
vi.mock("../../../utils/document-edit-access.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/document-edit-access.js")
  >()),
  resolveDocumentRoomAccess: async () => m.access,
}));
vi.mock("../../views.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../views.js")>()),
  assertViewAccess: async () => undefined,
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/permission-check.js")
  >()),
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    m.gateCalls.push(opts);
    return (
      m.verdicts[`${opts.subjectType}/${opts.action}`] ?? { granted: true }
    );
  },
}));
vi.mock("../../../services/cells/create-cell-instance.js", () => ({
  insertCellInstance: async (input: Record<string, unknown>) => {
    m.cellInserts.push(input);
    return { id: input.id };
  },
  createHtmlCellInstance: async (input: Record<string, unknown>) => {
    m.htmlCells.push(input);
    return { id: input.id };
  },
}));
vi.mock("./_shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_shared.js")>()),
  resolveActorId: async (agent: string | undefined, user: string) => ({
    actorId: agent ?? user,
  }),
}));

vi.stubGlobal(
  "fetch",
  async (url: string, init?: { method?: string; body?: string }) => {
    if (String(url).endsWith("/apply")) {
      const body = JSON.parse(init?.body ?? "{}");
      m.applies.push(body);
      if (!m.applyImpl) throw new Error("apply not set");
      return m.applyImpl(body);
    }
    if (!m.stateImpl) throw new Error("state not set");
    return m.stateImpl();
  }
);

const { registerWhiteboardsRoutes } = await import("./whiteboards.js");
const { buildHandlers } = await import("../../mcp/handlers/build.js");
const { proposalExecRegistry } =
  await import("../../proposals/execution-registry.js");
const { registerWhiteboardExecutors } =
  await import("../../proposals/executors/whiteboard.js");
registerWhiteboardExecutors();

function liveRoom(records: Record<string, unknown>) {
  return async () => {
    const doc = new Y.Doc();
    const map = doc.getMap(`tl_map_${DOC}`);
    for (const [k, v] of Object.entries(records)) map.set(k, v);
    const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
    return new Response(JSON.stringify({ roomId: ROOM, state }), {
      status: 200,
    });
  };
}
const roomClosed = async () =>
  new Response(JSON.stringify({ error: "Room not active", roomId: ROOM }), {
    status: 404,
  });
const applied =
  (target: "live" | "stored") =>
  async (body: { put: unknown[]; remove?: unknown[] }) =>
    new Response(
      JSON.stringify({
        roomId: ROOM,
        applied: true,
        target,
        put: body.put.length,
        removed: body.remove?.length ?? 0,
      }),
      { status: 200 }
    );

function app(vars: Record<string, unknown> = {}) {
  const a = new OpenAPIHono();
  a.use("*", async (c, next) => {
    const all: Record<string, unknown> = {
      userId: USER,
      agentUserId: AGENT,
      scopes: ["hub-protocol.write"],
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

const place = (body: unknown, vars: Record<string, unknown> = {}) =>
  app(vars).request(`/whiteboards/${VIEW}/placements`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const proposed = (id: string): Verdict => ({
  granted: false,
  proposalId: id,
  proposalType: "whiteboard.x",
  summary: "s",
  reasoning: "r",
  reviewPath: `/open/${id}`,
  reviewUrl: `https://pod/open/${id}`,
});

beforeEach(() => {
  m.view = {
    id: VIEW,
    type: "whiteboard",
    name: "Board",
    workspaceId: WS,
    documentId: DOC,
    yjsRoomId: null,
  };
  m.doc = {
    storageKey: "whiteboards/u/board.json",
    updatedAt: new Date(),
    createdAt: new Date(),
  };
  m.access = "edit";
  m.existingCells = [];
  m.verdicts = {};
  m.gateCalls = [];
  m.cellInserts = [];
  m.htmlCells = [];
  m.applies = [];
  m.transitions = 0;
  m.stateImpl = liveRoom(RECORDS);
  m.applyImpl = applied("live");
});

describe("creating shapes: applied at once, marked pending, retry-safe", () => {
  it("writes an agent's entity card pending, with placedBy and placedAt, through the bridge", async () => {
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY, title: "Acme" }],
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.created).toMatchObject({
      status: "applied",
      target: "live",
      pending: true,
    });
    // Governed: whiteboard/place, on the BOARD's workspace.
    expect(m.gateCalls).toHaveLength(1);
    expect(m.gateCalls[0]).toMatchObject({
      subjectType: "whiteboard",
      action: "place",
      workspaceId: WS,
      agentUserId: AGENT,
    });
    expect(m.applies).toHaveLength(1);
    const [apply] = m.applies;
    expect(apply.documentId).toBe(DOC);
    expect(apply.origin).toBe(`synap-place:${AGENT}`);
    const [card] = apply.put;
    expect(card).toMatchObject({
      typeName: "shape",
      type: "entityCard",
      parentId: "page:page",
      index: "a4",
      props: { entityId: ENTITY, title: "Acme" },
      meta: {
        pending: true,
        placedBy: { userId: USER, agentUserId: AGENT },
      },
    });
    expect(typeof card.meta.placedAt).toBe("string");
    expect(card.id.startsWith("shape:synap-placed-")).toBe(true);
    expect(body.created.shapeIds).toEqual([card.id]);
  });

  it("a retry (same request, or same idempotencyKey) writes the SAME ids: it replaces", async () => {
    const req = { resources: [{ kind: "entity", entityId: ENTITY }] };
    const a = await (await place(req)).json();
    const b = await (await place(req)).json();
    expect(b.created.shapeIds).toEqual(a.created.shapeIds);
    expect(m.applies[1].put[0].id).toBe(m.applies[0].put[0].id);

    const k1 = await (await place({ ...req, idempotencyKey: "k" })).json();
    const k2 = await (
      await place({
        resources: [{ kind: "entity", entityId: ENTITY, title: "changed" }],
        idempotencyKey: "k",
      })
    ).json();
    expect(k2.created.shapeIds).toEqual(k1.created.shapeIds);
    expect(k1.created.shapeIds).not.toEqual(a.created.shapeIds);
  });

  it("a person's own placement (no agent) is not marked pending", async () => {
    const res = await place(
      { resources: [{ kind: "entity", entityId: ENTITY }] },
      { agentUserId: undefined }
    );
    const body = await res.json();
    expect(body.created.pending).toBe(false);
    expect(m.applies[0].put[0].meta).not.toHaveProperty("pending");
  });

  it("writes into a CLOSED board: the bridge's stored-file answer is passed on", async () => {
    m.stateImpl = roomClosed;
    m.applyImpl = applied("stored");
    const body = await (
      await place({ resources: [{ kind: "entity", entityId: ENTITY }] })
    ).json();
    expect(body.created).toMatchObject({ status: "applied", target: "stored" });
    // The stored board was read for the index: above its top shape.
    expect(m.applies[0].put[0].index).toBe("a4");
  });

  it("places a deck: one html cell per slide (retry-safe ids), one artboard per slide holding it", async () => {
    const res = await place({
      resources: [
        {
          kind: "artboard-deck",
          preset: "linkedin-carousel",
          title: "Launch",
          slides: [
            { html: "<h1>1</h1>", title: "One" },
            { html: "<h1>2</h1>" },
          ],
        },
      ],
      options: { x: 0, y: 900 },
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(m.htmlCells).toHaveLength(2);
    expect(m.htmlCells.map((c) => c.html)).toEqual([
      "<h1>1</h1>",
      "<h1>2</h1>",
    ]);
    expect(m.htmlCells[0]).toMatchObject({
      workspaceId: WS,
      agentUserId: AGENT,
    });
    const put = m.applies[0].put as Array<Record<string, any>>;
    const boards = put.filter((r) => r.type === "artboard");
    const cells = put.filter((r) => r.type === "cell");
    expect(boards).toHaveLength(2);
    expect(cells.map((c) => c.parentId)).toEqual(boards.map((b) => b.id));
    expect(cells.map((c) => c.props.cellInstanceId)).toEqual(
      m.htmlCells.map((c) => c.id)
    );
    expect(body.created.shapeIds).toEqual(boards.map((b) => b.id));

    // Retried: the same cells (ids) are reused, never created twice.
    m.existingCells = [{ id: "x", workspaceId: WS }];
    m.htmlCells = [];
    await place({
      resources: [
        {
          kind: "artboard-deck",
          preset: "linkedin-carousel",
          title: "Launch",
          slides: [
            { html: "<h1>1</h1>", title: "One" },
            { html: "<h1>2</h1>" },
          ],
        },
      ],
      options: { x: 0, y: 900 },
    });
    expect(m.htmlCells).toHaveLength(0);
  });

  it("html, url and automation become cells as the browser placer makes them", async () => {
    await place({
      resources: [
        { kind: "html", name: "Hi", html: "<p>hi</p>" },
        { kind: "url", url: "https://example.com/a", title: "A" },
        {
          kind: "automation",
          automationId: "6a6a6a6a-0000-4000-8000-0000000000ff",
          mode: "status",
        },
      ],
    });
    expect(m.htmlCells).toHaveLength(1);
    expect(m.cellInserts.map((c) => c.cellType)).toEqual([
      "iframe-embed",
      "automation-status",
    ]);
    const put = m.applies[0].put as Array<Record<string, any>>;
    expect(put.map((r) => [r.type, r.props.cellKey])).toEqual([
      ["cell", "html-embed"],
      ["cell", "iframe-embed"],
      ["cell", "automation-status"],
    ]);
  });

  it("where the person made placement a proposal, NOTHING is written until approval", async () => {
    m.verdicts["whiteboard/place"] = proposed("prop-1");
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
    });
    const body = await res.json();
    expect(body.created).toMatchObject({
      status: "proposed",
      proposalId: "prop-1",
    });
    expect(body.created.shapeIds).toHaveLength(1);
    expect(m.applies).toHaveLength(0);
  });
});

describe("changing and removing shapes: a proposal by default", () => {
  it("update and remove go through checkPermissionOrPropose and, proposed, write nothing", async () => {
    m.verdicts["whiteboard/update_shapes"] = proposed("prop-u");
    m.verdicts["whiteboard/delete_shapes"] = proposed("prop-d");
    const res = await place({
      update: [{ shapeId: "shape:s", x: 50 }],
      remove: ["shape:frame"],
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(m.gateCalls.map((g) => `${g.subjectType}/${g.action}`)).toEqual([
      "whiteboard/update_shapes",
      "whiteboard/delete_shapes",
    ]);
    expect(body.updated).toMatchObject({
      status: "proposed",
      proposalId: "prop-u",
      shapeIds: ["shape:s"],
    });
    expect(body.removed).toMatchObject({
      status: "proposed",
      proposalId: "prop-d",
      shapeIds: ["shape:frame"],
    });
    expect(m.applies).toHaveLength(0);
  });

  it("granted, an update writes the merged record and a removal deletes the shape", async () => {
    const res = await place({
      update: [{ shapeId: "shape:s", x: 50, props: { color: "blue" } }],
      remove: ["shape:frame"],
    });
    expect(res.status).toBe(200);
    expect(m.applies).toHaveLength(2);
    expect(m.applies[0].put[0]).toMatchObject({
      id: "shape:s",
      x: 50,
      y: 20,
      props: { color: "blue", content: "Call Bob" },
    });
    expect(m.applies[1]).toMatchObject({ put: [], remove: ["shape:frame"] });
  });

  it("an unknown shape refuses the whole call before governance (shape_not_found)", async () => {
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
      remove: ["shape:nope"],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "shape_not_found" });
    expect(m.gateCalls).toHaveLength(0);
    expect(m.applies).toHaveLength(0);
  });

  it("an unknown frame refuses before governance (frame_not_found)", async () => {
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
      options: { frameId: "shape:nope" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "frame_not_found" });
    expect(m.applies).toHaveLength(0);
  });
});

describe("the floor and the write-side fence", () => {
  it("a board of another space than the one named is refused (wrong_workspace, 404)", async () => {
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
      workspaceId: OTHER_WS,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ reason: "wrong_workspace" });
    expect(m.gateCalls).toHaveLength(0);
    expect(m.applies).toHaveLength(0);
  });

  it("a key bound to another space does not find the board", async () => {
    const res = await place(
      { resources: [{ kind: "entity", entityId: ENTITY }] },
      { keyWorkspaceId: OTHER_WS }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ reason: "not_found" });
    expect(m.applies).toHaveLength(0);
  });

  it("a reader of the board cannot place (read_only, 403)", async () => {
    m.access = "read";
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "read_only" });
    expect(m.applies).toHaveLength(0);
  });

  it("governance denied is a 403 that wrote nothing", async () => {
    m.verdicts["whiteboard/place"] = { denied: true, reason: "never" };
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "denied" });
    expect(m.applies).toHaveLength(0);
  });

  it("a malformed body is a 400 naming the field", async () => {
    const res = await place({ resources: [{ kind: "entity" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/resources\.0/);
  });
});

describe("a failed write is an ERROR with a reason, never a placement", () => {
  it("the open board failed to load: load_failed (409) from the bridge", async () => {
    m.applyImpl = async () =>
      new Response(
        JSON.stringify({
          error: "The board's saved content could not be loaded.",
          reason: "load_failed",
          roomId: ROOM,
        }),
        { status: 409 }
      );
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("load_failed");
    expect(body.error).toContain("could not be loaded");
    expect(body).not.toHaveProperty("created");
  });

  it("the save did not land: save_failed (503)", async () => {
    m.applyImpl = async () =>
      new Response(JSON.stringify({ error: "x", reason: "save_failed" }), {
        status: 503,
      });
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "save_failed" });
  });

  it("the realtime server is down, or has no apply route: unavailable (503)", async () => {
    m.applyImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    let res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "unavailable" });

    m.applyImpl = async () =>
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    res = await place({ resources: [{ kind: "entity", entityId: ENTITY }] });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "unavailable" });
  });

  it("the board's state cannot be read: unavailable before anything is governed", async () => {
    m.stateImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "unavailable" });
    expect(m.gateCalls).toHaveLength(0);
  });
});

describe("MCP synap_place_on_board: the same door", () => {
  const call = (args: Record<string, unknown>) =>
    buildHandlers.synap_place_on_board!({
      toolName: "synap_place_on_board",
      args,
      userId: USER,
      agentUserId: AGENT,
      apiKeyScopes: ["mcp.write"],
      keyWorkspaceId: null,
    } as never);
  const text = (r: { content: Array<{ type: string; text?: string }> }) =>
    r.content.map((c) => c.text ?? "").join("");

  it("places through placeOnBoard", async () => {
    const r = await call({
      viewId: VIEW,
      resources: [{ kind: "entity", entityId: ENTITY }],
    });
    expect(r.isError).toBeFalsy();
    expect(text(r as never)).toContain('"status":"applied"');
    expect(m.applies).toHaveLength(1);
  });

  it("a refusal is a tool error naming its reason", async () => {
    m.access = "read";
    const r = await call({
      viewId: VIEW,
      resources: [{ kind: "entity", entityId: ENTITY }],
    });
    expect(r.isError).toBe(true);
    expect(text(r as never)).toContain("reason: read_only");
  });
});

describe("approval replays the same cores (whiteboard/* executors)", () => {
  const deps = {
    emitProposalReviewed: vi.fn(),
    reportProposalOutcome: vi.fn(),
  };
  const run = (key: string, data: Record<string, unknown>) =>
    proposalExecRegistry.resolveExact(key)!.execute({
      proposal: {
        id: "prop-9",
        workspaceId: WS,
        subjectUserId: USER,
        agentUserId: AGENT,
        data: { data },
      },
      payload: null,
      userId: USER,
      input: { proposalId: "prop-9" },
      ctx: {},
      deps,
    } as never);

  it("whiteboard/place writes the announced ids, not pending, placedBy naming the proposal", async () => {
    const res = await run("whiteboard/place", {
      viewId: VIEW,
      resources: [{ kind: "entity", entityId: ENTITY }],
      placementKey: `${VIEW}:key:k`,
    });
    expect(res).toMatchObject({ success: true });
    const [card] = m.applies[0].put;
    expect(card.meta).not.toHaveProperty("pending");
    expect(card.meta.placedBy).toEqual({
      userId: USER,
      agentUserId: AGENT,
      proposalId: "prop-9",
    });
    expect(m.transitions).toBe(1);
  });

  it("whiteboard/delete_shapes removes the shapes on approval", async () => {
    await run("whiteboard/delete_shapes", {
      viewId: VIEW,
      shapeIds: ["shape:frame"],
    });
    expect(m.applies[0].remove).toEqual(["shape:frame"]);
  });

  it("a shape gone since the proposal refuses the approval (nothing written, still pending)", async () => {
    await expect(
      run("whiteboard/update_shapes", {
        viewId: VIEW,
        update: [{ shapeId: "shape:gone", x: 1 }],
      })
    ).rejects.toThrow(/shape_not_found/);
    expect(m.applies).toHaveLength(0);
    expect(m.transitions).toBe(0);
  });

  it("an approver who may only read the board cannot apply it", async () => {
    m.access = "read";
    await expect(
      run("whiteboard/delete_shapes", { viewId: VIEW, shapeIds: ["shape:s"] })
    ).rejects.toThrow(/read_only/);
    expect(m.applies).toHaveLength(0);
  });
});
