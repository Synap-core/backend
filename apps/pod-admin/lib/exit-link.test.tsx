/**
 * "Open in app" stands alone; the download comes only after a click that did
 * not open the app (founder, 2026-10-27).
 *
 * pod-admin's vitest runs in node (no DOM), so the pieces are checked where
 * they can be: what `ExitLink` and `PlacedFallback` render (react-dom/server),
 * what the one door hands a renderer (`useAppOpenAttempt`, read through a
 * harness), and the open watch itself (`watchAppOpen`) with fake timers and
 * plain `EventTarget`s standing in for `window` and `document`.
 *
 * Not covered here: the click → state → re-render step inside the hook (no
 * DOM to click), and whether real browsers raise `blur` / `visibilitychange`
 * when the OS hands `synap://` to the app. The latter needs a person with and
 * without the app installed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));

import {
  APP_OPEN_WAIT_MS,
  ExitLink,
  NotOpenedOffer,
  PlacedFallback,
  useAppOpenAttempt,
  watchAppOpen,
} from "./exit-link";
import {
  DESKTOP_NOT_OPENED_NOTE,
  MOBILE_FALLBACK,
  PHONE_UNAVAILABLE_NOTE,
  openIn,
  placeExit,
  type PlacedExit,
} from "./open-in";

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const DOWNLOAD = "https://www.synap.live/download/browser";
const SPACE = openIn({ kind: "object", objectKind: "workspace", id: ID });
const SESSION_IN_APP = openIn({
  kind: "objectInApp",
  objectKind: "session",
  id: ID,
});

/** Stand-ins for `window` / `document`; `visibilityState` writable to flip it. */
function signals(): {
  win: EventTarget;
  doc: EventTarget & { visibilityState: DocumentVisibilityState };
} {
  return {
    win: new EventTarget(),
    doc: Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    }),
  };
}

describe("desktop: Open in app stands alone at rest", () => {
  it("renders the synap:// link and no download beside it", () => {
    const html = renderToStaticMarkup(
      <ExitLink exit={SPACE} label="Open in app" />
    );
    expect(html).toContain(`href="synap://open/workspace/${ID}"`);
    expect(html).toContain("Open in app");
    expect(html).not.toContain("/download/browser");
    expect(html).not.toContain("Get the desktop app");
    expect(html).not.toContain(DESKTOP_NOT_OPENED_NOTE);
  });

  it("holds the download back for after a failed open, never at rest", () => {
    const placed = placeExit(SPACE, false, "admin");
    expect(placed.fallback).toBeUndefined();
    expect(placed.ifNotOpened?.href).toBe(DOWNLOAD);
    expect(renderToStaticMarkup(<PlacedFallback placed={placed} />)).toBe("");
  });

  it("hands the anchor a click handler, and nothing to show yet", () => {
    let got: ReturnType<typeof useAppOpenAttempt> | undefined;
    function Harness({ placed }: { placed: PlacedExit }) {
      got = useAppOpenAttempt(placed);
      return null;
    }
    renderToStaticMarkup(<Harness placed={placeExit(SPACE, false, "admin")} />);
    expect(typeof got?.onOpen).toBe("function");
    expect(got?.offer).toBeNull();
  });
});

describe("the offer, once a click did not open the app", () => {
  it("says Synap didn't open and links the download", () => {
    const placed = placeExit(SPACE, false, "admin");
    const html = renderToStaticMarkup(
      <NotOpenedOffer hatch={placed.ifNotOpened!} />
    );
    expect(html).toContain(DESKTOP_NOT_OPENED_NOTE);
    expect(html).toContain(`href="${DOWNLOAD}"`);
    expect(html).toContain("Get the desktop app");
    expect(html).toContain('role="status"');
  });
});

describe("watchAppOpen — did the app take the hand-off?", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("offers the download when nothing happened within the wait", () => {
    const onNotOpened = vi.fn();
    watchAppOpen(signals(), onNotOpened);
    vi.advanceTimersByTime(APP_OPEN_WAIT_MS - 1);
    expect(onNotOpened).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onNotOpened).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(APP_OPEN_WAIT_MS * 4);
    expect(onNotOpened).toHaveBeenCalledTimes(1);
  });

  it("offers nothing when the page lost focus (the app or the OS prompt took it)", () => {
    const s = signals();
    const onNotOpened = vi.fn();
    watchAppOpen(s, onNotOpened);
    vi.advanceTimersByTime(300);
    s.win.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(APP_OPEN_WAIT_MS * 2);
    expect(onNotOpened).not.toHaveBeenCalled();
  });

  it("offers nothing when the page was hidden", () => {
    const s = signals();
    const onNotOpened = vi.fn();
    watchAppOpen(s, onNotOpened);
    s.doc.visibilityState = "hidden";
    s.doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(APP_OPEN_WAIT_MS * 2);
    expect(onNotOpened).not.toHaveBeenCalled();
  });

  it("ignores a visibilitychange that leaves the page visible", () => {
    const s = signals();
    const onNotOpened = vi.fn();
    watchAppOpen(s, onNotOpened);
    s.doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(APP_OPEN_WAIT_MS);
    expect(onNotOpened).toHaveBeenCalledTimes(1);
  });

  it("offers nothing when the page unloaded, or the watch was cancelled", () => {
    const s = signals();
    const a = vi.fn();
    watchAppOpen(s, a);
    s.win.dispatchEvent(new Event("pagehide"));
    const b = vi.fn();
    const cancel = watchAppOpen(signals(), b);
    cancel();
    vi.advanceTimersByTime(APP_OPEN_WAIT_MS * 2);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });
});

describe("phone: unchanged", () => {
  it("keeps the mobile app's install hatch beside a link Relay opens", () => {
    const placed = placeExit(SESSION_IN_APP, true, "member");
    const html = renderToStaticMarkup(<PlacedFallback placed={placed} />);
    expect(html).toContain(`href="${MOBILE_FALLBACK.href}"`);
    expect(html).toContain(MOBILE_FALLBACK.label);
    expect(placed.ifNotOpened).toBeUndefined();
  });

  it("keeps 'open this on your computer' with the console page that covers it", () => {
    const placed = placeExit(SPACE, true, "admin");
    const html = renderToStaticMarkup(<PlacedFallback placed={placed} />);
    expect(html).toContain(PHONE_UNAVAILABLE_NOTE);
    expect(html).toContain(`href="/workspaces/${ID}"`);
    expect(html).not.toContain("/download/browser");
  });

  it("never arms the desktop offer on a phone or for a web exit", () => {
    const results: Array<ReturnType<typeof useAppOpenAttempt>> = [];
    function Harness({ placed }: { placed: PlacedExit }) {
      results.push(useAppOpenAttempt(placed));
      return null;
    }
    const web = openIn({ kind: "object", objectKind: "proposal", id: ID });
    for (const placed of [
      placeExit(SESSION_IN_APP, true, "member"),
      placeExit(SPACE, true, "admin"),
      placeExit(web, false, "admin"),
    ]) {
      renderToStaticMarkup(<Harness placed={placed} />);
    }
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.onOpen).toBeUndefined();
      expect(r.offer).toBeNull();
    }
  });
});
