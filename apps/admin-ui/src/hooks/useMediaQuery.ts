import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query.
 */
export function useMediaQuery(query: string, defaultMatches = false): boolean {
  const [matches, setMatches] = useState(defaultMatches);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const m = window.matchMedia(query);
    const onChange = () => setMatches(m.matches);

    setMatches(m.matches);
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
