/**
 * `FactsGrid` — the handful of label/value facts under an object header
 * ("Space · Builder", "Last run · 4h ago — failed"). Two columns on a phone,
 * up to `columns` from `sm` up. Facts with no value are the caller's to drop:
 * an empty fact is noise, not information.
 */

import type { ReactNode } from "react";

export interface Fact {
  label: string;
  value: ReactNode;
  /** Ids, hosts and tokens read in mono. */
  mono?: boolean;
}

/**
 * Columns → grid classes. Exported and pure so the responsive rule is
 * executable in a test (the `receiverWidthClass` lesson: a layout prop whose
 * only proof is its signature is not proven).
 */
export function factsGridClass(columns: 2 | 3 | 4): string {
  switch (columns) {
    case 2:
      return "grid-cols-2";
    case 3:
      return "grid-cols-2 sm:grid-cols-3";
    case 4:
      return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
  }
}

export function FactsGrid({
  facts,
  columns = 4,
}: {
  facts: Fact[];
  columns?: 2 | 3 | 4;
}) {
  if (facts.length === 0) return null;
  return (
    <dl className={`grid gap-x-6 gap-y-4 ${factsGridClass(columns)}`}>
      {facts.map((fact, i) => (
        <div key={`${fact.label}-${i}`} className="flex min-w-0 flex-col gap-1">
          <dt className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65">
            {fact.label}
          </dt>
          <dd
            className={
              fact.mono
                ? "min-w-0 break-all font-mono text-[12px] text-foreground/85"
                : "min-w-0 break-words text-[13px] text-foreground/85"
            }
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
