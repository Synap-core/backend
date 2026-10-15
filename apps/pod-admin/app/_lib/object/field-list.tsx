"use client";

/**
 * `FieldList` — an entity's properties, drawn from the SHARED field plan
 * (`planEntityFields`, `@synap-core/types/property-render`): status and the
 * 3–6 primary facts in view, everything else behind "More fields". The plan
 * decides which field goes where; this only draws it (`field-rows.ts`).
 */

import { Accordion, AccordionItem } from "@heroui/react";
import type { EntityFieldPlan } from "@synap-core/types/property-render";
import { StatusPill } from "../../(admin)/components/status-pill";
import { fieldRows, type FieldRow } from "./field-rows";

export function FieldList({
  plan,
  omit,
}: {
  plan: EntityFieldPlan;
  /** Slugs the page already shows elsewhere (the summary's body field). */
  omit?: readonly string[];
}) {
  const { shown, more } = fieldRows(plan, { omit });
  if (shown.length === 0 && more.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {shown.length > 0 && <Rows rows={shown} />}
      {more.length > 0 && (
        <Accordion className="px-0" variant="light">
          <AccordionItem
            key="more"
            aria-label="More fields"
            title={
              <span className="text-[12.5px] text-foreground/65">
                More fields ({more.length})
              </span>
            }
          >
            <div className="pb-2">
              <Rows rows={more} />
            </div>
          </AccordionItem>
        </Accordion>
      )}
    </div>
  );
}

function Rows({ rows }: { rows: FieldRow[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[minmax(6rem,10rem)_1fr]">
      {rows.map((row) => (
        <div key={row.key} className="contents">
          <dt className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65 sm:pt-0.5">
            {row.label}
          </dt>
          <dd
            className={
              row.mono
                ? "mb-1 min-w-0 break-all font-mono text-[12px] text-foreground/85 sm:mb-0"
                : "mb-1 min-w-0 break-words text-[13px] leading-relaxed text-foreground/85 sm:mb-0"
            }
          >
            {row.pill ? (
              <StatusPill kind={row.pill.kind} label={row.pill.label} />
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
