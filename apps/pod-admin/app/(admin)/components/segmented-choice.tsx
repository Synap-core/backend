"use client";

/**
 * A choice between a few peers that is NOT a filter: how the review queue is
 * grouped, a package's layout, the console's language. One pressed segment.
 *
 * A filter (it narrows a list: an "All", a count per value) is a
 * `FilterChip` instead (page-grammar §9); that is why this has neither a
 * count nor a URL binding, and `__tripwires__/one-chip-per-filter.test.ts`
 * fails on a `SegmentedChoice` fed a filter's values.
 */

export interface SegmentedOption<K extends string> {
  key: K;
  label: string;
}

export function SegmentedChoice<K extends string>({
  options,
  active,
  onSelect,
  ariaLabel,
  className = "",
}: {
  options: readonly SegmentedOption<K>[];
  active: K;
  onSelect: (key: K) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`${className} flex flex-wrap items-center gap-2`}
    >
      {options.map((o) => {
        const pressed = o.key === active;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={pressed}
            onClick={() => onSelect(o.key)}
            className={[
              "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1",
              "text-[12.5px] font-medium tracking-tight transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              pressed
                ? "bg-foreground/[0.08] text-foreground ring-1 ring-inset ring-foreground/15"
                : "text-foreground/65 hover:bg-content2/50 hover:text-foreground",
            ].join(" ")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
