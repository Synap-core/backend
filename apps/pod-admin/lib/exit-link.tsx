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
 * The same holds for the DEVICE. On a phone `synap://` opens the mobile app,
 * which opens a different set of things; `usePlacedExit` is the one place that
 * asks, so a hand-off never offers "Get the desktop app" to a phone or a link
 * that lands on the mobile app's "not found". And for the VIEWER: the console
 * page a phone is offered instead comes only to a role that may open it.
 */

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { useConsoleRole } from "../app/(admin)/components/side-nav-role";
import { placeExit, type Exit, type PlacedExit } from "./open-in";
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
 * as text; the list's `ExitFallback` says why, once.
 */
export function rowHref(placed: PlacedExit): string | null {
  return placed.href ?? placed.unavailable?.web?.href ?? null;
}

export function ExitLink({ exit, label }: { exit: Exit; label: string }) {
  const placed = usePlacedExit(exit);
  // Nothing to click on this device: the fallback line carries the sentence
  // (and the web page that covers it, when there is one).
  if (placed.href === null) return <PlacedFallback placed={placed} />;
  const href = placed.href;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <a href={href} {...externalProps(href)} className={PRIMARY_CLASS}>
        {label}
        {/* The icon is a promise about behaviour: it means "this opens away
            from here". pod-admin's own routes (`/proposal/:id`, `/open/:kind/:id`)
            navigate in place, so they must not wear it. */}
        {leavesThisApp(href) && (
          <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden />
        )}
      </a>
      <PlacedFallback placed={placed} />
    </span>
  );
}

/**
 * The fallback on its own, for a LIST whose every row is a desktop link.
 * Rendered once beneath the list rather than once per row — six workspace rows
 * should not tell the reader to install the app six times.
 *
 * On a phone it is the device's line instead: the mobile app's install hatch
 * when Relay can open the rows, or "open this on your computer" when it
 * cannot. `showWeb={false}` for a list: each row's own web page is the row's
 * link (`rowHref`), so one row's alternative must not speak for the list.
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
 * The one spelling of "the way out of a hand-off". Callers that already hold
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
