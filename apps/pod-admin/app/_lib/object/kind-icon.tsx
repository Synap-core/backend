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
 * marketplace). `BY_NAME` carries every icon the registry names for a kind
 * (`OBJECT_KINDS`, pinned by `kind-icon.test.ts`): a kind whose icon was
 * missing here drew the cube, so every Review row looked the same. A
 * profile's own icon this bundle does not carry still draws the fallback.
 */

import {
  Activity,
  BadgeCheck,
  Bell,
  BookOpen,
  Bookmark,
  Bot,
  Box,
  Boxes,
  Building2,
  Calendar,
  Camera,
  CheckSquare,
  ClipboardList,
  Code,
  Database,
  FileText,
  FolderKanban,
  GitPullRequest,
  Globe,
  GraduationCap,
  Handshake,
  Image as ImageIcon,
  Keyboard,
  Laptop,
  LayoutDashboard,
  LayoutGrid,
  Lightbulb,
  MessageSquare,
  Monitor,
  Newspaper,
  Play,
  Route,
  Rss,
  Scale,
  Server,
  ShieldCheck,
  SquareCode,
  SquareDashedBottomCode,
  Terminal,
  TerminalSquare,
  TrendingUp,
  User,
  UserCheck,
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
  Activity,
  BadgeCheck,
  Bell,
  BookOpen,
  Bookmark,
  Bot,
  Box,
  Boxes,
  Building2,
  Calendar,
  Camera,
  CheckSquare,
  ClipboardList,
  Code,
  Database,
  FileText,
  FolderKanban,
  GitPullRequest,
  Globe,
  GraduationCap,
  Handshake,
  Image: ImageIcon,
  Keyboard,
  Laptop,
  LayoutDashboard,
  LayoutGrid,
  Lightbulb,
  MessageSquare,
  Monitor,
  Newspaper,
  Play,
  Route,
  Rss,
  Scale,
  Server,
  ShieldCheck,
  SquareCode,
  SquareDashedBottomCode,
  Terminal,
  TerminalSquare,
  TrendingUp,
  User,
  UserCheck,
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
