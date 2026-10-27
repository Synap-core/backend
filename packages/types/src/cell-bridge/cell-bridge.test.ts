import { describe, expect, it } from "vitest";
import {
  CELL_BRIDGE_READ_OPS,
  CELL_BRIDGE_READ_OP_NAMES,
  CELL_BRIDGE_SDK,
  CELL_BRIDGE_WRITE_REFUSED,
  CELL_FRAME_MAX_BYTES,
  CELL_FRAME_SANDBOX,
  buildCellFrameCsp,
  cellFrameHeadBlock,
  htmlByteLength,
  isCellBridgeReadOp,
  narrowHomeToSpace,
  parseCellBridgeMessage,
  pickBridgeParams,
  wrapHtmlForFrame,
} from "./index.js";

/** The policy as directive → sources, parsed from the built string. */
function directives(csp: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources.join(" "));
  }
  return out;
}

describe("the frame's Content Security Policy", () => {
  it("is exactly the approved policy", () => {
    expect(buildCellFrameCsp()).toBe(
      "default-src 'none'; " +
        "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; " +
        "style-src 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src data: https://fonts.gstatic.com; " +
        "img-src data: blob:; " +
        "connect-src 'none'; " +
        "form-action 'none'; " +
        "base-uri 'none'; " +
        "frame-src 'none'"
    );
  });

  it("gives the page no network path: connect-src names no host", () => {
    const d = directives(buildCellFrameCsp());
    expect(d.get("connect-src")).toBe("'none'");
    expect(d.get("default-src")).toBe("'none'");
    expect(d.get("form-action")).toBe("'none'");
    expect(d.get("frame-src")).toBe("'none'");
    expect(d.get("base-uri")).toBe("'none'");
  });

  it("never allows eval, a wildcard or a bare scheme as a script source", () => {
    const csp = buildCellFrameCsp();
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("*");
    const script = directives(csp).get("script-src")!.split(" ");
    for (const source of script) {
      expect(
        ["'unsafe-inline'"].includes(source) ||
          /^https:\/\/[a-z.]+$/.test(source)
      ).toBe(true);
    }
  });

  it("the sandbox grants scripts and nothing else", () => {
    expect(CELL_FRAME_SANDBOX).toBe("allow-scripts");
  });

  it("caps a page at 2 MB, measured in UTF-8 bytes", () => {
    expect(CELL_FRAME_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(htmlByteLength("abc")).toBe(3);
    expect(htmlByteLength("é")).toBe(2);
    expect(htmlByteLength("€")).toBe(3);
    expect(htmlByteLength("😀")).toBe(4);
  });
});

describe("wrapHtmlForFrame — the policy comes before any byte of the page", () => {
  const head = cellFrameHeadBlock();
  const META = '<meta http-equiv="Content-Security-Policy"';

  it("the head block opens with the policy meta, then the SDK", () => {
    expect(head.startsWith(META)).toBe(true);
    expect(head.indexOf("<script>")).toBeGreaterThan(head.indexOf(META));
    expect(head).toContain(`content="${buildCellFrameCsp()}"`);
  });

  it("a full document: only its doctype stays ahead of the policy", () => {
    const page =
      '<!DOCTYPE html>\n<html lang="en"><head><title>R</title><script>run()</script></head><body>Hi</body></html>';
    const out = wrapHtmlForFrame(page);
    expect(out.startsWith(`<!DOCTYPE html>${head}`)).toBe(true);
    expect(out.slice(`<!DOCTYPE html>${head}`.length)).toBe(
      page.slice("<!DOCTYPE html>".length)
    );
    expect(out.indexOf(META)).toBeLessThan(out.indexOf("run()"));
  });

  it("a page with no <head> (a fragment) still gets the policy first", () => {
    const out = wrapHtmlForFrame("<div>chart</div><script>draw()</script>");
    expect(out.startsWith(META)).toBe(true);
    expect(out.endsWith("<div>chart</div><script>draw()</script>")).toBe(true);
  });

  it("a decoy <head> in a comment cannot push the policy into the comment", () => {
    const out = wrapHtmlForFrame(
      "<!-- <head> --><html><head><script>x()</script></head></html>"
    );
    expect(out.startsWith(META)).toBe(true);
    expect(out.indexOf(META)).toBeLessThan(out.indexOf("<!--"));
  });

  it("a doctype is matched only at the very start (BOM and whitespace allowed)", () => {
    expect(
      wrapHtmlForFrame("\uFEFF  <!doctype html><p>a</p>").startsWith(
        `\uFEFF  <!doctype html>${META}`
      )
    ).toBe(true);
    // A doctype later in the page is the author's text, not a lead.
    expect(wrapHtmlForFrame("<p>a</p><!doctype html>").startsWith(META)).toBe(
      true
    );
  });
});

describe("the in-frame SDK", () => {
  it("is a script that parses, with no closing script tag or comment opener", () => {
    expect(() => new Function(CELL_BRIDGE_SDK)).not.toThrow();
    expect(CELL_BRIDGE_SDK.toLowerCase()).not.toContain("</script");
    expect(CELL_BRIDGE_SDK).not.toContain("<!--");
  });

  /** Runs the SDK against a fake frame window; returns its handles. */
  function boot() {
    const listeners: Array<(e: { source: unknown; data: unknown }) => void> =
      [];
    const posted: Array<{ msg: Record<string, unknown>; target: string }> = [];
    const parent = {
      postMessage: (msg: Record<string, unknown>, target: string) =>
        posted.push({ msg, target }),
    };
    const win: Record<string, unknown> = {
      parent,
      addEventListener: (
        type: string,
        fn: (e: { source: unknown; data: unknown }) => void
      ) => {
        if (type === "message") listeners.push(fn);
      },
    };
    new Function("window", CELL_BRIDGE_SDK)(win);
    const synap = win.synap as {
      bridge: string;
      ops: readonly string[];
      query: (op: string, params?: unknown) => Promise<unknown>;
      mutate: (op: string, payload?: unknown) => Promise<unknown>;
    };
    const deliver = (source: unknown, data: unknown) =>
      listeners.forEach((fn) => fn({ source, data }));
    return { synap, posted, parent, deliver };
  }

  it("query posts synap:query to the parent and resolves with the matching answer", async () => {
    const { synap, posted, parent, deliver } = boot();
    expect(synap.ops).toEqual(CELL_BRIDGE_READ_OP_NAMES);
    const answer = synap.query("entities.list", { profileSlug: "task" });
    expect(posted).toHaveLength(1);
    const { msg, target } = posted[0]!;
    expect(target).toBe("*");
    expect(msg).toMatchObject({
      type: "synap:query",
      operation: "entities.list",
      params: { profileSlug: "task" },
    });
    deliver(parent, {
      type: "synap:query:result",
      id: msg.id,
      data: { items: [1] },
    });
    await expect(answer).resolves.toEqual({ items: [1] });
  });

  it("an answer from anything but the parent is ignored", async () => {
    const { synap, posted, parent, deliver } = boot();
    const answer = synap.query("views.list");
    const id = posted[0]!.msg.id;
    deliver(
      { not: "the parent" },
      { type: "synap:query:result", id, data: "forged" }
    );
    deliver(parent, { type: "synap:query:result", id, data: "real" });
    await expect(answer).resolves.toBe("real");
  });

  it("an error answer rejects; a write is sent as synap:mutate and its refusal rejects", async () => {
    const { synap, posted, parent, deliver } = boot();
    const read = synap.query("entities.get", { id: "x" });
    deliver(parent, {
      type: "synap:query:result",
      id: posted[0]!.msg.id,
      error: "Not found",
    });
    await expect(read).rejects.toThrow("Not found");
    const write = synap.mutate("update_entity", { id: "x" });
    expect(posted[1]!.msg).toMatchObject({
      type: "synap:mutate",
      operation: "update_entity",
      payload: { id: "x" },
    });
    deliver(parent, {
      type: "synap:mutate:result",
      id: posted[1]!.msg.id,
      status: "denied",
      error: CELL_BRIDGE_WRITE_REFUSED,
    });
    await expect(write).rejects.toThrow(CELL_BRIDGE_WRITE_REFUSED);
  });
});

describe("the read allowlist", () => {
  it("is the desktop's view-frame reads plus documents.get, nothing more", () => {
    expect([...CELL_BRIDGE_READ_OP_NAMES].sort()).toEqual(
      [
        "entities.list",
        "entities.get",
        "views.list",
        "profiles.list",
        "lifecycle.board",
        "lifecycle.throughput",
        "attention.needsYou",
        "attention.count",
        "sessions.list",
        "lifecycle.home",
        "lifecycle.moving",
        "documents.get",
      ].sort()
    );
  });

  it("refuses writes, unknown ops and inherited names", () => {
    for (const op of [
      "entities.create",
      "update_entity",
      "documents.update",
      "toString",
      "__proto__",
      "",
      42,
      null,
    ]) {
      expect(isCellBridgeReadOp(op)).toBe(false);
    }
    for (const op of CELL_BRIDGE_READ_OP_NAMES)
      expect(isCellBridgeReadOp(op)).toBe(true);
  });

  it("no op lets the page choose its lens", () => {
    for (const params of Object.values(CELL_BRIDGE_READ_OPS) as ReadonlyArray<
      readonly string[]
    >) {
      expect(params).not.toContain("workspaceId");
      expect(params).not.toContain("projectId");
    }
  });

  it("pickBridgeParams keeps the op's own primitives and drops the rest", () => {
    expect(
      pickBridgeParams("entities.list", {
        profileSlug: "task",
        limit: 20,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        projectId: "p",
        offset: { $gt: 1 },
        includeDescendants: true,
        sneaky: "x",
      })
    ).toEqual({ profileSlug: "task", limit: 20, includeDescendants: true });
    expect(pickBridgeParams("lifecycle.home", { workspaceId: "w" })).toEqual(
      {}
    );
    expect(pickBridgeParams("entities.get", null)).toEqual({});
    expect(pickBridgeParams("entities.get", ["id"])).toEqual({});
    expect(pickBridgeParams("entities.get", { id: "x".repeat(201) })).toEqual(
      {}
    );
    expect(pickBridgeParams("entities.list", { limit: Number.NaN })).toEqual(
      {}
    );
  });
});

describe("parseCellBridgeMessage", () => {
  it("accepts a well-formed query and mutate", () => {
    expect(
      parseCellBridgeMessage({
        type: "synap:query",
        id: "a",
        operation: "views.list",
        params: { x: 1 },
      })
    ).toEqual({
      type: "synap:query",
      id: "a",
      operation: "views.list",
      params: { x: 1 },
    });
    expect(
      parseCellBridgeMessage({
        type: "synap:mutate",
        id: "b",
        operation: "create_entity",
        payload: 1,
      })
    ).toEqual({
      type: "synap:mutate",
      id: "b",
      operation: "create_entity",
      payload: 1,
    });
  });

  it("ignores anything else", () => {
    for (const data of [
      null,
      "synap:query",
      [],
      { type: "synap:ready" },
      { type: "synap:query", operation: "views.list" },
      { type: "synap:query", id: "", operation: "views.list" },
      { type: "synap:query", id: "x".repeat(101), operation: "views.list" },
      { type: "synap:query", id: "a", operation: 7 },
      { type: "synap:query", id: "a", operation: "" },
    ]) {
      expect(parseCellBridgeMessage(data)).toBeNull();
    }
  });
});

describe("narrowHomeToSpace", () => {
  const W = "w-1";
  const home = {
    spaces: [
      { workspaceId: W, name: "A" },
      { workspaceId: "w-2", name: "B" },
    ],
    needsYou: {
      total: 7,
      truncated: true,
      podLevel: 3,
      bySpace: [
        { workspaceId: W, count: 2, truncated: false },
        { workspaceId: "w-2", count: 5, truncated: true },
      ],
    },
    podWideSecret: 1,
  };

  it("keeps only the lens space, its own count and its own cap", () => {
    expect(narrowHomeToSpace(home, W)).toEqual({
      spaces: [{ workspaceId: W, name: "A" }],
      needsYou: {
        total: 2,
        truncated: false,
        bySpace: [{ workspaceId: W, count: 2, truncated: false }],
      },
    });
  });

  it("a known split without the space is zero; no split is unknown", () => {
    expect(narrowHomeToSpace(home, "w-9")).toMatchObject({
      spaces: [],
      needsYou: { total: 0, bySpace: [] },
    });
    expect(
      narrowHomeToSpace({ spaces: [], needsYou: { total: 4 } }, W)
    ).toMatchObject({ needsYou: { total: null } });
  });

  it("with no space lens the answer passes unchanged", () => {
    expect(narrowHomeToSpace(home, null)).toBe(home);
  });
});
