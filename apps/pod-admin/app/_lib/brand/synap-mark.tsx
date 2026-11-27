"use client";

/**
 * The Synap mark and its lockup (mark + "Synap" wordmark): the ONE drawing of
 * the brand in pod admin, for the console's top bar and every receiver page.
 *
 * Taken from the retired app-bases brand kit, which pod admin cannot import
 * (it lives in the synap-app workspace): `synap-app/apps/base/lib/kit/brand/`
 * — `geometry.ts` (viewBox + path), `tokens.ts` (gradient stops, focal point,
 * aspect ratio) and `SynapMark.tsx` / `SynapLogo.tsx` (the web drawing and the
 * lockup). Copy the values from there; never redraw them by hand.
 *
 * Colours: the mark's gradient is brand identity, fixed in every theme (the
 * kit's own `tokens.ts` says so), so its stops are the one allowed exception
 * to "theme tokens only". Nothing else here carries a colour: the wordmark
 * wears the theme's `text-foreground`.
 */

import Link from "next/link";
import { useId } from "react";
import { appT } from "../copy";

/** The mark's trimmed bounding box (kit `geometry.ts`). */
const VIEWBOX = { width: 724, height: 1584 } as const;

/** One closed polygon, two curve-halves fused at a pinch (kit `geometry.ts`). */
const PATH_D =
  "M 723 0 L 671 17 L 609 41 L 521 81 L 433 128 L 354 178 L 324 199 L 270 241 L 239 268 L 207 299 L 186 322 L 161 354 L 149 372 L 133 403 L 126 421 L 119 449 L 116 473 L 116 495 L 120 525 L 126 548 L 134 570 L 147 597 L 157 614 L 176 641 L 210 680 L 240 709 L 268 733 L 310 765 L 337 783 L 341 787 L 341 792 L 103 1346 L 101 1348 L 60 1445 L 3 1573 L 0 1583 L 90 1548 L 94 1545 L 124 1533 L 183 1505 L 279 1455 L 377 1396 L 445 1348 L 475 1324 L 504 1298 L 521 1281 L 548 1249 L 569 1217 L 578 1199 L 590 1167 L 594 1150 L 597 1126 L 597 1095 L 594 1072 L 588 1046 L 581 1026 L 564 990 L 535 947 L 491 899 L 455 867 L 427 845 L 378 810 L 345 788 L 345 783 L 387 700 L 398 675 L 411 651 L 517 430 L 523 420 L 527 409 L 555 353 L 600 256 L 605 248 L 608 239 L 612 233 Z";

/**
 * Radial gradient stops, dark at the pinch, bright at the tips (kit
 * `tokens.ts` `SYNAP_MARK_GRADIENT_STOPS`). Brand identity, not a UI colour.
 */
const GRADIENT_STOPS = [
  { offset: 0.0, color: "#c35100" },
  { offset: 0.2, color: "#db6500" },
  { offset: 0.4, color: "#eb8105" },
  { offset: 0.6, color: "#fa9d09" },
  { offset: 0.8, color: "#fcbd16" },
  { offset: 1.0, color: "#ffdb23" },
] as const;

/** The gradient's focal point, as a fraction of the box (kit `tokens.ts`). */
const GRADIENT_FOCAL = { fx: 0.682, fy: 0.591 } as const;

/** Width / height of the mark (kit `SYNAP_MARK_ASPECT_RATIO`). */
const ASPECT_RATIO = VIEWBOX.width / VIEWBOX.height;

/**
 * The mark alone, `size` px tall. Decorative unless given a `label`: beside
 * the wordmark it would only repeat "Synap" to a screen reader.
 */
export function SynapMark({
  size = 20,
  label,
  className,
}: {
  size?: number;
  label?: string;
  className?: string;
}) {
  // Two marks on one page (the reader's bar and a card) must not share a
  // gradient id: the second `url(#…)` would paint with the first's.
  const gradientId = `synap-mark-${useId().replace(/:/g, "")}`;
  return (
    <svg
      width={Math.round(size * ASPECT_RATIO)}
      height={size}
      viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
      className={className}
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true, focusable: "false" })}
    >
      <defs>
        <radialGradient
          id={gradientId}
          cx="50%"
          cy="50%"
          r="100%"
          fx={`${GRADIENT_FOCAL.fx * 100}%`}
          fy={`${GRADIENT_FOCAL.fy * 100}%`}
        >
          {GRADIENT_STOPS.map((stop) => (
            <stop
              key={stop.offset}
              offset={`${stop.offset * 100}%`}
              stopColor={stop.color}
            />
          ))}
        </radialGradient>
      </defs>
      <path d={PATH_D} fill={`url(#${gradientId})`} />
    </svg>
  );
}

/**
 * Mark + "Synap" wordmark. With `href` the whole lockup is ONE link (Home);
 * without it, plain brand text: a reader who may not open Home is offered no
 * door they would be bounced from.
 *
 * `compactWordmark` hides the wordmark below `sm`, for a bar that must leave
 * its width to a title at 360px.
 */
export function SynapLockup({
  href,
  size = 18,
  wordmarkClassName = "text-[13px] font-medium",
  compactWordmark = false,
}: {
  href?: string;
  size?: number;
  wordmarkClassName?: string;
  compactWordmark?: boolean;
}) {
  const body = (
    <>
      <SynapMark size={size} className="shrink-0 select-none" />
      <span
        className={`${compactWordmark ? "hidden sm:inline" : ""} whitespace-nowrap tracking-tight text-foreground ${wordmarkClassName}`}
      >
        Synap
      </span>
    </>
  );
  if (!href) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5">{body}</span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={appT()("brand.home")}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      {body}
    </Link>
  );
}
