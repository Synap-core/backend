import { describe, expect, it } from "vitest";
import { handleFrameLink, type FrameLinkEnv } from "./html-frame-links";

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

  it("an outside link opens a new tab and never replaces the console's", () => {
    const { e, calls } = env();
    handleFrameLink(
      { source: FRAME, data: link("https://example.com/a") },
      FRAME,
      e
    );
    expect(calls).toEqual(["tab https://example.com/a"]);
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
    expect(calls).toEqual([`tab ${POD}/open/a`, `here ${CONSOLE}/open/a`]);
  });
});
