/**
 * The rules of a pod admin filter chip (page-grammar §9, decision afab5911),
 * pure so they are tested without a DOM: what the chip SAYS for a selection,
 * which menu items it offers, which of them are drawn checked, what a pick
 * MEANS for the filter's value, and how that value is written to the address.
 * `FilterChip` only renders what these return.
 *
 * Mirrors `@synap-core/web/spatial-ui` `filter-chip-model.ts` (pod admin is
 * HeroUI and cannot import spatial-ui), with one addition: a filter may have
 * no "All" (`allLabel: null`, e.g. Rules opens on Active) and then a value is
 * always chosen, and the clear goes back to its default value.
 */

/**
 * The id of the menu's "All" item (single selection only). A NUL-prefixed
 * string, so it cannot collide with an option id that came from the data.
 */
export const FILTER_ALL_KEY = "\u0000all";

/** One value of a filter, built from the data (states, kinds, sources present). */
export interface FilterOption<K extends string = string> {
  /** Stable key; what the filter's value holds. */
  id: K;
  /** The value's name, shown in the menu and on the chip once chosen. */
  label: string;
  /** How many records have this value. `null` / omitted = not measured: no number, never 0. */
  count?: number | string | null;
  /** A secondary line under the label in the menu. */
  description?: string;
  /** Shown but not choosable. */
  disabled?: boolean;
}

export type FilterSelectionMode = "single" | "multiple";

/** What the chip face shows. */
export interface FilterChipFace {
  /** The neutral word, the chosen value, or "3 selected". */
  text: string;
  /** The count drawn on the chip, or null for none. */
  count: number | string | null;
  /** The filter narrows the list away from its default: highlighted, and may carry a clear. */
  isSet: boolean;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * What the chip says. Nothing chosen: the neutral word (and the "All" count
 * when measured). One value: its label and count. Several: `manyLabel(n)`,
 * with the sum of their counts only when every one is a measured number (a
 * sum over an unmeasured value would be a guess).
 *
 * A chosen id the options do not list (the value outlived the data) still
 * shows, as the id itself, so the chip never reads "All" while the list is
 * narrowed.
 */
export function filterChipFace(input: {
  options: readonly FilterOption[];
  /** The chosen ids (single: zero or one). */
  selected: readonly string[];
  /** The neutral word; null = the filter has no "All". */
  allLabel: string | null;
  /** What the filter opens on; a selection equal to it is not "set". */
  defaultSelected?: readonly string[];
  manyLabel?: (count: number) => string;
  showCount?: boolean;
  /** The count for "All", when the page measured it. */
  allCount?: number | string | null;
}): FilterChipFace {
  const {
    options,
    selected,
    allLabel,
    defaultSelected = [],
    manyLabel = defaultManyLabel,
    showCount = true,
    allCount,
  } = input;
  const isSet = !sameSet(selected, defaultSelected);
  if (selected.length === 0) {
    return {
      text: allLabel ?? "",
      count: showCount ? (allCount ?? null) : null,
      isSet,
    };
  }
  const byId = new Map(options.map((o) => [o.id, o]));
  if (selected.length === 1) {
    const id = selected[0]!;
    const option = byId.get(id);
    return {
      text: option?.label ?? id,
      count: showCount ? (option?.count ?? null) : null,
      isSet,
    };
  }
  let count: number | null = null;
  if (showCount) {
    const counts = selected.map((id) => byId.get(id)?.count);
    if (counts.every((c): c is number => typeof c === "number"))
      count = counts.reduce((a, b) => a + b, 0);
  }
  return { text: manyLabel(selected.length), count, isSet };
}

/** One item of the chip's menu. */
export interface FilterMenuItem {
  id: string;
  label: string;
  count: number | string | null;
  description?: string;
  disabled?: boolean;
}

/**
 * The menu's items. A single filter with an "All" leads with it (picking it
 * clears the filter); a filter without one, or a multiple filter, lists only
 * its values (a multiple filter's clear empties it).
 */
export function filterMenuItems(input: {
  options: readonly FilterOption[];
  mode: FilterSelectionMode;
  allLabel: string | null;
  allCount?: number | string | null;
}): FilterMenuItem[] {
  const { options, mode, allLabel, allCount } = input;
  const values: FilterMenuItem[] = options.map((o) => ({
    id: o.id,
    label: o.label,
    count: o.count ?? null,
    description: o.description,
    disabled: o.disabled,
  }));
  if (mode === "multiple" || allLabel === null) return values;
  return [
    { id: FILTER_ALL_KEY, label: allLabel, count: allCount ?? null },
    ...values,
  ];
}

/** The ids the menu draws checked: single → the value or "All"; multiple → the values. */
export function filterSelectedKeys(
  mode: FilterSelectionMode,
  selected: readonly string[]
): string[] {
  if (mode === "multiple") return [...selected];
  return selected.length > 0 ? [selected[0]!] : [FILTER_ALL_KEY];
}

/**
 * What a pick means: the menu's new checked set → the filter's chosen ids.
 * "All" is never a value. Multiple keeps the options' order, so the value
 * does not depend on the order of the clicks.
 */
export function filterSelectionFromKeys(
  mode: FilterSelectionMode,
  keys: ReadonlySet<string>,
  options: readonly FilterOption[]
): string[] {
  if (mode === "single") {
    const picked = [...keys].find((k) => k !== FILTER_ALL_KEY);
    return picked === undefined ? [] : [picked];
  }
  const known = options.filter((o) => keys.has(o.id)).map((o) => o.id);
  const unknown = [...keys].filter(
    (k) => k !== FILTER_ALL_KEY && !options.some((o) => o.id === k)
  );
  return [...known, ...unknown];
}

/**
 * Write a filter's selection into the address: the default is encoded by
 * omitting the param (a link to the bare page lands on it), several values
 * are comma-joined, and a `?focus=` target is dropped because it belongs to
 * the list it was sent to.
 */
export function writeFilterParam(
  params: URLSearchParams,
  param: string,
  selected: readonly string[],
  defaultSelected: readonly string[] = []
): void {
  if (sameSet(selected, defaultSelected)) params.delete(param);
  else params.set(param, selected.join(","));
  params.delete("focus");
}

/** The default text for several chosen values. */
export const defaultManyLabel = (count: number) => `${count} selected`;
