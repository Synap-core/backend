"use client";

import { useEffect, useState } from "react";

/** Tailwind's `md` and `lg` breakpoints, as media queries. */
export const MD_UP = "(min-width: 768px)";
export const LG_UP = "(min-width: 1024px)";

/**
 * Whether a media query matches, following it as the window changes.
 *
 * For a layout that is a different COMPONENT per width (a table vs a stacked
 * list, a docked column vs a modal drawer), where CSS alone would mount both.
 * False until mounted, so the server render and the first client render agree.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [query]);
  return matches;
}
