/**
 * Pure helpers shared across the Members page.
 *
 * This file used to also export `studioDeepLinkForWorkspace` /
 * `studioDeepLinkForWorkspaceSettings`, which built `hub.synap.live?ws=<id>`
 * from `NEXT_PUBLIC_SYNAP_HUB_URL`. All three are gone: that target is the
 * deprecated fluid web app, it sits behind a second login on a different auth
 * stack, and it never read `?ws` at all — so the workspace you clicked from
 * was silently dropped. Exits now go through `openIn()` (`lib/open-in.ts`),
 * the one door, which only emits destinations whose receiver has been read.
 */

import { formatRelative } from "../../../../lib/format";
import type { StatusKind } from "../../components/status-pill";

export type MemberRole = "owner" | "admin" | "editor" | "viewer";

/** Highest role first — the order the members list groups in. */
export const MEMBER_ROLES: readonly MemberRole[] = [
  "owner",
  "admin",
  "editor",
  "viewer",
];

/** One row of `workspaces.listPodMembers`. */
export type PodMember = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  primaryRole: MemberRole;
  workspaceCount: number;
  workspaces: Array<{
    id: string;
    name: string;
    role: string;
    joinedAt: Date | string;
  }>;
};

export function groupByPrimaryRole(
  members: readonly PodMember[]
): Record<MemberRole, PodMember[]> {
  const out: Record<MemberRole, PodMember[]> = {
    owner: [],
    admin: [],
    editor: [],
    viewer: [],
  };
  for (const m of members) {
    if (m.primaryRole in out) out[m.primaryRole].push(m);
  }
  return out;
}

export function rolePillKind(role: string): StatusKind {
  if (role === "owner") return "healthy";
  if (role === "admin") return "stale";
  return "unknown";
}

/** "expires in 3d", or "expired" once the moment has passed. */
export function inviteExpiry(expiresAt: Date | string): string {
  const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return "no expiry date";
  if (at.getTime() <= Date.now()) return "expired";
  return `expires ${formatRelative(at)}`;
}
