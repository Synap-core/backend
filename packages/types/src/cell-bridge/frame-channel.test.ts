/**
 * The reply channel (`frame-channel.ts`, security review H1): a host answers
 * the document that asked, on the port that document handed over, and never
 * the frame's window. Driven with a fake frame whose window outlives its
 * document, as a real `contentWindow` does when the page navigates its frame.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CELL_BRIDGE_SDK,
  CELL_FRAME_CHANNEL_SCRIPT,
  FRAME_CHANNEL_MAX_QUEUED,
  createCellBridgeHost,
  createCellFrameHost,
  postToFrame,
  resetFrameChannel,
  type CellBridgeEventLike,
  type CellBridgeTarget,
} from "./index.js";

/** A document: what reached it on its window, and on its port. */
interface FakeDocument {
  name: string;
  onWindow: unknown[];
  onPort: unknown[];
  port: { postMessage: (message: unknown) => void };
}

function fakeDocument(name: string): FakeDocument {
  const doc: FakeDocument = {
    name,
    onWindow: [],
    onPort: [],
    port: { postMessage: (message) => doc.onPort.push(message) },
  };
  return doc;
}

/**
 * One iframe: its `contentWindow` stays the same object while the document in
 * it changes. A post to the window reaches whichever document is there NOW.
 */
function fakeIframe() {
  let current = fakeDocument("page");
  const contentWindow: CellBridgeTarget = {
    postMessage: (message) => current.onWindow.push(message),
  };
  return {
    contentWindow,
    get document() {
      return current;
    },
    navigate(to: FakeDocument) {
      current = to;
    },
  };
}

const hello = (iframe: ReturnType<typeof fakeIframe>): CellBridgeEventLike => ({
  source: iframe.contentWindow,
  origin: "null",
  data: { type: "synap:hello" },
  ports: [iframe.document.port],
});

const query = (id: string) => ({
  type: "synap:query",
  id,
  operation: "entities.list",
  params: {},
});

const answers = (got: unknown[]) =>
  got.filter(
    (m) => (m as { type?: unknown }).type !== "synap:channel:ready"
  ) as Array<Record<string, unknown>>;

type MakeHost = (
  frameWindow: () => CellBridgeTarget | null,
  read: () => Promise<unknown>
) => (event: CellBridgeEventLike) => Promise<void>;

const HOSTS: Array<[string, MakeHost]> = [
  [
    "the page host",
    (frameWindow, read) => createCellBridgeHost({ frameWindow, read }),
  ],
  [
    "the module host",
    (frameWindow, read) =>
      createCellFrameHost({
        frameWindow,
        lens: { workspaceId: "11111111-1111-4111-8111-111111111111" },
        identity: {},
        init: () => ({ workspaceId: "" }),
        read,
      }),
  ],
];

describe.each(HOSTS)(
  "%s answers on the asking document's port only",
  (_, makeHost) => {
    it("a frame that navigated away while its reads ran receives nothing", async () => {
      const iframe = fakeIframe();
      const page = iframe.document;
      let finish: (data: unknown) => void = () => {};
      const host = makeHost(
        () => iframe.contentWindow,
        () => new Promise((resolve) => (finish = resolve))
      );

      await host(hello(iframe));
      const pending = host({
        source: iframe.contentWindow,
        origin: "null",
        data: query("q1"),
      });

      // The page sets `location`: another document now holds the frame, and
      // holds its `load` open so the host never sees it leave.
      const evil = fakeDocument("evil");
      iframe.navigate(evil);
      // It cannot ask (a real origin) …
      await host({
        source: iframe.contentWindow,
        origin: "https://evil.example",
        data: query("q2"),
      });
      finish({ items: [{ title: "the viewer's secret" }] });
      await pending;

      // … and it receives nothing of what the page asked for.
      expect(evil.onWindow).toEqual([]);
      expect(evil.onPort).toEqual([]);
      expect(page.onWindow).toEqual([]);
      // The answer went down the page's own port, which died with the page.
      expect(answers(page.onPort)).toEqual([
        {
          type: "synap:query:result",
          id: "q1",
          data: { items: [{ title: "the viewer's secret" }] },
        },
      ]);
    });

    it("a new document of ours says hello again and gets its own channel", async () => {
      const iframe = fakeIframe();
      const first = iframe.document;
      let finish: (data: unknown) => void = () => {};
      const host = makeHost(
        () => iframe.contentWindow,
        () => new Promise((resolve) => (finish = resolve))
      );
      await host(hello(iframe));
      const pending = host({
        source: iframe.contentWindow,
        origin: "null",
        data: query("q1"),
      });
      const second = fakeDocument("second");
      iframe.navigate(second);
      await host(hello(iframe));
      finish([]);
      await pending;
      // The first document's answer stays on the first port.
      expect(answers(first.onPort)).toHaveLength(1);
      expect(answers(second.onPort)).toEqual([]);
      expect(second.onPort).toEqual([{ type: "synap:channel:ready" }]);
    });

    it("an answer asked before the hello reached the host waits for it, never takes the window", async () => {
      const iframe = fakeIframe();
      const host = makeHost(
        () => iframe.contentWindow,
        async () => ["x"]
      );
      await host({
        source: iframe.contentWindow,
        origin: "null",
        data: query("q1"),
      });
      expect(iframe.document.onWindow).toEqual([]);
      await host(hello(iframe));
      expect(iframe.document.onPort).toEqual([
        { type: "synap:channel:ready" },
        { type: "synap:query:result", id: "q1", data: ["x"] },
      ]);
    });

    it("a hello from another window, or from a real origin, is not this frame's port", async () => {
      const iframe = fakeIframe();
      const stranger = fakeDocument("stranger");
      const host = makeHost(
        () => iframe.contentWindow,
        async () => ["x"]
      );
      await host({
        source: { postMessage: () => {} },
        origin: "null",
        data: { type: "synap:hello" },
        ports: [stranger.port],
      });
      await host({
        source: iframe.contentWindow,
        origin: "https://evil.example",
        data: { type: "synap:hello" },
        ports: [stranger.port],
      });
      await host({
        source: iframe.contentWindow,
        origin: "null",
        data: query("q1"),
      });
      expect(stranger.onPort).toEqual([]);
      expect(iframe.document.onWindow).toEqual([]);
    });
  }
);

describe("postToFrame: a host's own pushes", () => {
  it("go on the frame's port, wait for its hello, and are capped while they wait", () => {
    const iframe = fakeIframe();
    const host = createCellBridgeHost({
      frameWindow: () => iframe.contentWindow,
      read: async () => null,
    });
    for (let i = 0; i < FRAME_CHANNEL_MAX_QUEUED + 3; i += 1) {
      postToFrame(iframe.contentWindow, { type: "synap:theme", n: i });
    }
    expect(iframe.document.onWindow).toEqual([]);
    void host(hello(iframe));
    const got = answers(iframe.document.onPort);
    expect(got).toHaveLength(FRAME_CHANNEL_MAX_QUEUED);
    expect(got[0]).toEqual({ type: "synap:theme", n: 3 });
    postToFrame(iframe.contentWindow, { type: "synap:theme", n: "now" });
    expect(answers(iframe.document.onPort).at(-1)).toEqual({
      type: "synap:theme",
      n: "now",
    });
    expect(iframe.document.onWindow).toEqual([]);
  });
});

describe("resetFrameChannel: a new srcdoc in the same iframe", () => {
  it("the next pushes wait for the new document's hello, never take the old document's port", () => {
    const iframe = fakeIframe();
    const host = createCellBridgeHost({
      frameWindow: () => iframe.contentWindow,
      read: async () => null,
    });
    const old = iframe.document;
    void host(hello(iframe));
    // The host sets a new srcdoc: the old document is on its way out.
    resetFrameChannel(iframe.contentWindow);
    const next = fakeDocument("next");
    iframe.navigate(next);
    // Its load can come before its hello: the init waits.
    postToFrame(iframe.contentWindow, { type: "synap:init" });
    expect(answers(old.onPort)).toEqual([]);
    void host(hello(iframe));
    expect(answers(next.onPort)).toEqual([{ type: "synap:init" }]);
    expect(next.onWindow).toEqual([]);
  });
});

/**
 * Runs the frame half and an SDK against a fake frame window. Its parent is a
 * real host; a fake MessageChannel connects the two ends the way a real one
 * does (each end's `postMessage` reaches the other end's `onmessage`).
 */
function runFrame(scripts: string[], makeHost: MakeHost) {
  type Listener = (e: {
    source: unknown;
    data: unknown;
    origin?: string;
  }) => void;
  const listeners: Listener[] = [];
  const timers: Array<() => void> = [];
  const windowPosted: unknown[] = [];
  class FakePort {
    other: FakePort | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    postMessage(data: unknown) {
      this.other?.onmessage?.({ data });
    }
  }
  class FakeChannel {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      this.port1.other = this.port2;
      this.port2.other = this.port1;
    }
  }
  class FakeMessageEvent {
    data: unknown;
    origin: string;
    source: unknown;
    constructor(
      _type: string,
      init: { data: unknown; origin: string; source: unknown }
    ) {
      this.data = init.data;
      this.origin = init.origin;
      this.source = init.source;
    }
  }
  const frameWindow: CellBridgeTarget = {
    postMessage: (msg: unknown) => windowPosted.push(msg),
  };
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
  const win: Record<string, unknown> = {
    parent,
    MessageChannel: FakeChannel,
    MessageEvent: FakeMessageEvent,
    setTimeout: (fn: () => void) => timers.push(fn),
    addEventListener: (type: string, fn: Listener) => {
      if (type === "message") listeners.push(fn);
    },
    dispatchEvent: (e: FakeMessageEvent) => {
      listeners.forEach((fn) => fn(e));
      return true;
    },
    document: { documentElement: { setAttribute: () => {} } },
  };
  let host: (event: CellBridgeEventLike) => Promise<void> = async () => {};
  const read = vi.fn(async () => ({ items: ["one"] }));
  host = makeHost(() => frameWindow, read);
  for (const script of scripts)
    new Function("window", "document", script)(win, win.document);
  return { win, windowPosted, timers, listeners };
}

describe("the frame half (CELL_FRAME_CHANNEL_SCRIPT)", () => {
  it("never contains a closing script tag", () => {
    expect(CELL_FRAME_CHANNEL_SCRIPT).not.toMatch(/<\/script/i);
  });

  it("hands its port over at once; the page SDK's reads come back on it, as from the parent", async () => {
    const { win, windowPosted, timers } = runFrame(
      [CELL_FRAME_CHANNEL_SCRIPT, CELL_BRIDGE_SDK],
      HOSTS[0]![1]
    );
    const synap = win.synap as { query: (op: string) => Promise<unknown> };
    await expect(synap.query("entities.list")).resolves.toEqual({
      items: ["one"],
    });
    expect(windowPosted).toEqual([]);
    // The host said ready: the retry that was scheduled says nothing more.
    timers.splice(0).forEach((fn) => fn());
    expect(timers).toEqual([]);
  });

  it("says hello again while no host answered, and stops once one does", () => {
    let said = 0;
    const listeners: Array<(e: unknown) => void> = [];
    const timers: Array<() => void> = [];
    let lastPort: { postMessage: (m: unknown) => void } | null = null;
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
    const win: Record<string, unknown> = {
      parent: {
        postMessage: (
          msg: { type: string },
          target: string,
          transfer: Port[]
        ) => {
          expect(msg).toEqual({ type: "synap:hello" });
          expect(target).toBe("*");
          said += 1;
          lastPort = transfer[0]!;
        },
      },
      MessageChannel: Channel,
      MessageEvent: class {},
      setTimeout: (fn: () => void) => timers.push(fn),
      addEventListener: (_t: string, fn: (e: unknown) => void) =>
        listeners.push(fn),
      dispatchEvent: () => true,
    };
    new Function("window", CELL_FRAME_CHANNEL_SCRIPT)(win);
    expect(said).toBe(1);
    timers.shift()!();
    expect(said).toBe(2);
    lastPort!.postMessage({ type: "synap:channel:ready" });
    timers.shift()!();
    expect(said).toBe(2);
    expect(timers).toEqual([]);
  });
});
