import { describe, expect, it } from "vitest";
import { FRAME_OPEN_KINDS } from "@synap-core/types/cell-bridge";
import {
  handleFrameLink,
  handleFrameOpen,
  type FrameLinkEnv,
} from "./html-frame-links";

const POD = "https://pod.example.live";
const CONSOLE = "https://pod-admin.example.live";
const FRAME = { id: "the-frame" };
const OTHER = { id: "some-other-window" };

function env(over: Partial<FrameLinkEnv> = {}) {
  const calls: string[] = [];
  const e: FrameLinkEnv = {
    ownOrigins: () => [CONSOLE, POD],
    activated: () => true,
    here: (href) => calls.push(`here ${href}`),
    newTab: (href) => calls.push(`tab ${href}`),
    confirmExternal: (l) => calls.push(`ask ${l.host} ${l.href}`),
    ...over,
  };
  return { e, calls };
}
const link = (href: string, newTab = false) => ({
  type: "synap:navigate",
  href,
  newTab,
});

describe("handleFrameLink — only THIS frame can ask the reader's browser to go somewhere", () => {
  it("a console object door opens in the reader's own tab", () => {
    const { e, calls } = env();
    const done = handleFrameLink(
      { source: FRAME, data: link(`${POD}/open/abc`) },
      FRAME,
      e
    );
    expect(done).toEqual({ action: "here", href: `${POD}/open/abc` });
    expect(calls).toEqual([`here ${POD}/open/abc`]);
  });

  it("an outside link opens nothing on the page's word: the console asks, naming the host, with the query and fragment cut (H2)", () => {
    const { e, calls } = env();
    const done = handleFrameLink(
      {
        source: FRAME,
        data: link("https://evil.example/a?d=%7B%22secret%22%7D#more"),
      },
      FRAME,
      e
    );
    expect(done).toEqual({
      action: "external",
      href: "https://evil.example/a",
      host: "evil.example",
    });
    expect(calls).toEqual(["ask evil.example https://evil.example/a"]);
  });

  it("a message from any other window is not the frame asking", () => {
    const { e, calls } = env();
    expect(
      handleFrameLink(
        { source: OTHER, data: link(`${POD}/open/abc`) },
        FRAME,
        e
      )
    ).toBeNull();
    expect(
      handleFrameLink({ source: null, data: link(`${POD}/open/abc`) }, FRAME, e)
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("with no frame mounted, nothing can match (a null source never equals a missing window)", () => {
    const { e, calls } = env();
    expect(
      handleFrameLink({ source: null, data: link(`${POD}/open/a`) }, null, e)
    ).toBeNull();
    expect(
      handleFrameLink(
        { source: undefined, data: link(`${POD}/open/a`) },
        undefined,
        e
      )
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a malformed or dangerous link from the frame is dropped, not followed", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,x",
      "https://pod.example.live@evil.example/open/a",
      "/open/a",
    ]) {
      const { e, calls } = env();
      expect(
        handleFrameLink({ source: FRAME, data: link(href) }, FRAME, e)
      ).toBeNull();
      expect(calls).toEqual([]);
    }
  });

  it("no recent activation: the page cannot open anything by posting the message on its own", () => {
    const { e, calls } = env({ activated: () => false });
    const done = handleFrameLink(
      { source: FRAME, data: link("https://example.com/a") },
      FRAME,
      e
    );
    expect(done).toEqual({ action: "ignore", reason: "not-activated" });
    handleFrameLink({ source: FRAME, data: link(`${POD}/open/a`) }, FRAME, e);
    expect(calls).toEqual([]);
  });

  it("an unknown activation still lets a console door open here, and opens no tab", () => {
    const { e, calls } = env({ activated: () => null });
    handleFrameLink({ source: FRAME, data: link(`${POD}/open/a`) }, FRAME, e);
    handleFrameLink(
      { source: FRAME, data: link("https://example.com/a") },
      FRAME,
      e
    );
    expect(calls).toEqual([`here ${POD}/open/a`]);
  });

  it("a console with no pod address knows only its own origin", () => {
    const { e, calls } = env({ ownOrigins: () => [CONSOLE] });
    handleFrameLink({ source: FRAME, data: link(`${POD}/open/a`) }, FRAME, e);
    handleFrameLink(
      { source: FRAME, data: link(`${CONSOLE}/open/a`) },
      FRAME,
      e
    );
    expect(calls).toEqual([
      `ask pod.example.live ${POD}/open/a`,
      `here ${CONSOLE}/open/a`,
    ]);
  });
});

describe("handleFrameOpen — a page asks to open an object, the console decides where", () => {
  const ID = "44444444-4444-4444-8444-444444444444";
  const open = (objectKind: string, objectId = ID, extra = {}) => ({
    type: "synap:surface:open",
    surface: { kind: "object", objectKind, objectId, ...extra },
  });

  it("opens the object's console page in the reader's own tab", () => {
    const { e, calls } = env();
    const done = handleFrameOpen(
      { source: FRAME, data: open("session") },
      FRAME,
      e
    );
    expect(done).toEqual({ action: "here", href: `/open/session/${ID}` });
    expect(calls).toEqual([`here /open/session/${ID}`]);
  });

  it("every kind a page may open has a console page (none is a dead door)", () => {
    for (const kind of FRAME_OPEN_KINDS) {
      const { e, calls } = env();
      const done = handleFrameOpen(
        { source: FRAME, data: open(kind) },
        FRAME,
        e
      );
      expect(done?.action, kind).toBe("here");
      // A console page, never an app link drawn in the reader's tab.
      expect(calls, kind).toEqual([
        expect.stringMatching(/^here \/(open\/[a-z]+|proposal)\//),
      ]);
    }
  });

  it("the page names the object, never the address: a url it adds is not followed", () => {
    const { e, calls } = env();
    handleFrameOpen(
      {
        source: FRAME,
        data: open("entity", ID, { url: "https://evil.example/" }),
      },
      FRAME,
      e
    );
    expect(calls).toEqual([`here /open/entity/${ID}`]);
  });

  it("only THIS frame may ask, and only for a kind and a uuid", () => {
    const { e, calls } = env();
    expect(
      handleFrameOpen({ source: OTHER, data: open("session") }, FRAME, e)
    ).toBe(null);
    expect(
      handleFrameOpen({ source: FRAME, data: open("session") }, null, e)
    ).toBe(null);
    expect(
      handleFrameOpen({ source: FRAME, data: open("capability") }, FRAME, e)
    ).toBe(null);
    expect(
      handleFrameOpen(
        { source: FRAME, data: open("session", "../x") },
        FRAME,
        e
      )
    ).toBe(null);
    expect(calls).toEqual([]);
  });

  it("no recent activation: a page cannot move the reader on its own", () => {
    const { e, calls } = env({ activated: () => false });
    expect(
      handleFrameOpen({ source: FRAME, data: open("session") }, FRAME, e)
    ).toEqual({ action: "ignore", reason: "not-activated" });
    expect(calls).toEqual([]);
  });

  it("a link message is not an open, and an open is not a link", () => {
    const { e, calls } = env();
    expect(
      handleFrameOpen(
        { source: FRAME, data: link(`${POD}/open/abc`) },
        FRAME,
        e
      )
    ).toBe(null);
    expect(
      handleFrameLink({ source: FRAME, data: open("session") }, FRAME, e)
    ).toBe(null);
    expect(calls).toEqual([]);
  });
});
