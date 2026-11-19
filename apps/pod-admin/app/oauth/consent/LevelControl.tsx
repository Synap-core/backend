"use client";

/**
 * A row's level control (Off, View, Edit, On): a segmented radio group
 * (arrow keys move, one tab stop), named for its object. The ring is
 * `default-500` (5.0:1 dark, 4.6:1 light against the card); the segments are
 * 36px inside a 2px inset, so each target is 40px tall. A level that gives
 * something fills with the primary colour; Off fills neutral.
 */

import { Radio, RadioGroup } from "@heroui/react";
import { LEVEL_WORDS, type AccessLevel } from "./consent-model";

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

/**
 * Every checkbox of the consent: a 40px row to tap with no two rows' hit
 * areas overlapping (HeroUI's base is `p-2 -m-2`), and an unticked box drawn
 * in `default-500` (HeroUI's own border is the card's colour: an empty box
 * all but vanished). Against the card: 5.0:1 dark, 4.6:1 light.
 */
export const CONSENT_CHECKBOX = {
  base: "my-0 min-h-10 py-0",
  wrapper: "before:border-default-500",
} as const;

export function LevelControl({
  label,
  levels,
  level,
  isDisabled = false,
  onChange,
}: {
  /** The group's accessible name: what it sets, for which object. */
  label: string;
  levels: readonly AccessLevel[];
  level: AccessLevel;
  isDisabled?: boolean;
  onChange: (level: AccessLevel) => void;
}) {
  return (
    <RadioGroup
      orientation="horizontal"
      aria-label={label}
      value={level}
      isDisabled={isDisabled}
      onValueChange={(v) => onChange(v as AccessLevel)}
      classNames={LEVEL_GROUP}
    >
      {levels.map((l) => (
        <Radio
          key={l}
          value={l}
          classNames={l === "off" ? LEVEL_SEGMENT_OFF : LEVEL_SEGMENT}
        >
          {LEVEL_WORDS[l]}
        </Radio>
      ))}
    </RadioGroup>
  );
}
