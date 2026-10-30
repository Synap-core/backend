/**
 * The pure half of a list's search box: which rows of an already-loaded list
 * match what was typed. Marketplace asks the pod (`catalog-tab.tsx`); the lists
 * that load whole (rules, templates, members, agents) filter here instead.
 *
 * Every typed word must appear in the row's text, in any order, ignoring case
 * and accents ("cafe" finds "Café"). An empty query matches everything.
 */

export const SEARCH_DEBOUNCE_MS = 250;

function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function filterBySearch<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => ReadonlyArray<string | null | undefined>
): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.slice();
  return items.filter((item) => {
    const haystack = fold(textOf(item).filter(Boolean).join(" "));
    return words.every((w) => haystack.includes(w));
  });
}
