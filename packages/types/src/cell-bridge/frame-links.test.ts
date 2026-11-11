import { describe, expect, it } from "vitest";
import {
  CELL_FRAME_LINK_DOOR,
  FRAME_NAVIGATE_TYPE,
  parseFrameNavigate,
  resolveFrameLink,
  type FrameNavigateMessage,
} from "./frame-links.js";
import { CELL_BRIDGE_SDK } from "./sdk.js";
import {
  buildCellFrameCsp,
  cellFrameHeadBlock,
  wrapHtmlForFrame,
} from "./frame.js";

const POD = "https://pod.example.live";
const CONSOLE = "https://pod-admin.example.live";
const OWN = [CONSOLE, POD];
const nav = (href: string, newTab = false): FrameNavigateMessage => ({
  type: FRAME_NAVIGATE_TYPE,
  href,
  newTab,
});

describe("parseFrameNavigate — a frame is stored code: only a plain http(s) address passes", () => {
  it("accepts an absolute http(s) link and normalises it", () => {
    expect(
      parseFrameNavigate({ type: "synap:navigate", href: `${POD}/open/a` })
    ).toEqual({
      type: "synap:navigate",
      href: `${POD}/open/a`,
      newTab: false,
    });
    expect(
      parseFrameNavigate({
        type: "synap:navigate",
        href: "HTTP://Example.COM",
        newTab: true,
      })
    ).toEqual({
      type: "synap:navigate",
      href: "http://example.com/",
      newTab: true,
    });
  });

  it("newTab is true only for the boolean true, never a truthy string", () => {
    for (const newTab of ["true", 1, {}, "yes"]) {
      expect(
        parseFrameNavigate({
          type: "synap:navigate",
          href: `${POD}/open/a`,
          newTab,
        })?.newTab
      ).toBe(false);
    }
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "file:///etc/passwd",
    "mailto:a@b.c",
    "blob:https://x/1",
    "about:blank",
    "//evil.example/open/a",
    "/open/a",
    "open/a",
    "",
  ])("refuses %s", (href) => {
    expect(parseFrameNavigate({ type: "synap:navigate", href })).toBeNull();
  });

  it("refuses credentials: https://pod@evil reads as the pod and goes elsewhere", () => {
    expect(
      parseFrameNavigate({
        type: "synap:navigate",
        href: "https://pod.example.live@evil.example/open/a",
      })
    ).toBeNull();
    expect(
      parseFrameNavigate({
        type: "synap:navigate",
        href: "https://u:p@pod.example.live/open/a",
      })
    ).toBeNull();
  });

  it("refuses an over-long address and anything that is not a link message", () => {
    expect(
      parseFrameNavigate({
        type: "synap:navigate",
        href: `${POD}/open/${"a".repeat(2100)}`,
      })
    ).toBeNull();
    expect(
      parseFrameNavigate({ type: "synap:query", href: `${POD}/open/a` })
    ).toBeNull();
    for (const bad of [
      null,
      undefined,
      "x",
      3,
      [],
      { href: `${POD}/open/a` },
    ]) {
      expect(parseFrameNavigate(bad)).toBeNull();
    }
    expect(parseFrameNavigate({ type: "synap:navigate", href: 7 })).toBeNull();
  });
});

describe("resolveFrameLink — where a clicked link goes", () => {
  const live = { ownOrigins: OWN, activated: true };

  it("a console object door opens in the reader's own tab", () => {
    expect(resolveFrameLink(nav(`${POD}/open/abc`), live)).toEqual({
      action: "here",
      href: `${POD}/open/abc`,
    });
    expect(
      resolveFrameLink(nav(`${CONSOLE}/open/view/abc?x=1#y`), live)
    ).toMatchObject({
      action: "here",
    });
  });

  it("the reader's own tab ONLY ever gets an /open door: any other path on our origins is a new tab", () => {
    for (const path of [
      "/api/files/x/url",
      "/trpc/x",
      "/login",
      "/",
      "/openx/a",
      "/opened",
    ]) {
      expect(resolveFrameLink(nav(`${POD}${path}`), live)).toEqual({
        action: "newTab",
        href: `${POD}${path}`,
      });
    }
  });

  it("a click that asked for a new tab gets one, even on an /open door", () => {
    expect(resolveFrameLink(nav(`${POD}/open/abc`, true), live).action).toBe(
      "newTab"
    );
  });

  it("anything outside our origins is a new tab, never the reader's tab", () => {
    expect(resolveFrameLink(nav("https://example.com/a"), live)).toEqual({
      action: "newTab",
      href: "https://example.com/a",
    });
  });

  it("origins are compared exactly: a look-alike host, another port or http for https is someone else", () => {
    for (const href of [
      "https://pod.example.live.evil.example/open/a",
      "https://evilpod.example.live/open/a",
      "https://pod.example.live:8443/open/a",
      "http://pod.example.live/open/a",
    ]) {
      expect(resolveFrameLink(nav(href), live).action).toBe("newTab");
    }
  });

  it("with no recent activation NOTHING opens: a page's script can post this message with no click", () => {
    const idle = { ownOrigins: OWN, activated: false };
    for (const href of [`${POD}/open/a`, "https://example.com/a"]) {
      expect(resolveFrameLink(nav(href), idle)).toEqual({
        action: "ignore",
        reason: "not-activated",
      });
    }
  });

  it("when the browser cannot say, the console's own door still opens but no tab does", () => {
    const unknown = { ownOrigins: OWN, activated: null };
    expect(resolveFrameLink(nav(`${POD}/open/a`), unknown).action).toBe("here");
    expect(resolveFrameLink(nav("https://example.com/a"), unknown).action).toBe(
      "ignore"
    );
    expect(resolveFrameLink(nav(`${POD}/open/a`, true), unknown).action).toBe(
      "ignore"
    );
  });

  it("with no known origins nothing is ours: every link is a new tab", () => {
    expect(
      resolveFrameLink(nav(`${POD}/open/a`), {
        ownOrigins: [],
        activated: true,
      }).action
    ).toBe("newTab");
  });
});

/** The door's script, run against a small fake DOM: the shipped code, not a copy. */
function runDoor() {
  const listeners: Record<
    string,
    { handler: (e: unknown) => void; capture: unknown }
  > = {};
  const posted: Array<{ message: unknown; origin: string }> = [];
  const win: Record<string, unknown> = {
    parent: {
      postMessage: (message: unknown, origin: string) =>
        posted.push({ message, origin }),
    },
  };
  const doc = {
    baseURI: "about:srcdoc",
    addEventListener: (
      type: string,
      handler: (e: unknown) => void,
      capture: unknown
    ) => {
      listeners[type] = { handler, capture };
    },
  };
  new Function("window", "document", "URL", CELL_FRAME_LINK_DOOR)(
    win,
    doc,
    URL
  );
  return { win, doc, listeners, posted };
}

function anchor(attrs: { href?: string; target?: string }, resolved: unknown) {
  return {
    getAttribute: (name: string) =>
      name === "href"
        ? (attrs.href ?? null)
        : name === "target"
          ? (attrs.target ?? null)
          : null,
    href: resolved,
  };
}

function click(
  a: ReturnType<typeof anchor> | null,
  over: Record<string, unknown> = {}
) {
  const event: Record<string, unknown> = {
    type: "click",
    button: 0,
    defaultPrevented: false,
    prevented: false,
    target: { closest: () => a },
    preventDefault() {
      event.defaultPrevented = true;
      event.prevented = true;
    },
    ...over,
  };
  return event;
}

describe("CELL_FRAME_LINK_DOOR — the in-frame half, run for real", () => {
  it("listens to click and middle-click in the capture phase, before the page can swallow them", () => {
    const { listeners } = runDoor();
    expect(Object.keys(listeners).sort()).toEqual(["auxclick", "click"]);
    expect(listeners.click?.capture).toBe(true);
    expect(listeners.auxclick?.capture).toBe(true);
  });

  it("an http(s) link does NOT navigate the frame: the click is cancelled and handed to the parent", () => {
    const { listeners, posted } = runDoor();
    const e = click(anchor({ href: `${POD}/open/a` }, `${POD}/open/a`));
    listeners.click!.handler(e);
    expect(e.prevented).toBe(true);
    expect(posted).toEqual([
      {
        message: {
          type: "synap:navigate",
          href: `${POD}/open/a`,
          newTab: false,
        },
        origin: "*",
      },
    ]);
  });

  it("an in-page #anchor jump stays in the page", () => {
    const { listeners, posted } = runDoor();
    const e = click(anchor({ href: "#section-2" }, "about:srcdoc#section-2"));
    listeners.click!.handler(e);
    expect(e.prevented).toBe(false);
    expect(posted).toEqual([]);
  });

  it("an in-page #anchor stays in the page even when the page's own address is http(s)", () => {
    // In a srcdoc frame `#x` resolves to `about:srcdoc#x`, which the http(s)
    // check skips anyway. The attribute test is what protects a host whose
    // page has an http(s) address: there `#x` resolves to a real URL, and
    // without it every jump inside the report would be handed to the host.
    const { listeners, posted } = runDoor();
    const e = click(
      anchor({ href: "#section-2" }, "https://reports.example/page#section-2")
    );
    listeners.click!.handler(e);
    expect(e.prevented).toBe(false);
    expect(posted).toEqual([]);
  });

  it.each([
    "javascript:void(0)",
    "mailto:a@b.c",
    "data:text/plain,hi",
    "tel:123",
  ])("%s is left exactly as it was", (href) => {
    const { listeners, posted } = runDoor();
    const e = click(anchor({ href }, href));
    listeners.click!.handler(e);
    expect(e.prevented).toBe(false);
    expect(posted).toEqual([]);
  });

  it("a click that is not on a link, or already handled by the page, is ignored", () => {
    const { listeners, posted } = runDoor();
    const none = click(null);
    listeners.click!.handler(none);
    const handled = click(anchor({ href: `${POD}/open/a` }, `${POD}/open/a`), {
      defaultPrevented: true,
    });
    listeners.click!.handler(handled);
    expect(none.prevented).toBe(false);
    expect(posted).toEqual([]);
  });

  it("middle button, a modifier or target=_blank ask for a new tab", () => {
    const href = `${POD}/open/a`;
    const cases: Array<[Record<string, unknown>, string?]> = [
      [{ type: "auxclick", button: 1 }],
      [{ ctrlKey: true }],
      [{ metaKey: true }],
      [{ shiftKey: true }],
      [{}, "_blank"],
    ];
    for (const [over, target] of cases) {
      const { listeners, posted } = runDoor();
      const type = (over.type as string) ?? "click";
      listeners[type]!.handler(click(anchor({ href, target }, href), over));
      expect((posted[0]?.message as { newTab: boolean }).newTab).toBe(true);
    }
  });

  it("an SVG link (href is an object) is resolved against the document, not dropped", () => {
    const { listeners, posted } = runDoor();
    listeners.click!.handler(
      click(
        anchor(
          { href: "https://example.com/x" },
          { baseVal: "https://example.com/x" }
        )
      )
    );
    expect((posted[0]?.message as { href: string }).href).toBe(
      "https://example.com/x"
    );
  });

  it("a parent that throws does not break the click handler, and the frame still does not navigate", () => {
    const { win, listeners } = runDoor();
    (win.parent as { postMessage: unknown }).postMessage = () => {
      throw new Error("detached");
    };
    const e = click(anchor({ href: `${POD}/open/a` }, `${POD}/open/a`));
    expect(() => listeners.click!.handler(e)).not.toThrow();
    expect(e.prevented).toBe(true);
  });

  it("is idempotent: injected twice, it listens once", () => {
    let count = 0;
    const win: Record<string, unknown> = { parent: { postMessage() {} } };
    const doc = {
      baseURI: "about:srcdoc",
      addEventListener: () => {
        count += 1;
      },
    };
    const run = () =>
      new Function("window", "document", "URL", CELL_FRAME_LINK_DOOR)(
        win,
        doc,
        URL
      );
    run();
    run();
    expect(count).toBe(2); // click + auxclick, once
  });

  it("is plain script in a string: no closing script tag, no comment opener", () => {
    expect(CELL_FRAME_LINK_DOOR.toLowerCase()).not.toContain("</script");
    expect(CELL_FRAME_LINK_DOOR).not.toContain("<!--");
    expect(() => new Function(CELL_FRAME_LINK_DOOR)).not.toThrow();
  });
});

describe("the door is OPT-IN: a host that never asked keeps its frame exactly as it was", () => {
  const META = `<meta http-equiv="Content-Security-Policy" content="${buildCellFrameCsp()}">`;

  it("the default head block is the policy and the SDK, and nothing about links", () => {
    const head = cellFrameHeadBlock();
    expect(head).toBe(`${META}<script>${CELL_BRIDGE_SDK}</script>`);
    expect(head).not.toContain("synap:navigate");
    expect(cellFrameHeadBlock({})).toBe(head);
    expect(cellFrameHeadBlock({ links: false })).toBe(head);
    expect(wrapHtmlForFrame("<p>a</p>")).toBe(`${head}<p>a</p>`);
  });

  it("asking for links adds the door AFTER the SDK and BEFORE the page", () => {
    const head = cellFrameHeadBlock({ links: true });
    expect(head).toBe(
      `${META}<script>${CELL_BRIDGE_SDK}</script><script>${CELL_FRAME_LINK_DOOR}</script>`
    );
    const out = wrapHtmlForFrame("<p>a</p><script>x()</script>", {
      links: true,
    });
    expect(out).toBe(`${head}<p>a</p><script>x()</script>`);
    expect(out.indexOf("synap:navigate")).toBeLessThan(out.indexOf("x()"));
  });

  it("the policy stays FIRST and a leading doctype stays ahead of it", () => {
    const out = wrapHtmlForFrame("<!DOCTYPE html><html><body>b</body></html>", {
      links: true,
    });
    expect(out.startsWith("<!DOCTYPE html>" + META)).toBe(true);
    expect(wrapHtmlForFrame("<p>a</p>", { links: true }).startsWith(META)).toBe(
      true
    );
  });

  it("the policy itself is unchanged: the door adds no source and loosens nothing", () => {
    expect(buildCellFrameCsp()).not.toMatch(/navigate|popup|top/i);
    expect(buildCellFrameCsp()).toContain("form-action 'none'");
  });
});
