"use client";

/**
 * `AdvancedPanel` — the machine detail of an object, last on the page and
 * collapsed (prior-art rule: "Advanced last and collapsed"). Ids in mono, each
 * copyable; the raw record as JSON with one copy; and an optional explanation
 * slot (a `diagnose` answer to "why is this failing?").
 *
 * Never the place for a decision: everything here is for pasting into a
 * message to whoever runs the pod, or for an agent reading over a shoulder.
 */

import { useMemo, type ReactNode } from "react";
import { Accordion, AccordionItem } from "@heroui/react";
import { CopyButton } from "../copy-button";

export interface AdvancedId {
  label: string;
  value: string;
}

/** Pretty JSON for the raw panel; a value JSON cannot hold reads as its string. */
function rawJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function AdvancedPanel({
  ids,
  raw,
  explanation,
}: {
  ids: AdvancedId[];
  /** The record as the pod returned it. Omitted → no raw section. */
  raw?: unknown;
  /** A plain-language diagnosis, when one exists. */
  explanation?: ReactNode;
}) {
  const json = useMemo(() => (raw === undefined ? null : rawJson(raw)), [raw]);
  return (
    <Accordion className="px-0" variant="light">
      <AccordionItem
        key="advanced"
        aria-label="Advanced"
        title={
          <span className="text-[12.5px] text-foreground/65">Advanced</span>
        }
      >
        <div className="flex flex-col gap-4 pb-2">
          {explanation && (
            <div className="text-[13px] leading-relaxed text-foreground/80">
              {explanation}
            </div>
          )}
          {ids.length > 0 && (
            <dl className="flex flex-col gap-2">
              {ids.map((id) => (
                <div
                  key={id.label}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
                >
                  <div className="flex min-w-0 flex-col">
                    <dt className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65">
                      {id.label}
                    </dt>
                    <dd className="min-w-0 break-all font-mono text-[12px] text-foreground/85">
                      {id.value}
                    </dd>
                  </div>
                  <CopyButton
                    text={id.value}
                    label="Copy"
                    variant="light"
                    ariaLabel={`Copy ${id.label}`}
                  />
                </div>
              ))}
            </dl>
          )}
          {json !== null && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65">
                  Raw record
                </p>
                <CopyButton
                  text={json}
                  label="Copy JSON"
                  variant="light"
                  ariaLabel="Copy the raw record as JSON"
                />
              </div>
              <pre className="max-h-80 overflow-auto rounded-lg bg-foreground/[0.04] p-3 font-mono text-[11.5px] leading-relaxed text-foreground/80 ring-1 ring-inset ring-foreground/10">
                {json}
              </pre>
            </div>
          )}
        </div>
      </AccordionItem>
    </Accordion>
  );
}
