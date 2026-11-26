/**
 * The slide door: a host presents a stored page as a deck. The SDK is run
 * against a fake frame (a window, a document and its `data-slide` elements),
 * the way `cell-bridge.test.ts` runs it for reads.
 */
import { describe, expect, it } from "vitest";
import {
  CELL_BRIDGE_SDK,
  FRAME_SLIDE_CHANGED_TYPE,
  FRAME_SLIDE_GOTO_TYPE,
  frameSlideGoto,
  parseFrameSlideChanged,
} from "./index.js";

class FakeElement {
  attrs: Record<string, string>;
  scrolled = 0;
  children: FakeElement[] = [];
  id = "";
  textContent = "";
  constructor(attrs: Record<string, string> = {}) {
    this.attrs = { ...attrs };
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name]! : null;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  removeAttribute(name: string) {
    delete this.attrs[name];
  }
  hasAttribute(name: string) {
    return name in this.attrs;
  }
  scrollIntoView() {
    this.scrolled += 1;
  }
  appendChild(child: FakeElement) {
    this.children.push(child);
  }
}

type Listener = (e: Record<string, unknown>) => void;

/** Boots the SDK in a frame whose page holds these elements, in document order. */
function boot(elements: Array<Record<string, string>>) {
  const nodes = elements.map((a) => new FakeElement(a));
  const head = new FakeElement();
  const root = new FakeElement();
  const document = {
    head,
    documentElement: root,
    querySelectorAll: (selector: string) => {
      expect(selector).toBe("[data-slide]");
      return nodes.filter((n) => n.hasAttribute("data-slide"));
    },
    createElement: () => new FakeElement(),
    getElementById: (id: string) => head.children.find((c) => c.id === id) ?? null,
  };
  const listeners: Record<string, Listener[]> = {};
  const posted: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (msg: Record<string, unknown>) => posted.push(msg) };
  const win = {
    parent,
    document,
    addEventListener: (type: string, fn: Listener) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  new Function("window", CELL_BRIDGE_SDK)(win);
  const fromParent = (data: unknown) =>
    (listeners.message ?? []).forEach((fn) => fn({ source: parent, data }));
  const key = (k: string, target: Record<string, unknown> = { tagName: "BODY" }) => {
    const event = {
      key: k,
      target,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    (listeners.keydown ?? []).forEach((fn) => fn(event));
    return event;
  };
  const current = () =>
    nodes.findIndex((n) => n.hasAttribute("data-synap-slide-current"));
  return { nodes, root, head, posted, parent, listeners, fromParent, key, current };
}

const DECK = [
  { "data-slide": "", "data-block-id": "intro" },
  { "data-block-id": "not-a-slide" },
  { "data-slide": "market" },
  { "data-slide": "" },
];

describe("the slide door: the SDK presents a page's data-slide elements", () => {
  it("goto shows that slide alone, scrolls to it and answers changed with its id, index and total", () => {
    const f = boot(DECK);
    f.fromParent(frameSlideGoto("market", 0));
    expect(f.root.hasAttribute("data-synap-presenting")).toBe(true);
    expect(f.current()).toBe(2);
    expect(f.nodes[2]!.scrolled).toBe(1);
    expect(f.posted).toEqual([
      { type: FRAME_SLIDE_CHANGED_TYPE, slideId: "market", index: 1, total: 3 },
    ]);
    // The hiding rule is written once, into the head.
    expect(f.head.children).toHaveLength(1);
    expect(f.head.children[0]!.textContent).toContain(
      "html[data-synap-presenting] [data-slide]:not([data-synap-slide-current])"
    );
    expect(f.head.children[0]!.textContent).toContain("@media print");
  });

  it("names slides by the manifest's rule: data-block-id, else the data-slide value, else slide-<n> from 1", () => {
    const f = boot(DECK);
    f.fromParent(frameSlideGoto("intro", 9));
    f.fromParent(frameSlideGoto("slide-3", 9));
    expect(f.posted.map((m) => m.slideId)).toEqual(["intro", "slide-3"]);
    expect(f.posted.map((m) => m.index)).toEqual([0, 2]);
    expect(f.head.children).toHaveLength(1);
  });

  it("an unknown id falls back to the index; neither: nothing moves and nothing is said", () => {
    const f = boot(DECK);
    f.fromParent(frameSlideGoto("gone", 2));
    expect(f.current()).toBe(3);
    f.fromParent(frameSlideGoto("gone", 7));
    expect(f.current()).toBe(3);
    expect(f.posted).toHaveLength(1);
  });

  it("a goto from anything but the parent is ignored", () => {
    const f = boot(DECK);
    (f.listeners.message ?? []).forEach((fn) =>
      fn({ source: { not: "the parent" }, data: frameSlideGoto("market", 1) })
    );
    expect(f.current()).toBe(-1);
    expect(f.posted).toEqual([]);
  });

  it("while presenting, the keys inside the frame move the deck and report it; never past an end, never from a field", () => {
    const f = boot(DECK);
    // Not presenting yet: the page keeps its keys.
    expect(f.key("ArrowRight").defaultPrevented).toBe(false);
    f.fromParent(frameSlideGoto("intro", 0));
    expect(f.key("ArrowRight").defaultPrevented).toBe(true);
    expect(f.current()).toBe(2);
    f.key(" ");
    expect(f.current()).toBe(3);
    f.key("PageDown");
    expect(f.current()).toBe(3);
    f.key("ArrowLeft");
    expect(f.current()).toBe(2);
    f.key("ArrowLeft", { tagName: "INPUT" });
    expect(f.current()).toBe(2);
    expect(f.posted.map((m) => m.index)).toEqual([0, 1, 2, 1]);
  });

  it("a page with no slide answers nothing", () => {
    const f = boot([{ "data-block-id": "a" }]);
    f.fromParent({ type: FRAME_SLIDE_GOTO_TYPE, slideId: "a", index: 0 });
    expect(f.posted).toEqual([]);
    expect(f.root.hasAttribute("data-synap-presenting")).toBe(false);
  });
});

describe("parseFrameSlideChanged: the host trusts no frame", () => {
  const ok = { type: FRAME_SLIDE_CHANGED_TYPE, slideId: "s", index: 1, total: 2 };
  it("keeps a well-formed report", () => {
    expect(parseFrameSlideChanged({ ...ok, extra: "dropped" })).toEqual(ok);
  });
  it.each([
    ["another type", { ...ok, type: "synap:query" }],
    ["no id", { ...ok, slideId: "" }],
    ["a long id", { ...ok, slideId: "x".repeat(201) }],
    ["an index past the deck", { ...ok, index: 2 }],
    ["a negative index", { ...ok, index: -1 }],
    ["a fractional index", { ...ok, index: 0.5 }],
    ["an empty deck", { ...ok, index: 0, total: 0 }],
    ["not an object", "synap:slide:changed"],
  ])("drops %s", (_label, data) => {
    expect(parseFrameSlideChanged(data)).toBeNull();
  });
});
