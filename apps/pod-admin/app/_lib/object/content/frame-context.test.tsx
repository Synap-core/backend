/**
 * Pod admin's frames wear their project's brand and answer `context()`
 * (frame contract v3): the context read through `surfaces.context`
 * (`use-frame-context`), its brand CSS written after the console's tokens in
 * the page frame's srcdoc, and the module host answering `synap:context` and
 * carrying the context in `synap:init`.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SurfaceContext } from "@synap-core/types/cell-bridge";

const h = vi.hoisted(() => ({
  answer: { data: undefined, isError: false } as {
    data?: unknown;
    isError: boolean;
    error?: { message: string } | null;
  },
  asked: [] as unknown[],
}));

vi.mock("../../../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ client: {} }),
    surfaces: {
      context: {
        useQuery: (input: unknown, opts: { enabled: boolean }) => {
          if (opts.enabled) h.asked.push(input);
          return opts.enabled ? h.answer : { data: undefined, isError: false };
        },
      },
    },
  },
}));

import { HtmlFrame } from "./html-frame";
import { createModuleFrameHost } from "./module-frame";
import {
  frameBrandCss,
  frameContextAnswer,
  moduleFrameAnchor,
} from "./use-frame-context";

const DOC = "11111111-1111-4111-8111-111111111111";
const BRAND_CSS = ":root{--synap-primary:#0a7}";
const CONTEXT: SurfaceContext = {
  anchor: { kind: "document", id: DOC },
  workspaceId: "ws-1",
  projectId: "22222222-2222-4222-8222-222222222222",
  goalId: null,
  filters: {},
  brand: { id: "b-1", hash: "h-1", css: BRAND_CSS },
  locale: "en",
  theme: "light",
};

const srcdocOf = (markup: string): string => {
  const m = /<iframe\b[^>]*\ssrcdoc="([^"]*)"/i.exec(markup);
  return (m?.[1] ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
};

describe("the page frame wears its project's brand", () => {
  it("asks the pod for its document's context, and writes the brand into the frame's token style", () => {
    h.asked = [];
    h.answer = { data: CONTEXT, isError: false };
    const out = renderToStaticMarkup(
      <HtmlFrame
        html="<p>hello</p>"
        workspaceId="ws-1"
        title="Q3"
        anchor={{ kind: "document", id: DOC }}
      />
    );
    expect(h.asked).toEqual([
      expect.objectContaining({ kind: "document", id: DOC }),
    ]);
    const srcdoc = srcdocOf(out);
    expect(srcdoc).toContain(`<style data-synap-tokens>${BRAND_CSS}</style>`);
    expect(srcdoc.indexOf(BRAND_CSS)).toBeLessThan(srcdoc.indexOf("<p>hello"));
  });

  it("waits for the context before it runs the page, so the page runs once, in its brand", () => {
    h.answer = { data: undefined, isError: false };
    const out = renderToStaticMarkup(
      <HtmlFrame
        html="<p>hello</p>"
        workspaceId="ws-1"
        title="Q3"
        anchor={{ kind: "document", id: DOC }}
      />
    );
    expect(out).not.toContain("<iframe");
    expect(out).toContain('aria-busy="true"');
  });

  it("a failed context read still runs the page, in the console's tokens only", () => {
    h.answer = { isError: true, error: { message: "boom" } };
    const out = renderToStaticMarkup(
      <HtmlFrame
        html="<p>hello</p>"
        workspaceId="ws-1"
        title="Q3"
        anchor={{ kind: "document", id: DOC }}
      />
    );
    expect(srcdocOf(out)).not.toContain(BRAND_CSS);
  });

  it("with no anchor, asks nothing and wears no brand", () => {
    h.asked = [];
    h.answer = { data: CONTEXT, isError: false };
    const out = renderToStaticMarkup(
      <HtmlFrame html="<p>hello</p>" workspaceId="ws-1" title="Q3" />
    );
    expect(h.asked).toEqual([]);
    expect(srcdocOf(out)).not.toContain(BRAND_CSS);
  });
});

describe("the context's states, never folded", () => {
  it("ready answers the context; failed answers its error; none answers nothing", async () => {
    await expect(
      frameContextAnswer({ state: "ready", context: CONTEXT })!()
    ).resolves.toBe(CONTEXT);
    await expect(
      frameContextAnswer({ state: "failed", error: "boom" })!()
    ).rejects.toThrow("boom");
    expect(frameContextAnswer({ state: "none" })).toBeUndefined();
    expect(frameBrandCss({ state: "ready", context: CONTEXT })).toBe(BRAND_CSS);
    expect(frameBrandCss({ state: "failed", error: "x" })).toBe(null);
  });

  it("a module frame is anchored to the entity it draws, else its view", () => {
    expect(moduleFrameAnchor({ entityId: "e", viewId: "v" })).toEqual({
      kind: "entity",
      id: "e",
    });
    expect(moduleFrameAnchor({ viewId: "v" })).toEqual({
      kind: "view",
      id: "v",
    });
    expect(moduleFrameAnchor({})).toBe(null);
  });
});

describe("the module host carries the context", () => {
  function setup(
    context?: Parameters<typeof createModuleFrameHost>[0]["context"]
  ) {
    const posted: Array<Record<string, unknown>> = [];
    const frame = {
      postMessage: (m: unknown) => posted.push(m as Record<string, unknown>),
    };
    const onMessage = createModuleFrameHost({
      frameWindow: () => frame,
      client: {} as never,
      lens: { workspaceId: "ws-1" },
      identity: { entityId: "e-1" },
      theme: () => "dark",
      ...(context ? { context } : {}),
    });

    // The frame's document hands over its reply port first (`frame-channel.ts`
    // in the types leaf): every answer reaches it there, never on its window.
    void onMessage({
      source: frame,
      origin: "null",
      data: { type: "synap:hello" },
      ports: [
        {
          postMessage: (m: unknown) => {
            if ((m as { type?: unknown }).type !== "synap:channel:ready")
              frame.postMessage(m);
          },
        },
      ],
    });
    const send = (data: unknown) =>
      onMessage({ source: frame, origin: "null", data });
    return { posted, send };
  }

  it("synap:init carries the anchor, project, goal, filters and brand", async () => {
    const { posted, send } = setup({ value: CONTEXT });
    await send({ type: "synap:ready" });
    expect(posted[0]).toMatchObject({
      type: "synap:init",
      context: {
        workspaceId: "ws-1",
        anchor: CONTEXT.anchor,
        projectId: CONTEXT.projectId,
        goalId: null,
        brand: CONTEXT.brand,
      },
    });
  });

  it("synap:context is answered with the context", async () => {
    const { posted, send } = setup({
      value: CONTEXT,
      answer: async () => CONTEXT,
    });
    await send({ type: "synap:context", id: "c1" });
    expect(posted).toEqual([
      { type: "synap:context:result", id: "c1", data: CONTEXT },
    ]);
  });

  it("without a context, the frame reads that there is none", async () => {
    const { posted, send } = setup();
    await send({ type: "synap:context", id: "c1" });
    expect(posted[0]).toMatchObject({
      type: "synap:context:result",
      id: "c1",
      error: expect.any(String),
    });
  });
});
