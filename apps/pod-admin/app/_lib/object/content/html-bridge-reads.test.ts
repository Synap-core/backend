/**
 * Pod admin's read door for a running HTML page (`readForPage`), driven
 * through the one bridge host (`createCellBridgeHost`, whose own rules are
 * tested in the leaf `@synap-core/types/cell-bridge`).
 */
import { describe, expect, it } from "vitest";
import {
  CELL_BRIDGE_READ_OP_NAMES,
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

  const PILLARS = {
    mainGoal: null,
    pillars: [{ trackId: "t1", health: "on_track" }],
    rootHealth: { status: "unavailable" },
  };
  const LEAN = {
    continuation: { detail: "lean", session: { id: "s1", title: "W" } },
    outcomes: { status: "ok", counts: { met: 1, total: 2 } },
    cost: null,
  };

  function fakeClient(refuse: ReadonlySet<string> = new Set()) {
    const calls: Array<{ path: string; input: unknown; opts: unknown }> = [];
    const proc = (path: string, answer: unknown) => ({
      query: async (input: unknown, opts?: unknown) => {
        calls.push({ path, input, opts });
        // What the pod answers a viewer outside the read's floor.
        if (refuse.has(path)) throw new Error(`${path}: not found`);
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
      focusSessions: {
        list: proc("focusSessions.list", []),
        getLean: proc("focusSessions.getLean", LEAN),
      },
      playbooks: {
        process: proc("playbooks.process", { definition: { id: "pb1" } }),
        scorecard: proc("playbooks.scorecard", { runs: { total: 3 } }),
      },
      projects: {
        get: proc("projects.get", {
          project: { id: "p1", name: "Not for the page" },
          usedWorkspaces: [{ id: "w9" }],
          ...PILLARS,
        }),
      },
      documents: { get: proc("documents.get", { content: "# hi" }) },
      flow: { of: proc("flow.of", { profileSlug: "deal", states: [] }) },
    };
    return { client: client as unknown as BridgeClient, calls };
  }

  function wired(
    workspaceId: string | null,
    refuse: ReadonlySet<string> = new Set()
  ) {
    const { client, calls } = fakeClient(refuse);
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

  it("a kind's flow is the flow read IN the page's space, bounded like the board", async () => {
    const { calls, posted, send } = wired(SPACE);
    await send(
      query("flow.of", {
        profileSlug: "deal",
        trackId: "t1",
        windowDays: 9000,
        firstN: 500,
        properties: true,
        workspaceId: "other",
        projectId: "p1",
      })
    );
    expect(calls.map((c) => [c.path, c.input])).toEqual([
      [
        "flow.of",
        {
          profileSlug: "deal",
          trackId: "t1",
          window: { days: 366 },
          firstN: 50,
          properties: true,
          workspaceId: SPACE,
        },
      ],
    ]);
    expect(posted[0]!.message).toEqual({
      type: "synap:query:result",
      id: "q1",
      data: { profileSlug: "deal", states: [] },
    });
  });

  it("every op of the one table reaches a pod read through the host (derived set)", async () => {
    expect(CELL_BRIDGE_READ_OP_NAMES.length).toBeGreaterThanOrEqual(14);
    expect(CELL_BRIDGE_READ_OP_NAMES).toContain("flow.of");
    for (const op of CELL_BRIDGE_READ_OP_NAMES) {
      const { calls, posted, send } = wired(SPACE);
      await send(
        query(op, {
          profileSlug: "deal",
          id: "e1",
          documentId: "d1",
          playbookId: "pb1",
        })
      );
      expect(calls.length, op).toBe(1);
      expect(posted[0]!.message, op).not.toHaveProperty("error");
    }
  });

  it("the work reads are each the procedure its own page reads, by id, with no lens", async () => {
    const { calls, posted, send } = wired(SPACE);
    const spoof = { workspaceId: "other", projectId: "p9", limit: 5 };
    await send(query("sessions.get", { id: "s1", ...spoof }));
    await send(
      query("playbook.process", { playbookId: "pb1", ...spoof }, "q2")
    );
    await send(
      query("playbook.scorecard", { playbookId: "pb1", ...spoof }, "q3")
    );
    await send(query("project.pillars", { id: "p1", ...spoof }, "q4"));
    expect(calls.map((c) => [c.path, c.input])).toEqual([
      ["focusSessions.getLean", { id: "s1" }],
      ["playbooks.process", { playbookId: "pb1" }],
      ["playbooks.scorecard", { playbookId: "pb1" }],
      ["projects.get", { id: "p1", include: ["pillars"] }],
    ]);
    expect(posted.map((p) => p.message)).toEqual([
      { type: "synap:query:result", id: "q1", data: LEAN },
      {
        type: "synap:query:result",
        id: "q2",
        data: { definition: { id: "pb1" } },
      },
      { type: "synap:query:result", id: "q3", data: { runs: { total: 3 } } },
      // The pillars only: the project row is not this op's answer.
      { type: "synap:query:result", id: "q4", data: PILLARS },
    ]);
  });

  it("a work read the pod refuses this viewer reaches the page as that error, never empty", async () => {
    const refused = new Set([
      "focusSessions.getLean",
      "playbooks.process",
      "playbooks.scorecard",
      "projects.get",
    ]);
    const { calls, posted, send } = wired(SPACE, refused);
    await send(query("sessions.get", { id: "s1" }));
    await send(query("playbook.process", { playbookId: "pb1" }, "q2"));
    await send(query("playbook.scorecard", { playbookId: "pb1" }, "q3"));
    await send(query("project.pillars", { id: "p1" }, "q4"));
    expect(calls).toHaveLength(4);
    expect(posted.map((p) => p.message)).toEqual([
      {
        type: "synap:query:result",
        id: "q1",
        error: "focusSessions.getLean: not found",
      },
      {
        type: "synap:query:result",
        id: "q2",
        error: "playbooks.process: not found",
      },
      {
        type: "synap:query:result",
        id: "q3",
        error: "playbooks.scorecard: not found",
      },
      {
        type: "synap:query:result",
        id: "q4",
        error: "projects.get: not found",
      },
    ]);
  });

  it("a work read with no id is an error, and asks the pod nothing", async () => {
    const { calls, posted, send } = wired(SPACE);
    await send(query("sessions.get", { sessionId: "s1" }));
    await send(query("playbook.scorecard", { id: "pb1" }, "q2"));
    expect(calls).toEqual([]);
    expect(posted.map((p) => p.message)).toEqual([
      {
        type: "synap:query:result",
        id: "q1",
        error: '"sessions.get" needs an id.',
      },
      {
        type: "synap:query:result",
        id: "q2",
        error: '"playbook.scorecard" needs a playbookId.',
      },
    ]);
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
