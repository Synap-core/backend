/**
 * The one module-frame host (`createCellFrameHost`): what a running module
 * frame can get from its host, and every refusal, driven with a fake frame
 * window. Each host's own doors (its read and write clients) stay tested in
 * its own repo.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CELL_BRIDGE_MAX_ANSWER_CHARS,
  CELL_BRIDGE_MAX_IN_FLIGHT,
  CELL_BRIDGE_WRITE_NEEDS_TYPE,
  CELL_BRIDGE_WRITE_REFUSED,
  CELL_FRAME_NO_READS,
  CELL_FRAME_NO_WRITES,
  cellBridgeUnknownOp,
  createCellFrameHost,
  type CellBridgeMutateResult,
  type CellBridgeTarget,
  type CellFrameHostOptions,
  type CellFrameWriteRequest,
} from "./index.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const ENTITY = "22222222-2222-4222-8222-222222222222";
const VIEW = "33333333-3333-4333-8333-333333333333";

/**
 * A fake frame window and the reply port its document hands over in its hello
 * (`frame-channel.ts`). What reaches the frame on the port is in `posted`
 * (target "port"); anything posted to the WINDOW is in `windowPosted`, which
 * must stay empty: a window post reaches whatever document the frame holds
 * by then (security review H1).
 */
function fakeFrame() {
  const posted: Array<{ message: Record<string, unknown>; target: string }> =
    [];
  const windowPosted: Array<{ message: unknown; target: string }> = [];
  const frame: CellBridgeTarget = {
    postMessage: (message, target) => windowPosted.push({ message, target }),
  };
  const port = {
    postMessage: (message: unknown) => {
      if ((message as { type?: unknown }).type === "synap:channel:ready")
        return;
      posted.push({
        message: message as Record<string, unknown>,
        target: "port",
      });
    },
  };
  const hello = {
    source: frame,
    origin: "null",
    data: { type: "synap:hello" },
    ports: [port],
  };
  return { frame, posted, windowPosted, hello };
}

function setup(overrides: Partial<CellFrameHostOptions> = {}) {
  const { frame, posted, windowPosted, hello } = fakeFrame();
  let current: CellBridgeTarget | null = frame;
  const read = vi.fn(async () => ({ items: [1] }));
  const write = vi.fn(
    async (_r: CellFrameWriteRequest): Promise<CellBridgeMutateResult> => ({
      status: "proposed",
      proposalId: "p1",
    })
  );
  const on = {
    status: vi.fn(),
    resize: vi.fn(),
    navigate: vi.fn(),
    openExternal: vi.fn(),
    toast: vi.fn(),
    openPanel: vi.fn(),
    openSurface: vi.fn(),
    contextUpdate: vi.fn(),
  };
  const host = createCellFrameHost({
    frameWindow: () => current,
    lens: { workspaceId: SPACE },
    identity: { typeKey: "cell:acme:board", viewId: VIEW },
    init: () => ({ workspaceId: SPACE, viewId: VIEW, theme: "dark" }),
    read,
    write,
    on,
    ...overrides,
  });
  const send = (data: unknown, source: unknown = frame, origin = "null") =>
    host({ source, origin, data });
  // The document says hello first, handing over its reply port.
  void host(hello);
  return {
    frame,
    posted,
    windowPosted,
    read,
    write,
    on,
    send,
    detach: () => (current = null),
  };
}

describe("the module frame host", () => {
  it("one load says ready twice: a read sent between the two is still answered", async () => {
    const { posted, send } = setup({ read: async () => ({ ok: true }) });
    await send({ type: "synap:ready" });
    const read = send({
      type: "synap:query",
      id: "q1",
      operation: "entities.list",
    });
    await send({ type: "synap:ready" });
    await read;
    expect(posted.map((p) => p.message.type)).toEqual([
      "synap:init",
      "synap:query:result",
    ]);
  });

  it("answers ready with init once, stamped sdk 2, to that frame only", async () => {
    const { posted, send } = setup();
    await send({ type: "synap:ready" });
    await send({ type: "synap:ready" });
    expect(posted).toEqual([
      {
        message: {
          type: "synap:init",
          config: {},
          context: {
            workspaceId: SPACE,
            viewId: VIEW,
            theme: "dark",
            sdkVersion: "2",
          },
        },
        target: "port",
      },
    ]);
  });

  it("ignores a message from another window or a real origin", async () => {
    const { posted, read, on, send } = setup();
    const stranger = fakeFrame().frame;
    await send({ type: "synap:ready" }, stranger);
    await send({ type: "synap:mounted" }, stranger);
    await send(
      { type: "synap:query", id: "q1", operation: "entities.list" },
      undefined,
      "https://evil.example"
    );
    expect(posted).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(on.status).not.toHaveBeenCalled();
  });

  it("mounted says ready once; an error says failed; resize goes to the host", async () => {
    const { on, send } = setup();
    await send({ type: "synap:mounted" });
    await send({ type: "synap:mounted" });
    await send({ type: "synap:error", message: "boom" });
    await send({ type: "synap:resize", height: 240 });
    await send({ type: "synap:resize", height: 0 });
    expect(on.status.mock.calls).toEqual([
      [{ state: "ready" }],
      [{ state: "error", message: "boom" }],
    ]);
    expect(on.resize.mock.calls).toEqual([[240]]);
  });

  it("an error says why when the frame typed it: a renderer that does not draw this object", async () => {
    const { on, send } = setup();
    await send({
      type: "synap:error",
      message: "Not a list",
      reason: "not-drawn",
    });
    await send({ type: "synap:error", message: "boom", reason: "made-up" });
    expect(on.status.mock.calls).toEqual([
      [{ state: "error", message: "Not a list", reason: "not-drawn" }],
      [{ state: "error", message: "boom" }],
    ]);
  });

  it("forwards navigation and surface requests to the host, and nothing else", async () => {
    const { on, send } = setup();
    await send({
      type: "synap:navigate",
      target: { type: "entity", id: "e1" },
    });
    await send({ type: "synap:toast", message: "Saved" });
    await send({
      type: "synap:open-panel",
      id: "1",
      panelType: "view",
      resourceId: "v1",
    });
    await send({
      type: "synap:surface:open",
      surface: { kind: "entity", entityId: "e1" },
    });
    await send({ type: "synap:context-update", meta: { page: 2 } });
    expect(on.navigate).toHaveBeenCalledWith({ type: "entity", id: "e1" });
    expect(on.toast).toHaveBeenCalledWith("Saved", "info");
    expect(on.openPanel).toHaveBeenCalledWith("view", "v1");
    expect(on.openSurface).toHaveBeenCalledWith({
      kind: "entity",
      entityId: "e1",
    });
    expect(on.contextUpdate).toHaveBeenCalledWith({ page: 2 });
  });

  it("a web address is never navigated to: the host is asked to confirm it, cut to its origin and path (H2)", async () => {
    const { on, send } = setup();
    const secret = encodeURIComponent('{"title":"the viewer\'s secret"}');
    await send({
      type: "synap:navigate",
      target: {
        type: "url",
        url: `https://evil.example/x?d=${secret}#${secret}`,
      },
    });
    expect(on.navigate).not.toHaveBeenCalled();
    expect(on.openExternal).toHaveBeenCalledWith({
      href: "https://evil.example/x",
      host: "evil.example",
    });
  });

  it("a host with no external door opens no web address at all", async () => {
    const navigate = vi.fn();
    const { send } = setup({ on: { navigate } });
    await send({
      type: "synap:navigate",
      target: { type: "url", url: "https://example.com/" },
    });
    await send({ type: "synap:navigate", target: { type: "view", id: "v1" } });
    expect(navigate.mock.calls).toEqual([[{ type: "view", id: "v1" }]]);
  });
});

describe("reads", () => {
  it("an allowed op is read with only its own params, and answered as plain JSON", async () => {
    const { posted, read, send } = setup();
    await send({
      type: "synap:query",
      id: "q1",
      operation: "entities.list",
      params: { profileSlug: "task", workspaceId: "other", deep: { a: 1 } },
    });
    expect(read).toHaveBeenCalledWith("entities.list", { profileSlug: "task" });
    expect(posted[0]!.message).toEqual({
      type: "synap:query:result",
      id: "q1",
      data: { items: [1] },
    });
  });

  it("a view adapter's reads are in the table", async () => {
    const { read, send } = setup();
    await send({
      type: "synap:query",
      id: "q1",
      operation: "propertyDefs.list",
      params: { profileId: "pr1", profileIds: ["x"] },
    });
    expect(read).toHaveBeenCalledWith("propertyDefs.list", {
      profileId: "pr1",
    });
  });

  it("refuses an op outside the table, and a space read in no space", async () => {
    const { posted, read, send } = setup({ lens: { workspaceId: null } });
    await send({ type: "synap:query", id: "q1", operation: "entities.delete" });
    await send({ type: "synap:query", id: "q2", operation: "lens.page" });
    expect(read).not.toHaveBeenCalled();
    expect(posted.map((p) => p.message)).toEqual([
      {
        type: "synap:query:result",
        id: "q1",
        error: cellBridgeUnknownOp("entities.delete"),
      },
      {
        type: "synap:query:result",
        id: "q2",
        error: '"lens.page" reads one space, and this page is not in a space',
      },
    ]);
  });

  it("a failed read is an error, never an empty answer", async () => {
    const { posted, send } = setup({
      read: async () => {
        throw new Error("NOT_FOUND: no such view");
      },
    });
    await send({
      type: "synap:query",
      id: "q1",
      operation: "views.get",
      params: { id: "v" },
    });
    expect(posted[0]!.message).toEqual({
      type: "synap:query:result",
      id: "q1",
      error: "NOT_FOUND: no such view",
    });
  });

  it("a host with no read door refuses, with words", async () => {
    const { posted, send } = setup({ read: undefined });
    await send({ type: "synap:query", id: "q1", operation: "entities.list" });
    expect(posted[0]!.message).toEqual({
      type: "synap:query:result",
      id: "q1",
      error: CELL_FRAME_NO_READS,
    });
  });

  it("an answer over 1 M characters is an error, never a cut list", async () => {
    const { posted, send } = setup({
      read: async () => "x".repeat(CELL_BRIDGE_MAX_ANSWER_CHARS + 1),
    });
    await send({ type: "synap:query", id: "q1", operation: "entities.list" });
    expect(posted[0]!.message.error).toMatch(/too large/);
    expect(posted[0]!.message).not.toHaveProperty("data");
  });

  it("at most 8 requests in flight; the 9th is refused, not queued", async () => {
    const pending: Array<() => void> = [];
    const { posted, send } = setup({
      read: () =>
        new Promise((resolve) => pending.push(() => resolve({ ok: true }))),
    });
    const runs = Array.from({ length: CELL_BRIDGE_MAX_IN_FLIGHT + 1 }, (_, i) =>
      send({ type: "synap:query", id: `q${i}`, operation: "entities.list" })
    );
    await Promise.resolve();
    expect(pending).toHaveLength(CELL_BRIDGE_MAX_IN_FLIGHT);
    expect(posted.map((p) => p.message)).toEqual([
      {
        type: "synap:query:result",
        id: `q${CELL_BRIDGE_MAX_IN_FLIGHT}`,
        error: "Too many requests at once. Wait for the others to finish.",
      },
    ]);
    pending.forEach((done) => done());
    await Promise.all(runs);
    expect(posted).toHaveLength(CELL_BRIDGE_MAX_IN_FLIGHT + 1);
  });

  it("an answer for a frame that was torn down meanwhile is dropped", async () => {
    let finish: (v: unknown) => void = () => {};
    const h = setup({ read: () => new Promise((r) => (finish = r)) });
    const run = h.send({
      type: "synap:query",
      id: "q1",
      operation: "entities.list",
    });
    await Promise.resolve();
    h.detach();
    finish({ ok: true });
    await run;
    expect(h.posted).toEqual([]);
  });
});

describe("writes", () => {
  const create = (payload: unknown, id = "m1") => ({
    type: "synap:mutate",
    id,
    operation: "create_entity",
    payload,
  });

  it("a checked write is stamped by the host and answered with what the pod said", async () => {
    const { posted, write, send } = setup();
    await send(
      create({
        profileSlug: "task",
        properties: { priority: "high" },
        workspaceId: "forged",
        viewContext: { typeKey: "forged" },
        source: "agent",
      })
    );
    expect(write).toHaveBeenCalledWith({
      op: "create_entity",
      payload: { profileSlug: "task", properties: { priority: "high" } },
      viewContext: { typeKey: "cell:acme:board", viewId: VIEW },
      source: "user",
      lens: { workspaceId: SPACE },
    });
    expect(posted[0]!.message).toEqual({
      type: "synap:mutate:result",
      id: "m1",
      status: "proposed",
      proposalId: "p1",
    });
  });

  it("approved carries its data as plain JSON; an unknown status is a denial", async () => {
    const approved = setup({
      write: async () => ({
        status: "approved",
        data: { id: ENTITY, at: new Date(0) },
      }),
    });
    await approved.send(create({ profileSlug: "task" }));
    expect(approved.posted[0]!.message).toEqual({
      type: "synap:mutate:result",
      id: "m1",
      status: "approved",
      data: { id: ENTITY, at: "1970-01-01T00:00:00.000Z" },
    });
    const odd = setup({
      write: async () =>
        ({ status: "applied" }) as unknown as CellBridgeMutateResult,
    });
    await odd.send(create({ profileSlug: "task" }));
    expect(odd.posted[0]!.message).toMatchObject({
      type: "synap:mutate:result",
      id: "m1",
      status: "denied",
    });
  });

  it("a page frame refuses every write, and asks the pod nothing", async () => {
    const { posted, write, send } = setup({ mechanism: "page" });
    await send(create({ profileSlug: "task" }));
    expect(write).not.toHaveBeenCalled();
    expect(posted[0]!.message).toEqual({
      type: "synap:mutate:result",
      id: "m1",
      status: "denied",
      error: CELL_BRIDGE_WRITE_REFUSED,
    });
  });

  it("a module frame without a type refuses every write", async () => {
    const { posted, write, send } = setup({ identity: { viewId: VIEW } });
    await send(create({ profileSlug: "task" }));
    expect(write).not.toHaveBeenCalled();
    expect(posted[0]!.message.error).toBe(CELL_BRIDGE_WRITE_NEEDS_TYPE);
  });

  it("a payload that breaks its rule is refused whole, before the pod", async () => {
    const { posted, write, send } = setup();
    await send({
      type: "synap:mutate",
      id: "m1",
      operation: "update_entity",
      payload: { id: "not-an-id", properties: {} },
    });
    await send({
      type: "synap:mutate",
      id: "m2",
      operation: "update_entity",
      payload: JSON.parse(
        `{"id":"${ENTITY}","properties":{"__proto__":{"x":1}}}`
      ),
    });
    expect(write).not.toHaveBeenCalled();
    expect(posted.map((p) => p.message.status)).toEqual(["denied", "denied"]);
  });

  it("an op outside the table and a host with no write door are denied", async () => {
    const h = setup();
    await h.send({
      type: "synap:mutate",
      id: "m1",
      operation: "documents.update",
      payload: {},
    });
    expect(h.posted[0]!.message.error).toMatch(
      /not a change a view can ask for/
    );
    const none = setup({ write: undefined });
    await none.send(create({ profileSlug: "task" }));
    expect(none.posted[0]!.message.error).toBe(CELL_FRAME_NO_WRITES);
  });

  it("a thrown write is a denial with its words", async () => {
    const { posted, send } = setup({
      write: async () => {
        throw new Error("FORBIDDEN: not yours");
      },
    });
    await send(create({ profileSlug: "task" }));
    expect(posted[0]!.message).toEqual({
      type: "synap:mutate:result",
      id: "m1",
      status: "denied",
      error: "FORBIDDEN: not yours",
    });
  });
});
