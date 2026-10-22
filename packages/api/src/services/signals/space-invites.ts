/**
 * SPACE INVITES — the open invites to another space of this pod, addressed to
 * the viewer's email, read for the needs-you union (`signals.ts` ›
 * `readAttention`; founder, wave PQ 2026-10-22). An invite to a space of a pod
 * the person already uses is joined IN the app: a Needs-you row with Accept,
 * Decline beside it, counted in `signals.count` so every surface states ONE
 * number (ui-composition §11).
 *
 * The same population `workspaces.listMyInvites` returns (the `invites` rows
 * addressed to this user's email), minus the expired ones (the pod refuses to
 * accept them). A user with no email is addressed by no invite: an EMPTY
 * answer, never a failed read. A failed read throws, and the caller names the
 * half unreadable (`settle`).
 */

import { and, db, desc, eq, gt, invites, users } from "@synap/database";
import type { SpaceInviteSignalInput } from "./needs-you-union.js";

/** How many invites one read pulls before its number is a floor. */
export const SPACE_INVITE_SCAN_LIMIT = 100;

export interface SpaceInvitesRead {
  rows: SpaceInviteSignalInput[];
  /** The scan hit its cap, so the count is a floor. */
  truncated: boolean;
}

/** The viewer's open invites, newest first (the order `listMyInvites` uses). */
export async function listOpenSpaceInvites(args: {
  userId: string;
  now?: Date;
}): Promise<SpaceInvitesRead> {
  const me = await db.query.users.findFirst({
    where: eq(users.id, args.userId),
    columns: { email: true },
  });
  if (!me?.email) return { rows: [], truncated: false };
  const rows = await db.query.invites.findMany({
    where: and(
      eq(invites.email, me.email.toLowerCase()),
      gt(invites.expiresAt, args.now ?? new Date())
    ),
    with: { workspace: { columns: { name: true } } },
    orderBy: [desc(invites.createdAt)],
    limit: SPACE_INVITE_SCAN_LIMIT + 1,
  });
  return {
    rows: rows.slice(0, SPACE_INVITE_SCAN_LIMIT).map((r) => ({
      id: r.id,
      token: r.token,
      type: r.type,
      role: r.role,
      workspaceId: r.workspaceId ?? null,
      spaceName: r.workspace?.name ?? null,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    })),
    truncated: rows.length > SPACE_INVITE_SCAN_LIMIT,
  };
}
