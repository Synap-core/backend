/**
 * Pod admin's read door for a running HTML page (`readForPage`), driven
 * through the one bridge host (`createCellBridgeHost`, whose own rules are
 * tested in the leaf `@synap-core/types/cell-bridge`).
 */
import { describe, expect, it } from "vitest";
import {
  createCellBridgeHost,
  type CellBridgeTarget,
} from "@synap-core/types/cell-bridge";
import { LENS_PAGE_READ_CAPS } from "@synap-core/types/lens";
import { readForPage, type BridgeClient } from "./html-bridge-reads";

/** A fake frame window that records what the host posts to it. */
function fakeFrame() {
  const posted: Array<{ message: Record<string, unknown>; target: string }> =
    [];
  const frame: CellBridgeTarget = {
    postMessage: (message, target) =>
      posted.push({ message: message as Record<string, unknown>, target }),
  };
  return { frame, posted };
}

const query = (operation: string, params: unknown = {}, id = "q1") => ({
  type: "synap:query",
  id,
  operation,
  params,
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
    const host = createCellBridgeHost({
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
