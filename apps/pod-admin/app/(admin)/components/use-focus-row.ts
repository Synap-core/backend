"use client";

/**
 * `useFocusRow` — receives `?focus=<id>` from the URL, scrolls the matching
 * row into view, and applies a temporary highlight ring.
 *
 * Mirror of the Eve dashboard marketplace handoff:
 *   document.querySelector(`[data-row-id="<id>"]`)
 *     → scrollIntoView({ behavior: "smooth", block: "center" })
 *     → add ring-2 ring-primary/60 for ~2.4s
 *
 * Pages call this once at mount; the hook handles its own deduplication
 * (so a re-render won't re-fire the highlight) and waits for `ready` so
 * the receiver can defer until its data has loaded.
 *
 * Receivers are expected to add `data-row-id={id}` to the matching row
 * element. Where rows have richer markup we recommend adding the data
 * attribute to the outermost wrapper to keep the highlight square.
 *
 * Returns the `focusId` value too — useful for callers that want to
 * apply additional styling (e.g. expanding a sub-tree on focus).
 */

import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

interface UseFocusRowOptions {
  /**
   * Block the highlight until the receiver's data is ready. While `false`
   * the hook waits; once flipped to `true` it fires once.
   */
  ready?: boolean;
  /**
   * Override the data attribute used to find the row. Defaults to
   * `data-row-id`.
   */
  attribute?: string;
}

export function useFocusRow(options: UseFocusRowOptions = {}): string | null {
  const { ready = true, attribute = "data-row-id" } = options;
  const searchParams = useSearchParams();
  const focusId = searchParams.get("focus");
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusId) return;
    if (!ready) return;
    if (handledRef.current === focusId) return;
    // Try a few times — the row may render a frame after the data lands.
    let attempts = 0;
    const tryFocus = () => {
      attempts += 1;
      const el = document.querySelector<HTMLElement>(
        `[${attribute}="${cssEscape(focusId)}"]`
      );
      if (!el) {
        if (attempts < 8) window.setTimeout(tryFocus, 100);
        return;
      }
      handledRef.current = focusId;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-primary/60", "ring-offset-2");
      window.setTimeout(
        () => el.classList.remove("ring-2", "ring-primary/60", "ring-offset-2"),
        2400
      );
    };
    tryFocus();
  }, [focusId, ready, attribute]);

  return focusId;
}

/**
 * `CSS.escape` polyfill for older Node typings.  The browser ships it on
 * the `CSS` global, but TypeScript's lib doesn't always declare it; use a
 * narrow reflective access so the build doesn't fail in stricter setups.
 */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  // Conservative fallback — escape characters with special meaning in CSS
  // attribute selectors. Good enough for UUIDs / slugs which is all we
  // pass through `?focus=`.
  return value.replace(/(["\\])/g, "\\$1");
}
