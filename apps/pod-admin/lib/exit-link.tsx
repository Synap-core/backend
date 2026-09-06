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
 */

import { ExternalLink } from "lucide-react";
import { DESKTOP_FALLBACK, type Exit } from "./open-in";

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

export function ExitLink({ exit, label }: { exit: Exit; label: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <a
        href={exit.href}
        {...externalProps(exit.href)}
        className={PRIMARY_CLASS}
      >
        {label}
        {/* The icon is a promise about behaviour: it means "this opens away
            from here". pod-admin's own routes (`/proposal/:id`, `/open/:kind/:id`)
            navigate in place, so they must not wear it. */}
        {leavesThisApp(exit.href) && <ExternalLink size={14} aria-hidden />}
      </a>
      <ExitFallback exit={exit} />
    </span>
  );
}

/**
 * The fallback on its own, for a LIST whose every row is a desktop link.
 * Rendered once beneath the list rather than once per row — six workspace rows
 * should not tell the reader to install the app six times.
 */
export function ExitFallback({ exit }: { exit: Exit }) {
  if (!exit.fallback) return null;
  return <DesktopFallbackLink />;
}

/**
 * The escape hatch with no `Exit` in hand.
 *
 * A LIST whose rows are all desktop links has no single exit to hang the
 * fallback off — `intelligence` rendered its own `<a href={DESKTOP_FALLBACK.href}>`
 * with its own classes, which is the seven-copy drift returning inside the wave
 * that removed it. The tripwire could not see it either: it matched
 * `exit.fallback` only. One component, and the guard now matches
 * `DESKTOP_FALLBACK.href` too.
 */
export function DesktopFallbackLink() {
  return (
    <a
      href={DESKTOP_FALLBACK.href}
      target="_blank"
      rel="noopener noreferrer"
      className={FALLBACK_CLASS}
    >
      {DESKTOP_FALLBACK.label}
    </a>
  );
}
