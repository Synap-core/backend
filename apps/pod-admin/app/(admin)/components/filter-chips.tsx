"use client";

/**
 * The segmented filter of a console list (Review, Sessions, Rules, Runs, the
 * Marketplace catalog): one pressed chip, an optional count beside each label.
 *
 * With `param`, the active chip lives in the URL so a link can land on it; the
 * default chip is encoded by omitting the param, like `UrlTabs`, and a
 * `?focus=` target is dropped because it belongs to the list it was sent to.
 * Without `param` the parent owns the state through `onSelect`.
 */

import { useReplaceParams } from "../../../lib/use-replace-params";

export interface FilterChip<K extends string> {
  key: K;
  label: string;
  /** Omitted while the count is unknown. */
  count?: number | string;
}

type Binding<K extends string> =
  | { param: string; defaultKey: K }
  | { param?: undefined; defaultKey?: undefined };

export function FilterChips<K extends string>({
  param,
  chips,
  active,
  defaultKey,
  onSelect,
  ariaLabel = "Filter",
}: Binding<K> & {
  chips: readonly FilterChip<K>[];
  active: K;
  /** Runs on every press, after the URL is written (when bound). */
  onSelect?: (key: K) => void;
  ariaLabel?: string;
}) {
  const replaceParams = useReplaceParams();

  function select(key: K) {
    if (param !== undefined)
      replaceParams((params) => {
        if (key === defaultKey) params.delete(param);
        else params.set(param, key);
        params.delete("focus");
      });
    onSelect?.(key);
  }

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="mb-4 flex flex-wrap items-center gap-2"
    >
      {chips.map((c) => {
        const pressed = c.key === active;
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={pressed}
            onClick={() => select(c.key)}
            className={[
              "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1",
              "text-[12.5px] font-medium tracking-tight transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              pressed
                ? "bg-foreground/[0.08] text-foreground ring-1 ring-inset ring-foreground/15"
                : "text-foreground/65 hover:bg-content2/50 hover:text-foreground",
            ].join(" ")}
          >
            {c.label}
            {c.count !== undefined && (
              <span className="tabular text-[11px] text-foreground/65">
                {c.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
