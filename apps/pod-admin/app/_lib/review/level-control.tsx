"use client";

/**
 * The ONE level control of pod-admin: a segmented radio group (arrow keys
 * move, one tab stop) setting what a credential may do with one object or
 * family — Off · View · Edit (Post, On). Moved out of the app consent page
 * (`app/oauth/consent/ConsentForm.tsx`, founder-approved 2026-10-23) so the
 * key pages set families with the same control (key pages plan 447800fe §2).
 *
 * The ring is `default-500` (5.0:1 dark, 4.6:1 light against the card); the
 * segments are 36px inside a 2px inset, so each target is 40px tall. A level
 * that gives something fills with the primary colour; Off fills neutral.
 */

import { Radio, RadioGroup } from "@heroui/react";

export const LEVEL_GROUP = {
  base: "shrink-0 gap-0",
  wrapper:
    "flex-nowrap gap-0.5 rounded-lg p-0.5 ring-1 ring-inset ring-default-500",
} as const;
const SEGMENT_BASE =
  "m-0 min-h-9 min-w-12 max-w-none justify-center rounded-md px-3 py-0 hover:bg-default-100 data-[focus-visible=true]:z-10 data-[focus-visible=true]:ring-2 data-[focus-visible=true]:ring-focus";
export const LEVEL_SEGMENT = {
  base: `${SEGMENT_BASE} data-[selected=true]:bg-primary data-[selected=true]:hover:bg-primary`,
  wrapper: "hidden",
  labelWrapper: "m-0 ml-0",
  label:
    "text-sm text-foreground/80 group-data-[selected=true]:font-medium group-data-[selected=true]:text-primary-foreground",
} as const;
export const LEVEL_SEGMENT_OFF = {
  ...LEVEL_SEGMENT,
  base: `${SEGMENT_BASE} data-[selected=true]:bg-default-200 data-[selected=true]:hover:bg-default-200`,
  label:
    "text-sm text-foreground/80 group-data-[selected=true]:font-medium group-data-[selected=true]:text-foreground",
} as const;

export function LevelControl<L extends string>({
  label,
  levels,
  words,
  level,
  isDisabled,
  isLevelDisabled,
  onChange,
}: {
  /** The accessible name: what this control sets ("Records, for this key"). */
  label: string;
  levels: readonly L[];
  /** Each level's words (`LEVEL_WORDS`, `@synap-core/types/grants`). */
  words: Readonly<Record<L, string>>;
  level: L;
  isDisabled?: boolean;
  /** A level that may not be picked here (wider than a request allows). */
  isLevelDisabled?: (level: L) => boolean;
  onChange: (level: L) => void;
}) {
  return (
    <RadioGroup
      orientation="horizontal"
      aria-label={label}
      value={level}
      isDisabled={isDisabled}
      onValueChange={(v) => onChange(v as L)}
      classNames={LEVEL_GROUP}
    >
      {levels.map((l) => (
        <Radio
          key={l}
          value={l}
          isDisabled={isLevelDisabled?.(l)}
          classNames={l === "off" ? LEVEL_SEGMENT_OFF : LEVEL_SEGMENT}
        >
          {words[l]}
        </Radio>
      ))}
    </RadioGroup>
  );
}
