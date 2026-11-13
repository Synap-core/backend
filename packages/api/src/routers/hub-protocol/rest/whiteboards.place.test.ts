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
 * Cannot see: a real pod's governance ladder (the real gate is driven by
 * `whiteboards.place.governance.pglite.test.ts`), a running realtime server,
 * a browser rendering the shapes (NEEDS-DOGFOOD).
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
const CELL = "7b7b7b7b-0000-4000-8000-0000000000f1";
const AUTOMATION = "6a6a6a6a-0000-4000-8000-0000000000ff";
const OTHER_AGENT = "0aaaaaaa-0000-4000-8000-0000000000b8";
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
  existingCells: [] as Array<Record<string, unknown>>,
  entityRows: [] as Array<Record<string, unknown>>,
  viewRows: [] as Array<Record<string, unknown>>,
  automationRows: [] as Array<Record<string, unknown>>,
  /** The agent the request context says is acting (`getActingAgentUserId`). */
  acting: undefined as string | undefined,
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
        from: (table: unknown) => ({
          where: () => {
            const rows =
              table === actual.entities
                ? m.entityRows
                : table === actual.views
                  ? m.viewRows
                  : table === actual.automations
                    ? m.automationRows
                    : m.existingCells;
            // Awaited as is (references) or `.limit(1)` (ensureCell).
            return Object.assign(Promise.resolve(rows), {
              limit: async () => rows,
            });
          },
        }),
      }),
    },
    getActingAgentUserId: () => m.acting,
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
  async (body: { put?: unknown[]; patch?: unknown[]; remove?: unknown[] }) =>
    new Response(
      JSON.stringify({
        roomId: ROOM,
        applied: true,
        target,
        put: body.put?.length ?? 0,
        patched: body.patch?.length ?? 0,
        removed: body.remove?.length ?? 0,
        skipped: [],
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
  m.entityRows = [
    {
      id: ENTITY,
      type: "task",
      title: "Acme",
      profileId: null,
      workspaceId: WS,
      homeWorkspaceId: null,
      properties: {},
      status: null,
      updatedAt: new Date("2026-11-01T00:00:00Z"),
    },
  ];
  m.viewRows = [];
  m.automationRows = [{ id: AUTOMATION, workspaceId: WS }];
  m.acting = undefined;
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
          automationId: AUTOMATION,
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

describe("url embeds: the browser's embed rule, on the server", () => {
  it.each([
    [
      "http (insecure)",
      { kind: "url", url: "http://example.com/" },
      "insecure",
    ],
    ["javascript:", { kind: "url", url: "javascript:alert(1)" }, "scheme"],
    [
      "a stored file",
      {
        kind: "url",
        url: "https://bucket.s3.amazonaws.com/a.svg?X-Amz-Signature=abc",
      },
      "stored-file",
    ],
    [
      "the pod itself",
      { kind: "url", url: "https://pod.place.test/settings" },
      "own-pod",
    ],
    [
      "an iframe-embed cell definition",
      {
        kind: "cellDefinition",
        cellKey: "iframe-embed",
        props: { url: "data:text/html,<script>1</script>" },
      },
      "scheme",
    ],
  ])(
    "refuses %s before governance, writing nothing",
    async (_n, resource, why) => {
      const before = process.env.PUBLIC_URL;
      process.env.PUBLIC_URL = "https://pod.place.test";
      try {
        const res = await place({ resources: [resource] });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.reason).toBe("embed_refused");
        expect(body.error).toContain(`(${why})`);
        expect(m.gateCalls).toHaveLength(0);
        expect(m.cellInserts).toHaveLength(0);
        expect(m.applies).toHaveLength(0);
      } finally {
        if (before === undefined) delete process.env.PUBLIC_URL;
        else process.env.PUBLIC_URL = before;
      }
    }
  );

  it("a https website is placed", async () => {
    const res = await place({
      resources: [{ kind: "url", url: "https://example.com/page" }],
    });
    expect(res.status).toBe(200);
    expect(m.cellInserts[0]).toMatchObject({
      cellType: "iframe-embed",
      config: { url: "https://example.com/page" },
    });
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

  it("granted, an update and a removal are sent as intent in ONE write (the merge happens on the live board)", async () => {
    const res = await place({
      update: [{ shapeId: "shape:s", x: 50, props: { color: "blue" } }],
      remove: ["shape:frame"],
    });
    expect(res.status).toBe(200);
    expect(m.applies).toHaveLength(1);
    expect(m.applies[0]).toMatchObject({
      patch: [{ shapeId: "shape:s", x: 50, props: { color: "blue" } }],
      remove: ["shape:frame"],
    });
    expect(m.applies[0]).not.toHaveProperty("put");
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
    // The realtime server decides against the live board and refuses.
    m.applyImpl = async () =>
      new Response(
        JSON.stringify({
          error: "The board holds no shape shape:gone.",
          reason: "shape_not_found",
        }),
        { status: 400 }
      );
    await expect(
      run("whiteboard/update_shapes", {
        viewId: VIEW,
        update: [{ shapeId: "shape:gone", x: 1 }],
      })
    ).rejects.toThrow(/shape_not_found/);
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

describe("a create never overwrites what is not the same actor's pending shape", () => {
  const req = (key?: string) => ({
    resources: [{ kind: "entity", entityId: ENTITY }],
    ...(key ? { idempotencyKey: key } : {}),
  });
  const ids = async (res: Response) => (await res.json()).created.shapeIds;

  it("two actors using the same idempotencyKey get different shape ids", async () => {
    const a = await ids(await place(req("1"), { agentUserId: AGENT }));
    const b = await ids(await place(req("1"), { agentUserId: OTHER_AGENT }));
    expect(a).not.toEqual(b);
  });

  it("the same actor and key replace themselves (a retry)", async () => {
    const a = await ids(await place(req("1")));
    const b = await ids(await place(req("1")));
    expect(a).toEqual(b);
  });

  it("a reused key with DIFFERENT html makes a different cell (the second html is never dropped)", async () => {
    const html = (h: string) => ({
      resources: [{ kind: "html", name: "Hi", html: h }],
      idempotencyKey: "deck-1",
    });
    await place(html("<p>one</p>"));
    await place(html("<p>two</p>"));
    expect(m.htmlCells).toHaveLength(2);
    expect(m.htmlCells[0]!.id).not.toBe(m.htmlCells[1]!.id);
    // The same content again is the same cell.
    await place(html("<p>two</p>"));
    expect(m.htmlCells[2]!.id).toBe(m.htmlCells[1]!.id);
  });

  it("what the board kept is reported skipped, not claimed written", async () => {
    let skippedId = "";
    m.applyImpl = async (body: any) => {
      skippedId = body.put[0].id;
      return new Response(
        JSON.stringify({
          roomId: ROOM,
          applied: true,
          target: "live",
          put: 0,
          patched: 0,
          removed: 0,
          skipped: [skippedId],
        }),
        { status: 200 }
      );
    };
    const body = await (await place(req())).json();
    expect(body.created.shapeIds).toEqual([]);
    expect(body.created.skipped).toEqual([skippedId]);
  });
});

describe("every gate runs before any write; one write carries everything granted", () => {
  it("a denied removal refuses the whole call: nothing written, no cell made", async () => {
    m.verdicts["whiteboard/delete_shapes"] = { denied: true, reason: "never" };
    const res = await place({
      resources: [{ kind: "html", name: "Hi", html: "<p>hi</p>" }],
      remove: ["shape:frame"],
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "denied" });
    expect(m.applies).toHaveLength(0);
    expect(m.htmlCells).toHaveLength(0);
    expect(m.gateCalls).toHaveLength(2);
  });

  it("a create plus a proposed removal writes only the create, in one apply", async () => {
    m.verdicts["whiteboard/delete_shapes"] = proposed("prop-d");
    const body = await (
      await place({
        resources: [{ kind: "entity", entityId: ENTITY }],
        remove: ["shape:frame"],
      })
    ).json();
    expect(body.created.status).toBe("applied");
    expect(body.removed).toMatchObject({
      status: "proposed",
      proposalId: "prop-d",
    });
    expect(m.applies).toHaveLength(1);
    expect(m.applies[0]).toHaveProperty("put");
    expect(m.applies[0]).not.toHaveProperty("remove");
  });

  it("create, update and remove land in ONE apply", async () => {
    await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
      update: [{ shapeId: "shape:s", x: 1 }],
      remove: ["shape:frame"],
    });
    expect(m.applies).toHaveLength(1);
    expect(Object.keys(m.applies[0]).sort()).toEqual(
      ["documentId", "origin", "patch", "put", "remove"].sort()
    );
  });

  it("an agent's update or removal beyond its grant is a proposal (proposeBeyondGrant), a create is not", async () => {
    await place({
      update: [{ shapeId: "shape:s", x: 1 }],
      remove: ["shape:frame"],
    });
    const byAction = Object.fromEntries(
      m.gateCalls.map((g) => [g.action as string, g])
    );
    expect(byAction.update_shapes).toMatchObject({ proposeBeyondGrant: true });
    expect(byAction.delete_shapes).toMatchObject({ proposeBeyondGrant: true });
    await place({ resources: [{ kind: "entity", entityId: ENTITY }] });
    expect(m.gateCalls.find((g) => g.action === "place")).not.toHaveProperty(
      "proposeBeyondGrant"
    );
  });

  it("pending and governance read the SAME identity: an acting agent the caller did not pass", async () => {
    m.acting = AGENT;
    const body = await (
      await place(
        { resources: [{ kind: "entity", entityId: ENTITY }] },
        { agentUserId: undefined }
      )
    ).json();
    expect(body.created.pending).toBe(true);
    expect(m.gateCalls[0]).toMatchObject({ agentUserId: AGENT });
    expect(m.applies[0].put[0].meta.pending).toBe(true);
  });
});

describe("the ids a call names are checked, and the card shows the row", () => {
  it("an entity card shows what the ROW says, not what the agent wrote", async () => {
    await place({
      resources: [
        {
          kind: "entity",
          entityId: ENTITY,
          title: "Fake title",
          entityType: "invoice",
          properties: { secret: "spoofed" },
        },
      ],
    });
    expect(m.applies[0].put[0].props).toMatchObject({
      title: "Acme",
      entityType: "task",
      properties: {},
    });
  });

  it("an entity that does not exist or is not readable refuses the whole call", async () => {
    m.entityRows = [];
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "reference_not_found" });
    expect(m.gateCalls).toHaveLength(0);
    expect(m.applies).toHaveLength(0);
  });

  it("a key bound to one space cannot embed an entity of another", async () => {
    m.entityRows = [{ ...m.entityRows[0]!, workspaceId: OTHER_WS }];
    const res = await place(
      { resources: [{ kind: "entity", entityId: ENTITY }] },
      { keyWorkspaceId: WS }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "reference_not_found" });
  });

  it("a cell or an automation of another space is refused", async () => {
    m.existingCells = [
      { id: CELL, workspaceId: OTHER_WS, cellType: "kpi", name: "K" },
    ];
    let res = await place({
      resources: [{ kind: "cellInstance", cellInstanceId: CELL }],
    });
    expect(await res.json()).toMatchObject({ reason: "reference_not_found" });
    m.automationRows = [{ id: AUTOMATION, workspaceId: OTHER_WS }];
    res = await place({
      resources: [
        { kind: "automation", automationId: AUTOMATION, mode: "flow" },
      ],
    });
    expect(await res.json()).toMatchObject({ reason: "reference_not_found" });
    expect(m.applies).toHaveLength(0);
  });

  it("a cell of the board's space is placed with the key the ROW says", async () => {
    m.existingCells = [
      { id: CELL, workspaceId: WS, cellType: "kpi", name: "Revenue" },
    ];
    await place({
      resources: [
        { kind: "cellInstance", cellInstanceId: CELL, cellKey: "spoofed" },
      ],
    });
    expect(m.applies[0].put[0].props).toMatchObject({
      cellInstanceId: CELL,
      cellKey: "kpi",
      title: "Revenue",
    });
  });
});

describe("sizes are bounded before any work is done", () => {
  it("50 decks of 50 slides is refused before a single cell is made", async () => {
    const deck = {
      kind: "artboard-deck",
      preset: "slide-16-9",
      slides: Array.from({ length: 50 }, () => ({ html: "<p/>" })),
    };
    const res = await place({
      resources: Array.from({ length: 50 }, () => deck),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 100 cells/);
    expect(m.htmlCells).toHaveLength(0);
    expect(m.applies).toHaveLength(0);
  });

  it("a body past the limit is a 413 before it is parsed", async () => {
    const res = await app().request(`/whiteboards/${VIEW}/placements`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(9 * 1024 * 1024),
      },
      body: JSON.stringify({
        remove: ["shape:" + "a".repeat(9 * 1024 * 1024)],
      }),
    });
    expect(res.status).toBe(413);
    expect(m.gateCalls).toHaveLength(0);
  });
});

describe("a write whose answer was lost is a timeout, not a refusal", () => {
  const timeoutError = () =>
    Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });

  it("the door says it may have landed and that a retry is safe (504)", async () => {
    m.applyImpl = async () => {
      throw timeoutError();
    };
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
    });
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.reason).toBe("timeout");
    expect(body.error).toMatch(/may or may not have landed/);
  });

  it("the realtime server's own lock timeout is the same answer", async () => {
    m.applyImpl = async () =>
      new Response(
        JSON.stringify({ error: "held too long", reason: "timeout" }),
        {
          status: 504,
        }
      );
    const res = await place({
      resources: [{ kind: "entity", entityId: ENTITY }],
    });
    expect(res.status).toBe(504);
  });

  describe("approval reconciles against the board", () => {
    const deps = {
      emitProposalReviewed: vi.fn(),
      reportProposalOutcome: vi.fn(),
    };
    const approve = () =>
      proposalExecRegistry.resolveExact("whiteboard/delete_shapes")!.execute({
        proposal: {
          id: "prop-t",
          workspaceId: WS,
          subjectUserId: USER,
          agentUserId: AGENT,
          data: { data: { viewId: VIEW, shapeIds: ["shape:frame"] } },
        },
        payload: null,
        userId: USER,
        input: { proposalId: "prop-t" },
        ctx: {},
        deps,
      } as never);

    it("the removal landed (the shape is gone): the approval completes", async () => {
      m.applyImpl = async () => {
        throw timeoutError();
      };
      const { "shape:frame": _gone, ...without } = RECORDS;
      m.stateImpl = liveRoom(without);
      await expect(approve()).resolves.toMatchObject({ success: true });
      expect(m.transitions).toBe(1);
    });

    it("the removal did NOT land (the shape is still there): the proposal stays pending", async () => {
      m.applyImpl = async () => {
        throw timeoutError();
      };
      await expect(approve()).rejects.toThrow(/timeout/);
      expect(m.transitions).toBe(0);
    });
  });
});

describe("a proposal filed before the door fixed its key still approves", () => {
  it("whiteboard/place with no placementKey derives one from the proposal (no dead end)", async () => {
    const res = await proposalExecRegistry
      .resolveExact("whiteboard/place")!
      .execute({
        proposal: {
          id: "prop-old",
          workspaceId: WS,
          subjectUserId: USER,
          agentUserId: AGENT,
          data: {
            data: {
              viewId: VIEW,
              resources: [{ kind: "entity", entityId: ENTITY }],
            },
          },
        },
        payload: null,
        userId: USER,
        input: { proposalId: "prop-old" },
        ctx: {},
        deps: { emitProposalReviewed: vi.fn(), reportProposalOutcome: vi.fn() },
      } as never);
    expect(res).toMatchObject({ success: true });
    expect(m.applies[0].put[0].id.startsWith("shape:synap-placed-")).toBe(true);
  });
});
