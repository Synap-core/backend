"use client";

/**
 * The segmented filter of an Operate list (Rules, Runs): one pressed chip, an
 * optional count beside each label, the active one in the URL so a link can
 * land on it. Same chip look as Review's filter (`review-page.tsx`), which
 * predates it and still spells its own.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface FilterChip<K extends string> {
  key: K;
  label: string;
  /** Omitted while the count is unknown. */
  count?: number;
}

export function FilterChips<K extends string>({
  param,
  chips,
  active,
  defaultKey,
  ariaLabel = "Filter",
}: {
  param: string;
  chips: readonly FilterChip<K>[];
  active: K;
  /** Encoded by omitting the param, like `UrlTabs`. */
  defaultKey: K;
  ariaLabel?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function select(key: K) {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (key === defaultKey) params.delete(param);
    else params.set(param, key);
    // A focus target belongs to the list it was sent to.
    params.delete("focus");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
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
