"use client";

/**
 * `ExitLink` — the ONE way to render an `Exit` from `openIn()`.
 *
 * `open-in.ts` resolves WHERE an exit goes; this renders it. They were split
 * for one commit and the rule immediately rotted: seven call sites each
 * hand-rolled "primary link + optional fallback link", and every copy got
 * something different wrong — four different opacities (two of them at 2.2:1
 * and 2.5:1 contrast), focus rings on one of four, `target="_blank"` applied
 * to pod-admin's OWN routes, and one list repeating the fallback once per row.
 *
 * An invariant enforced by seven independent re-implementations is not
 * enforced. So the fallback is not something a caller remembers to render —
 * it is structural here, and `__tripwires__/exit-door.test.ts` pins that no
 * one goes back to hand-rolling it.
 *
 * On a desktop, "Open in app" stands ALONE (founder, 2026-10-27: no "Get the
 * desktop app" beside it). The download is offered only when a click on the
 * `synap://` link did not open the app, in the same place, by
 * `useAppOpenAttempt` — the one door every renderer of a desktop link
 * (`ExitLink`, rows built from `rowHref`, `HandoffCard`) goes through.
 *
 * The same holds for the DEVICE. On a phone `synap://` opens the mobile app,
 * which opens a different set of things; `usePlacedExit` is the one place that
 * asks, so a hand-off never offers "Get the desktop app" to a phone or a link
 * that lands on the mobile app's "not found". And for the VIEWER: the console
 * page a phone is offered instead comes only to a role that may open it.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { useConsoleRole } from "../app/(admin)/components/side-nav-role";
import {
  DESKTOP_NOT_OPENED_NOTE,
  placeExit,
  type Exit,
  type PlacedExit,
} from "./open-in";
import { isPhone } from "./platform";

/**
 * Contrast floor. Computed against this app's own themes (`tailwind.config.ts`)
 * with the text composited over the `foreground/[0.04]` card, over the page:
 *
 *   foreground/45 → 2.81:1   foreground/55 → 3.75:1   foreground/60 → 4.37:1
 *   foreground/65 → 5.13:1   ← first step that passes AA in LIGHT
 *   foreground/70 → 6.04:1 light / 8.01:1 dark   ← the floor used here
 *
 * Light is reachable: `providers.tsx` sets `enableSystem`, so it is not a dead
 * branch. Dark is more forgiving at every step; light is the binding case.
 *
 * This link is the only way out of a `synap://` that silently did nothing, so
 * it is the last thing that should be hard to read. Do not lower it.
 */
const FALLBACK_CLASS =
  "inline-flex min-h-10 items-center text-[12px] text-foreground/70 " +
  "underline-offset-2 transition-colors " +
  "hover:text-foreground hover:underline rounded-sm " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

const PRIMARY_CLASS =
  "inline-flex min-h-10 items-center gap-1.5 rounded-md text-[13px] " +
  "text-foreground/70 transition-colors hover:text-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

/**
 * Does clicking this take the reader out of pod-admin?
 *
 * NOT the same question as `externalProps` below, though both hang off the
 * href. "Opens a tab" is `https?:` only; LEAVING is the broader set — a
 * `synap://` hand-off leaves for the desktop app without opening a tab. Only
 * `openIn`'s same-origin routes (`/proposal/:id`, `/open/:kind/:id`) stay, and
 * those are exactly the relative hrefs.
 */
function leavesThisApp(href: string): boolean {
  return !href.startsWith("/");
}

/**
 * `openIn` returns pod-admin's OWN routes as web exits (`/proposal/:id`,
 * `/open/:kind/:id`). Those must navigate in place — gating on the scheme
 * rather than on `isDesktopLink` is what keeps a same-app link from spawning
 * a tab.
 *
 * Exported because `HandoffCard` renders its own primary affordance (a HeroUI
 * `Button as="a"`) and hand-rolled the same three lines. One rule, one spelling.
 */
export function externalProps(href: string) {
  return /^https?:/.test(href)
    ? { target: "_blank", rel: "noopener noreferrer" as const }
    : {};
}

/**
 * Is this reader on a phone? False on the server and on the first client
 * render (so the two agree), then the browser's answer — the same
 * mount-then-measure shape as `useMediaQuery`. Width is NOT the question: a
 * narrow desktop window still hands `synap://` to the desktop app.
 */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const nav = navigator as Navigator & {
      userAgentData?: { mobile?: boolean };
    };
    setPhone(isPhone(nav.userAgent, nav.userAgentData?.mobile));
  }, []);
  return phone;
}

/**
 * `placeExit` for this device and this viewer's console role — and a web
 * alternative that is the page the reader is already on is dropped: `/sources`
 * saying "use Sources instead" of its own connectors hand-off would be a link
 * to itself.
 */
export function usePlacedExit(exit: Exit): PlacedExit {
  const onPhone = useIsPhone();
  const role = useConsoleRole();
  const pathname = usePathname();
  const placed = placeExit(exit, onPhone, role);
  if (placed.unavailable?.web?.href === pathname) {
    return { ...placed, unavailable: { note: placed.unavailable.note } };
  }
  if (placed.web?.href === pathname) {
    const { web: _self, ...rest } = placed;
    return rest;
  }
  return placed;
}

/**
 * Where a ROW's link goes on this device: the exit itself, or — when a phone
 * cannot follow it — the console page that covers it. `null` = render the row
 * as text; the list's `ExitFallback` says why, once. A row whose link is a
 * desktop hand-off takes `useAppOpenAttempt(placed)` too: its `onOpen` on the
 * anchor, its `offer` beside it.
 */
export function rowHref(placed: PlacedExit): string | null {
  return placed.href ?? placed.unavailable?.web?.href ?? null;
}

/**
 * How long a click on a `synap://` link waits for a sign that the app took it.
 *
 * A page cannot ask whether a URL scheme has a handler: a `synap://` with no
 * app behind it does nothing at all, with no error and no event. So this is
 * the standard heuristic. When the app (or the OS's "Open Synap?" prompt)
 * takes the hand-off, the page loses focus (`blur`) or is hidden
 * (`visibilitychange` → hidden), or unloads (`pagehide`); when nothing took
 * it, none of that happens. ~1.5 s is long enough for the OS to raise its
 * prompt and short enough that the reader is still looking at the link.
 */
export const APP_OPEN_WAIT_MS = 1500;

/** What `watchAppOpen` listens to: `window` and `document` in the browser. */
export interface AppOpenSignals {
  win: EventTarget;
  doc: EventTarget & { readonly visibilityState: DocumentVisibilityState };
}

/**
 * Watch one attempt to open the app: `onNotOpened` runs once if, within
 * `waitMs`, the page neither lost focus, nor was hidden, nor unloaded. Any of
 * those cancels the watch for good. Returns the cancel, for an unmount or a
 * second click. Pure of React, so it is tested with fake timers and plain
 * `EventTarget`s.
 */
export function watchAppOpen(
  { win, doc }: AppOpenSignals,
  onNotOpened: () => void,
  waitMs: number = APP_OPEN_WAIT_MS
): () => void {
  const timer = setTimeout(() => {
    stop();
    onNotOpened();
  }, waitMs);
  const stop = () => {
    clearTimeout(timer);
    win.removeEventListener("blur", stop);
    win.removeEventListener("pagehide", stop);
    doc.removeEventListener("visibilitychange", onHidden);
  };
  const onHidden = () => {
    if (doc.visibilityState === "hidden") stop();
  };
  win.addEventListener("blur", stop);
  win.addEventListener("pagehide", stop);
  doc.addEventListener("visibilitychange", onHidden);
  return stop;
}

/**
 * The one door for a desktop hand-off's click. `onOpen` goes on the anchor
 * that follows `placed`'s `synap://` link (`onClick` on an `<a>`, `onPress` on
 * a HeroUI `Button as="a"`); `offer` goes where the link is. It stays `null`
 * at rest and after a click that opened the app, and becomes the quiet
 * "Synap didn't open. Get the desktop app" line after one that did not —
 * then stays (no flicker, no second watch).
 *
 * Nothing on a phone or for a web exit: `placeExit` gives those no
 * `ifNotOpened`, so `onOpen` is `undefined` and `offer` `null`.
 */
export function useAppOpenAttempt(placed: PlacedExit): {
  onOpen?: () => void;
  offer: ReactNode;
} {
  const [notOpened, setNotOpened] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);
  const hatch = placed.ifNotOpened;
  if (!hatch || placed.href === null) return { offer: null };
  const onOpen = () => {
    if (notOpened) return;
    stopRef.current?.();
    stopRef.current = watchAppOpen({ win: window, doc: document }, () => {
      stopRef.current = null;
      setNotOpened(true);
    });
  };
  return {
    onOpen,
    offer: notOpened ? <NotOpenedOffer hatch={hatch} /> : null,
  };
}

/**
 * The line a click that opened nothing leaves behind. Exported for its test
 * only: `useAppOpenAttempt` is the one place that renders it, and the
 * tripwire pins that no call site does.
 *
 * `role="status"` so a screen reader hears it appear; the link is a real
 * anchor in the tab order, at the contrast floor above.
 */
export function NotOpenedOffer({
  hatch,
}: {
  hatch: { href: string; label: string };
}) {
  return (
    <span
      role="status"
      className="inline-flex flex-wrap items-center gap-x-2 text-[12px] text-foreground/70"
    >
      {DESKTOP_NOT_OPENED_NOTE}
      <a
        href={hatch.href}
        target="_blank"
        rel="noopener noreferrer"
        className={FALLBACK_CLASS}
      >
        {hatch.label}
      </a>
    </span>
  );
}

export function ExitLink({ exit, label }: { exit: Exit; label: string }) {
  const placed = usePlacedExit(exit);
  const open = useAppOpenAttempt(placed);
  // Nothing to click on this device: the fallback line carries the sentence
  // (and the web page that covers it, when there is one).
  if (placed.href === null) return <PlacedFallback placed={placed} />;
  const href = placed.href;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <a
        href={href}
        {...externalProps(href)}
        onClick={open.onOpen}
        className={PRIMARY_CLASS}
      >
        {label}
        {/* The icon is a promise about behaviour: it means "this opens away
            from here". pod-admin's own routes (`/proposal/:id`, `/open/:kind/:id`)
            navigate in place, so they must not wear it. */}
        {leavesThisApp(href) && (
          <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden />
        )}
      </a>
      <PlacedFallback placed={placed} />
      {open.offer}
    </span>
  );
}

/**
 * The phone's line on its own, for a LIST whose every row is a desktop link.
 * Rendered once beneath the list rather than once per row — six workspace rows
 * should not tell the reader to install the app six times.
 *
 * On a phone it is the mobile app's install hatch when Relay can open the
 * rows, or "open this on your computer" when it cannot. On a desktop it
 * renders nothing: each row offers the download itself, only after its own
 * click did not open the app (`useAppOpenAttempt`). `showWeb={false}` for a
 * list: each row's own web page is the row's link (`rowHref`), so one row's
 * alternative must not speak for the list.
 */
export function ExitFallback({
  exit,
  showWeb = true,
}: {
  exit: Exit;
  showWeb?: boolean;
}) {
  const placed = usePlacedExit(exit);
  return <PlacedFallback placed={placed} showWeb={showWeb} />;
}

/**
 * The one spelling of "the way out of a hand-off" AT REST: the phone's
 * install hatch, the console page that covers it, or the note that this
 * device cannot follow it. Never the desktop download — that waits for a
 * failed open (`ifNotOpened`, `useAppOpenAttempt`). Callers that already hold
 * a `PlacedExit` (`HandoffCard`) render it directly rather than placing twice.
 */
export function PlacedFallback({
  placed,
  showWeb = true,
}: {
  placed: PlacedExit;
  showWeb?: boolean;
}) {
  if (placed.unavailable) {
    const web = showWeb ? placed.unavailable.web : undefined;
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 text-[12px] text-foreground/70">
        {placed.unavailable.note}
        {web && (
          <a href={web.href} className={FALLBACK_CLASS}>
            {web.label}
          </a>
        )}
      </span>
    );
  }
  // Beside a link the mobile app opens, the console page is a second way in.
  const web = showWeb ? placed.web : undefined;
  if (!placed.fallback && !web) return null;
  return (
    <>
      {placed.fallback && (
        <a
          href={placed.fallback.href}
          target="_blank"
          rel="noopener noreferrer"
          className={FALLBACK_CLASS}
        >
          {placed.fallback.label}
        </a>
      )}
      {web && (
        <a href={web.href} className={FALLBACK_CLASS}>
          {web.label}
        </a>
      )}
    </>
  );
}
