import { describe, expect, it, vi } from "vitest";
import {
  CELL_BRIDGE_WRITE_REFUSED,
  type CellBridgeParamValue,
  type CellBridgeReadOp,
} from "@synap-core/types/cell-bridge";
import { LENS_PAGE_READ_CAPS } from "@synap-core/types/lens";
import {
  BRIDGE_MAX_ANSWER_CHARS,
  BRIDGE_MAX_IN_FLIGHT,
  createHtmlBridgeHost,
  type BridgeTarget,
} from "./html-bridge-host";
import { readForPage, type BridgeClient } from "./html-bridge-reads";

/** A fake frame window that records what the host posts to it. */
function fakeFrame() {
  const posted: Array<{ message: Record<string, unknown>; target: string }> =
    [];
  const frame: BridgeTarget = {
    postMessage: (message, target) =>
      posted.push({ message: message as Record<string, unknown>, target }),
  };
  return { frame, posted };
}

type Read = (
  op: CellBridgeReadOp,
  params: Record<string, CellBridgeParamValue>
) => Promise<unknown>;

function setup(read: Read = async () => ({ ok: true })) {
  const { frame, posted } = fakeFrame();
  let current: BridgeTarget | null = frame;
  const readSpy = vi.fn(read);
  const host = createHtmlBridgeHost({
    frameWindow: () => current,
    read: readSpy,
  });
  const send = (data: unknown, source: unknown = frame, origin = "null") =>
    host({ source, origin, data });
  return {
    frame,
    posted,
    read: readSpy,
    send,
    replaceFrame: (next: BridgeTarget | null) => {
      current = next;
    },
  };
}

const query = (operation: string, params: unknown = {}, id = "q1") => ({
  type: "synap:query",
  id,
  operation,
  params,
});

describe("the page bridge host — what it refuses", () => {
  it("refuses every write, and reads nothing for it", async () => {
    const { posted, read, send } = setup();
    await send({
      type: "synap:mutate",
      id: "m1",
      operation: "update_entity",
      payload: { id: "x", title: "pwned" },
    });
    expect(read).not.toHaveBeenCalled();
    expect(posted).toEqual([
      {
        message: {
          type: "synap:mutate:result",
          id: "m1",
          status: "denied",
          error: CELL_BRIDGE_WRITE_REFUSED,
        },
        target: "*",
      },
    ]);
  });

  it("refuses an op outside the shared table", async () => {
    const { posted, read, send } = setup();
    await send(query("entities.create", { title: "x" }));
    await send(query("apiKeys.list", {}, "q2"));
    expect(read).not.toHaveBeenCalled();
    expect(posted.map((p) => p.message)).toEqual([
      {
        type: "synap:query:result",
        id: "q1",
        error: '"entities.create" is not something a page can read.',
      },
      {
        type: "synap:query:result",
        id: "q2",
        error: '"apiKeys.list" is not something a page can read.',
      },
    ]);
  });

  it("ignores a message whose source is not the frame", async () => {
    const { posted, read, send } = setup();
    const other = fakeFrame();
    await send(query("entities.list"), other.frame);
    await send(query("entities.list"), null);
    await send(query("entities.list"), { postMessage: () => {} });
    expect(read).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
    expect(other.posted).toEqual([]);
  });

  it("ignores the frame once it has a real origin (it navigated away)", async () => {
    const { posted, read, send, frame } = setup();
    await send(query("entities.list"), frame, "https://evil.example");
    await send(query("entities.list"), frame, "https://pod.example");
    expect(read).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("ignores what is not a bridge message", async () => {
    const { posted, read, send } = setup();
    for (const data of [
      null,
      "hello",
      { type: "synap:ready" },
      { type: "synap:query" },
    ]) {
      await send(data);
    }
    expect(read).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("with no frame running, nothing is answered", async () => {
    const { posted, read, send, replaceFrame, frame } = setup();
    replaceFrame(null);
    await send(query("entities.list"), frame);
    expect(read).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });
});

describe("the page bridge host — what it answers", () => {
  it("answers an allowed op with only that op's params, to the frame", async () => {
    const { posted, read, send } = setup(async () => ({
      items: [
        {
          id: "e1",
          title: "Ship it",
          updatedAt: new Date("2026-10-27T10:00:00Z"),
        },
      ],
    }));
    await send(
      query("entities.list", {
        profileSlug: "task",
        limit: 5,
        workspaceId: "another-space",
        projectId: "a-project",
      })
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("entities.list", {
      profileSlug: "task",
      limit: 5,
    });
    expect(posted).toEqual([
      {
        message: {
          type: "synap:query:result",
          id: "q1",
          // Plain JSON data: the date crossed as a string.
          data: {
            items: [
              {
                id: "e1",
                title: "Ship it",
                updatedAt: "2026-10-27T10:00:00.000Z",
              },
            ],
          },
        },
        target: "*",
      },
    ]);
  });

  it("a failed read is an error the page can show — never an empty answer", async () => {
    const { posted, send } = setup(async () => {
      throw new Error("FORBIDDEN: not yours");
    });
    await send(query("entities.get", { id: "x" }));
    expect(posted[0]!.message).toEqual({
      type: "synap:query:result",
      id: "q1",
      error: "FORBIDDEN: not yours",
    });
    expect(posted[0]!.message).not.toHaveProperty("data");
  });

  it("an answer too large to hand over is an error, never a cut list", async () => {
    const { posted, send } = setup(async () => ({
      text: "x".repeat(BRIDGE_MAX_ANSWER_CHARS),
    }));
    await send(query("documents.get", { documentId: "d" }));
    expect(posted[0]!.message).toMatchObject({
      type: "synap:query:result",
      id: "q1",
    });
    expect(String(posted[0]!.message.error)).toContain("too large");
    expect(posted[0]!.message).not.toHaveProperty("data");
  });

  it("an answer for a frame that was reloaded meanwhile is dropped", async () => {
    let finish: (v: unknown) => void = () => {};
    const { posted, send, replaceFrame } = setup(
      () => new Promise((resolve) => (finish = resolve))
    );
    const pending = send(query("entities.list"));
    replaceFrame(fakeFrame().frame);
    finish({ items: [] });
    await pending;
    expect(posted).toEqual([]);
  });

  it(`caps reads in flight at ${BRIDGE_MAX_IN_FLIGHT}`, async () => {
    const waiting: Array<(v: unknown) => void> = [];
    const { posted, read, send } = setup(
      () => new Promise((resolve) => waiting.push(resolve))
    );
    const sent = Array.from({ length: BRIDGE_MAX_IN_FLIGHT + 1 }, (_, i) =>
      send(query("views.list", {}, `q${i}`))
    );
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(BRIDGE_MAX_IN_FLIGHT);
    expect(posted.map((p) => p.message)).toEqual([
      {
        type: "synap:query:result",
        id: `q${BRIDGE_MAX_IN_FLIGHT}`,
        error: "Too many reads at once. Wait for the others to finish.",
      },
    ]);
    waiting.forEach((resolve) => resolve([]));
    await Promise.all(sent);
    expect(posted).toHaveLength(BRIDGE_MAX_IN_FLIGHT + 1);
  });
});

/**
 * The seam: a frame message → the host → `readForPage` → the console's tRPC
 * client, with nothing hand-built in between. The client is a fake that
 * records each procedure call.
 */
describe("the page bridge — through the console's own client", () => {
  const SPACE = "11111111-1111-4111-8111-111111111111";

  function fakeClient() {
    const calls: Array<{ path: string; input: unknown; opts: unknown }> = [];
    const proc = (path: string, answer: unknown) => ({
      query: async (input: unknown, opts?: unknown) => {
        calls.push({ path, input, opts });
        return answer;
      },
    });
    const client = {
      entities: {
        list: proc("entities.list", { items: [] }),
        get: proc("entities.get", { entity: { id: "e1" } }),
      },
      views: { list: proc("views.list", []) },
      profiles: { list: proc("profiles.list", []) },
      lifecycle: {
        board: proc("lifecycle.board", { columns: [] }),
        throughput: proc("lifecycle.throughput", { buckets: [] }),
        home: proc("lifecycle.home", {
          spaces: [{ workspaceId: SPACE }, { workspaceId: "other" }],
          needsYou: { total: 3, bySpace: [{ workspaceId: SPACE, count: 1 }] },
        }),
        moving: proc("lifecycle.moving", { items: [] }),
      },
      signals: {
        list: proc("signals.list", { items: [] }),
        count: proc("signals.count", { total: 0 }),
      },
      focusSessions: { list: proc("focusSessions.list", []) },
      documents: { get: proc("documents.get", { content: "# hi" }) },
    };
    return { client: client as unknown as BridgeClient, calls };
  }

  function wired(workspaceId: string | null) {
    const { client, calls } = fakeClient();
    const { frame, posted } = fakeFrame();
    const host = createHtmlBridgeHost({
      frameWindow: () => frame,
      read: (op, params) => readForPage(client, op, params, { workspaceId }),
    });
    const send = (data: unknown) =>
      host({ source: frame, origin: "null", data });
    return { calls, posted, send };
  }

  it("stamps the page's space on a list, whatever space the page names", async () => {
    const { calls, posted, send } = wired(SPACE);
    await send(
      query("entities.list", { profileSlug: "task", workspaceId: "other" })
    );
    expect(calls).toEqual([
      {
        path: "entities.list",
        input: {
          profileSlug: "task",
          limit: 50,
          offset: 0,
          workspaceId: SPACE,
        },
        opts: undefined,
      },
    ]);
    expect(posted[0]!.message).toEqual({
      type: "synap:query:result",
      id: "q1",
      data: { items: [] },
    });
  });

  it("a personal page (no space) reads with no lens at all", async () => {
    const { calls, send } = wired(null);
    await send(query("views.list", { workspaceId: SPACE }));
    expect(calls[0]!.input).toEqual({ limit: 50, offset: 0 });
  });

  it("Needs you and its count are the signals reads, lensed by the host", async () => {
    const { calls, send } = wired(SPACE);
    await send(query("attention.needsYou", { profileSlug: "deal", limit: 10 }));
    await send(query("attention.count", { profileSlug: "deal" }, "q2"));
    expect(calls.map((c) => [c.path, c.input])).toEqual([
      [
        "signals.list",
        {
          lens: "needs-you",
          profileSlug: "deal",
          limit: 10,
          workspaceId: SPACE,
        },
      ],
      ["signals.count", { profileSlug: "deal", workspaceId: SPACE }],
    ]);
  });

  it("profiles are read IN the page's space (header, per call)", async () => {
    const { calls, send } = wired(SPACE);
    await send(query("profiles.list"));
    expect(calls[0]).toEqual({
      path: "profiles.list",
      input: {},
      opts: { context: { workspaceId: SPACE } },
    });
  });

  it("Home is narrowed to the page's space", async () => {
    const { posted, send } = wired(SPACE);
    await send(query("lifecycle.home"));
    expect(posted[0]!.message).toEqual({
      type: "synap:query:result",
      id: "q1",
      data: {
        spaces: [{ workspaceId: SPACE }],
        needsYou: {
          total: 1,
          truncated: false,
          bySpace: [{ workspaceId: SPACE, count: 1 }],
        },
      },
    });
  });

  it("sessions on a kind, and a document's content", async () => {
    const { calls, send } = wired(SPACE);
    await send(query("sessions.list", { profileSlug: "task", limit: 500 }));
    await send(
      query("documents.get", { documentId: "d1", format: "readable" }, "q2")
    );
    expect(calls.map((c) => [c.path, c.input])).toEqual([
      [
        "focusSessions.list",
        {
          subject: { profileSlug: "task" },
          kind: "work",
          limit: 50,
          workspaceId: SPACE,
        },
      ],
      ["documents.get", { documentId: "d1", format: "readable" }],
    ]);
  });

  it("a lens page is the page read IN the page's space, bounded only by since", async () => {
    const { calls, send } = wired(SPACE);
    await send(
      query("lens.page", {
        since: "2026-11-01T00:00:00.000Z",
        workspaceId: "other",
        projectId: "p1",
      })
    );
    expect(calls.map((c) => [c.path, c.input])).toEqual([
      [
        "signals.list",
        {
          lens: "page",
          workspaceId: SPACE,
          caps: { ...LENS_PAGE_READ_CAPS },
          since: "2026-11-01T00:00:00.000Z",
        },
      ],
    ]);
  });

  it("a page in no space cannot read a lens page: refused, the pod is not asked", async () => {
    const { calls, posted, send } = wired(null);
    await send(query("lens.page"));
    expect(calls).toEqual([]);
    expect(posted[0]!.message).toEqual({
      type: "synap:query:result",
      id: "q1",
      error: '"lens.page" reads one space, and this page is not in a space',
    });
  });

  it("a read missing what it needs is an error, and asks the pod nothing", async () => {
    const { calls, posted, send } = wired(SPACE);
    await send(query("lifecycle.board", {}));
    expect(calls).toEqual([]);
    expect(posted[0]!.message).toEqual({
      type: "synap:query:result",
      id: "q1",
      error: '"lifecycle.board" needs a profileSlug.',
    });
  });
});
