/**
 * Frame contract v3: what a frame is about, and the brand it draws in
 * (`surface-context.ts`). A page asks with `window.synap.context()`; the page
 * host and the module host answer with the host's context, through the one
 * parser; the brand's CSS comes after the host's tokens in every frame.
 */
import { describe, expect, it } from "vitest";
import {
  CELL_BRIDGE_SDK,
  CELL_FRAME_CHANNEL_SCRIPT,
  FRAME_NO_CONTEXT,
  SYNAP_WIDGET_SDK,
  brandFrameCss,
  buildCellModuleFrameSrcdoc,
  cellFrameHeadBlock,
  createCellBridgeHost,
  createCellFrameHost,
  frameTokensWithBrand,
  parseCellBridgeMessage,
  parseCellFrameMessage,
  parseSurfaceContext,
  surfaceContextInitFields,
  wrapHtmlForFrame,
  type CellBridgeTarget,
  type SurfaceContext,
} from "./index.js";

const ANCHOR_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const CONTEXT: SurfaceContext = {
  anchor: { kind: "entity", id: ANCHOR_ID },
  workspaceId: "33333333-3333-4333-8333-333333333333",
  projectId: PROJECT_ID,
  goalId: null,
  filters: { status: "open" },
  brand: {
    id: "44444444-4444-4444-8444-444444444444",
    hash: "abc123",
    css: ":root{--synap-primary:#0a7}",
  },
  locale: "fr",
  theme: "light",
};

/**
 * Runs an in-frame SDK against a fake frame window whose parent is a real
 * host: the reply channel's frame half runs first, as in every real frame
 * (`CELL_FRAME_CHANNEL_SCRIPT`), so every message the frame posts goes to
 * `host`, and every answer comes back on the frame's port, re-dispatched to
 * its listeners as from its parent.
 */
function wire(
  sdk: string,
  makeHost: (
    frameWindow: () => CellBridgeTarget
  ) => (event: {
    source: unknown;
    origin: string;
    data: unknown;
    ports?: ReadonlyArray<unknown>;
  }) => Promise<void>
) {
  const listeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
  class Port {
    other: Port | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    postMessage(data: unknown) {
      this.other?.onmessage?.({ data });
    }
  }
  class Channel {
    port1 = new Port();
    port2 = new Port();
    constructor() {
      this.port1.other = this.port2;
      this.port2.other = this.port1;
    }
  }
  class Message {
    data: unknown;
    source: unknown;
    constructor(_t: string, init: { data: unknown; source: unknown }) {
      this.data = init.data;
      this.source = init.source;
    }
  }
  const parent = {
    postMessage: (msg: unknown, _target: string, transfer?: unknown[]) => {
      void host({
        source: frameWindow,
        origin: "null",
        data: msg,
        ports: transfer ?? [],
      });
    },
  };
  // Nothing may reach the frame on its window: answers ride the port.
  const frameWindow: CellBridgeTarget = {
    postMessage: () => {
      throw new Error("a host posted to the frame's window");
    },
  };
  const host = makeHost(() => frameWindow);
  const win: Record<string, unknown> = {
    parent,
    MessageChannel: Channel,
    MessageEvent: Message,
    setTimeout: () => {},
    addEventListener: (
      type: string,
      fn: (e: { source: unknown; data: unknown }) => void
    ) => {
      if (type === "message") listeners.push(fn);
    },
    dispatchEvent: (e: { source: unknown; data: unknown }) => {
      listeners.forEach((fn) => fn(e));
      return true;
    },
    // SYNAP_WIDGET_SDK posts through `window.parent.postMessage`.
    document: { documentElement: { setAttribute: () => {} } },
  };
  for (const script of [CELL_FRAME_CHANNEL_SCRIPT, sdk])
    new Function("window", "document", script)(win, win.document);
  return win;
}

describe("window.synap.context(): a page asks the host where it is", () => {
  it("round-trips through the page host: the page gets the host's context", async () => {
    const win = wire(CELL_BRIDGE_SDK, (frameWindow) =>
      createCellBridgeHost({
        frameWindow,
        read: async () => null,
        context: async () => CONTEXT,
      })
    );
    const synap = win.synap as { context: () => Promise<unknown> };
    await expect(synap.context()).resolves.toEqual(CONTEXT);
  });

  it("a host that gives no context answers an error, never an empty context", async () => {
    const win = wire(CELL_BRIDGE_SDK, (frameWindow) =>
      createCellBridgeHost({ frameWindow, read: async () => null })
    );
    const synap = win.synap as { context: () => Promise<unknown> };
    await expect(synap.context()).rejects.toThrow(FRAME_NO_CONTEXT);
  });

  it("a failed context read is the page's error, in the host's words", async () => {
    const win = wire(CELL_BRIDGE_SDK, (frameWindow) =>
      createCellBridgeHost({
        frameWindow,
        read: async () => null,
        context: async () => {
          throw new Error("The pod could not read the anchor.");
        },
      })
    );
    const synap = win.synap as { context: () => Promise<unknown> };
    await expect(synap.context()).rejects.toThrow(
      "The pod could not read the anchor."
    );
  });

  it("the page gets only the contract's fields, never what else the host held", async () => {
    const win = wire(CELL_BRIDGE_SDK, (frameWindow) =>
      createCellBridgeHost({
        frameWindow,
        read: async () => null,
        context: async () =>
          ({ ...CONTEXT, token: "secret", podUrl: "https://pod" }) as never,
      })
    );
    const synap = win.synap as { context: () => Promise<unknown> };
    const got = (await synap.context()) as Record<string, unknown>;
    expect(got).toEqual(CONTEXT);
    expect(got).not.toHaveProperty("token");
  });

  it("a module frame asks through window.synap.context(); SynapWidget is the same object (its old name)", async () => {
    const win = wire(SYNAP_WIDGET_SDK, (frameWindow) =>
      createCellFrameHost({
        frameWindow,
        lens: { workspaceId: CONTEXT.workspaceId },
        identity: {},
        init: () => ({ workspaceId: CONTEXT.workspaceId! }),
        context: () => CONTEXT,
      })
    );
    const synap = win.synap as { context: () => Promise<unknown> };
    await expect(synap.context()).resolves.toEqual(CONTEXT);
    expect(win.SynapWidget).toBe(win.synap);
  });

  it("the message parses on both hosts' parsers; a context ask without an id is not ours", () => {
    expect(parseCellBridgeMessage({ type: "synap:context", id: "c1" })).toEqual(
      { type: "synap:context", id: "c1" }
    );
    expect(parseCellFrameMessage({ type: "synap:context", id: "c1" })).toEqual({
      type: "synap:context",
      id: "c1",
    });
    expect(parseCellBridgeMessage({ type: "synap:context" })).toBe(null);
    expect(parseCellFrameMessage({ type: "synap:context", id: "" })).toBe(null);
  });
});

describe("parseSurfaceContext", () => {
  it("keeps the contract's fields and drops everything else", () => {
    expect(parseSurfaceContext({ ...CONTEXT, extra: 1 })).toEqual(CONTEXT);
  });

  it("no anchor, no project, no brand is a context (nulls), not a failure", () => {
    expect(
      parseSurfaceContext({
        anchor: null,
        workspaceId: null,
        projectId: null,
        goalId: null,
        filters: {},
        brand: null,
        locale: "en",
        theme: "dark",
      })
    ).toEqual({
      anchor: null,
      workspaceId: null,
      projectId: null,
      goalId: null,
      filters: {},
      brand: null,
      locale: "en",
      theme: "dark",
    });
  });

  it("refuses a malformed anchor, id or brand", () => {
    expect(parseSurfaceContext(null)).toBe(null);
    expect(
      parseSurfaceContext({ ...CONTEXT, anchor: { kind: "entity" } })
    ).toBe(null);
    expect(parseSurfaceContext({ ...CONTEXT, projectId: 42 })).toBe(null);
    expect(
      parseSurfaceContext({ ...CONTEXT, brand: { id: "b", hash: "h" } })
    ).toBe(null);
    expect(
      parseSurfaceContext({
        ...CONTEXT,
        brand: { ...CONTEXT.brand, css: "x".repeat(70_000) },
      })
    ).toBe(null);
  });

  it("the init fields of a module frame are the context's anchor, project, goal, filters and brand", () => {
    expect(surfaceContextInitFields(CONTEXT)).toEqual({
      anchor: CONTEXT.anchor,
      projectId: PROJECT_ID,
      goalId: null,
      filters: { status: "open" },
      brand: CONTEXT.brand,
    });
  });
});

describe("the brand in the frame: after the host's tokens, in every frame", () => {
  const HOST = ":root{--synap-primary:#111;--synap-color:#eee}";
  const BRAND = ":root{--synap-primary:#0a7}";

  it("frameTokensWithBrand writes the host's tokens, then the brand's", () => {
    const css = frameTokensWithBrand(HOST, BRAND);
    expect(css.indexOf(HOST)).toBe(0);
    expect(css.indexOf(BRAND)).toBeGreaterThan(css.indexOf(HOST));
    expect(frameTokensWithBrand(HOST, null)).toBe(HOST);
    expect(frameTokensWithBrand(HOST, "  ")).toBe(HOST);
  });

  it("a page frame: the brand follows the host's tokens in the one token style", () => {
    const out = wrapHtmlForFrame("<p>a</p>", { tokens: HOST, brand: BRAND });
    const style = /<style data-synap-tokens>([\s\S]*?)<\/style>/.exec(out);
    expect(style?.[1]).toBe(`${HOST}\n${BRAND}`);
    expect(out.indexOf(BRAND)).toBeLessThan(out.indexOf("<script>"));
  });

  it("a page frame with a brand and no host tokens still wears the brand", () => {
    expect(cellFrameHeadBlock({ brand: BRAND })).toContain(
      `<style data-synap-tokens>${BRAND}</style>`
    );
  });

  it("brand CSS cannot end its element", () => {
    const head = cellFrameHeadBlock({
      tokens: HOST,
      brand: ":root{--synap-primary:red}</style><script>x()",
    });
    expect(head.match(/<\/style>/g)).toHaveLength(1);
  });

  it("a module frame: the brand follows the host's tokens in the first style", () => {
    const srcdoc = buildCellModuleFrameSrcdoc({
      code: "export default 1",
      language: "module",
      theme: "dark",
      hostModules: { tokensCss: HOST },
      brandCss: BRAND,
    });
    const first = /<style>\n([\s\S]*?)\n<\/style>/.exec(srcdoc);
    expect(first?.[1]).toBe(`${HOST}\n${BRAND}`);
  });

  it("brandFrameCss: both modes on :root at the asked theme, each mode on its marker", () => {
    const decls = {
      vars: { "--synap-font-heading": "Inter, sans-serif" },
      light: { "--synap-primary": "#0a7" },
      dark: { "--synap-primary": "#3c9" },
    };
    expect(brandFrameCss(decls, "light")).toBe(
      [
        ":root{--synap-font-heading:Inter, sans-serif;--synap-primary:#0a7}",
        ':root[data-theme="light"]{--synap-primary:#0a7}',
        ':root[data-theme="dark"]{--synap-primary:#3c9}',
      ].join("\n")
    );
    expect(brandFrameCss(decls, "dark").split("\n")[0]).toBe(
      ":root{--synap-font-heading:Inter, sans-serif;--synap-primary:#3c9}"
    );
  });

  it("brandFrameCss: only --synap-* names, no value that leaves its declaration, empty when nothing is set", () => {
    const css = brandFrameCss(
      {
        vars: {
          "--synap-primary": "red;}body{display:none",
          "--other": "blue",
          "--synap-ok": "green",
          "--synap-x</style>": "1px",
        },
        light: {},
        dark: {},
      },
      "dark"
    );
    expect(css).toBe(":root{--synap-ok:green}");
    expect(brandFrameCss({ vars: {}, light: {}, dark: {} }, "dark")).toBe("");
  });
});
