"use client";

/**
 * One line of an app's access (design A): its label ("It can", "In", "It
 * changes things in"), its current answer in words, and ONE door that opens
 * its choices (`ChoiceSheet`). The consent, the short ask, the re-consent
 * and the app page draw the same lines (`ConsentLines` holds them).
 *
 * A line's state is a mark, not a sentence (ui-composition §1): "Changed" on
 * a re-consent, "Unchanged" / "New" on the short ask, and a needs-you dot
 * when the person still has to answer it ("Pick where").
 */

import type { ReactNode } from "react";
import { Chip } from "@heroui/react";
import { ChoiceSheet, type ChoiceSheetProps } from "./ChoiceSheet";

export type LineMark = {
  text: string;
  /** primary: changed or new; default: unchanged. */
  tone: "primary" | "default";
};

export interface ConsentLineProps {
  label: string;
  mark?: LineMark | null;
  /** The answer still owed by the person: a dot beside the answer. */
  needsYou?: boolean;
  /** The current answer, in words. */
  children: ReactNode;
  /** Its door and choices; null for a line that only says its answer. */
  sheet?: ChoiceSheetProps | null;
  /** `data-line` for tests and the tripwire: can, in, write. */
  line: "can" | "in" | "write";
}

/** The list the lines sit in: one bordered surface, rows divided. */
export function ConsentLines({ children }: { children: ReactNode }) {
  return (
    <dl className="flex flex-col divide-y divide-foreground/10 rounded-lg ring-1 ring-inset ring-foreground/10">
      {children}
    </dl>
  );
}

export function ConsentLine({
  label,
  mark,
  needsYou = false,
  children,
  sheet,
  line,
}: ConsentLineProps) {
  return (
    <div
      data-line={line}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-3 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)_auto]"
    >
      <dt className="col-span-2 flex min-h-6 flex-wrap items-center gap-1.5 text-xs font-medium uppercase tracking-[0.04em] text-foreground/65 sm:col-span-1 sm:min-h-10">
        {label}
        {mark ? (
          <Chip
            size="sm"
            variant="flat"
            color={mark.tone}
            classNames={{ content: "normal-case tracking-normal" }}
          >
            {mark.text}
          </Chip>
        ) : null}
      </dt>
      <dd className="flex min-h-10 min-w-0 flex-col justify-center gap-0.5 text-sm leading-relaxed text-foreground/90">
        {needsYou ? (
          <span className="flex items-start gap-1.5">
            <span
              aria-hidden
              className="mt-[0.45rem] h-2 w-2 shrink-0 rounded-full bg-primary"
            />
            <span className="min-w-0">{children}</span>
          </span>
        ) : (
          children
        )}
      </dd>
      {sheet ? (
        <dd className="flex items-start">
          <ChoiceSheet {...sheet} />
        </dd>
      ) : null}
    </div>
  );
}
