"use client";

/**
 * Kind icon + label — both resolved through `@synap-core/types/vocabulary`,
 * the ONE door for domain vocabulary. The icon NAME comes from the registry
 * (`resolveObjectIcon`); this module only maps that name to the statically
 * imported lucide component, so the bundle stays static and an unknown kind
 * falls back to `Box` (the registry's own FALLBACK_ICON) instead of crashing.
 *
 * Note the labels are NOT written here: `cell` renders as "Card" because the
 * registry says so (NORTH-STAR §5 — "cell" is the engine's word, never the
 * user's). A local label map would fork that the moment it existed.
 */

import {
  Boxes,
  Box,
  GraduationCap,
  LayoutDashboard,
  LayoutGrid,
  SquareDashedBottomCode,
  type LucideIcon,
} from "lucide-react";
import {
  resolveObjectIcon,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";

const BY_NAME: Record<string, LucideIcon> = {
  LayoutDashboard,
  Boxes,
  GraduationCap,
  LayoutGrid,
  SquareDashedBottomCode,
  Box,
};

export function kindIcon(kind: string): LucideIcon {
  return BY_NAME[resolveObjectIcon(kind)] ?? Box;
}

export function kindLabel(kind: string): string {
  return resolveObjectNoun(kind);
}

/**
 * "a cell package" / "an automation package" — the vocabulary-resolved label,
 * lowercased and given its indefinite article, for the one call site that
 * needs the kind inside a sentence rather than on a chip.
 */
export function kindPackagePhrase(kind: string): string {
  const label = kindLabel(kind).toLowerCase();
  const article = /^[aeiou]/i.test(label) ? "an" : "a";
  return `${article} ${label} package`;
}
