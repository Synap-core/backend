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
 *
 * Shared by every object surface (console pages, `/open` receivers, the
 * marketplace). `BY_NAME` covers the registry's non-entity kinds — every kind
 * an `/open` link or a console object page can name — plus the commonest
 * entity profiles; anything else draws the registry's own fallback.
 */

import {
  BookOpen,
  Bot,
  Boxes,
  Box,
  CheckSquare,
  Database,
  FileText,
  FolderKanban,
  GitPullRequest,
  GraduationCap,
  LayoutDashboard,
  LayoutGrid,
  MessageSquare,
  Play,
  Rss,
  SquareCode,
  SquareDashedBottomCode,
  User,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  resolveObjectIcon,
  resolveObjectNoun,
  type ProfileIdentityInput,
} from "@synap-core/types/vocabulary";

const BY_NAME: Record<string, LucideIcon> = {
  BookOpen,
  Bot,
  Boxes,
  Box,
  CheckSquare,
  Database,
  FileText,
  FolderKanban,
  GitPullRequest,
  GraduationCap,
  LayoutDashboard,
  LayoutGrid,
  MessageSquare,
  Play,
  Rss,
  SquareCode,
  SquareDashedBottomCode,
  User,
  Wrench,
  Zap,
};

/**
 * The icon for a kind. `profile` lets an entity draw its own profile's icon
 * (`profiles.uiHints.icon`) when that icon is one this bundle carries.
 */
export function kindIcon(
  kind: string,
  profile?: ProfileIdentityInput | null
): LucideIcon {
  return BY_NAME[resolveObjectIcon(kind, profile)] ?? Box;
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
