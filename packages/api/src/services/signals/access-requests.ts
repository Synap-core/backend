/**
 * ACCESS REQUESTS — the two pod-level asks that are not proposals, read for
 * the needs-you union (`signals.ts` › `readAttention`):
 *
 *   - a pending TRUSTED ISSUER (`trusted_issuers.status = 'pending'`): an
 *     outside service asked to have its identity tokens accepted, registered by
 *     `setup.ts` the first time it called;
 *   - a pending APPLICATION CONNECTION REQUEST: an app asking that its browser
 *     origin may call this pod, waiting on an owner (effective status
 *     `pending` — `awaiting_local_auth` is still the requester's move, and a
 *     request past its handoff lease is `expired`; the same rule as
 *     `effectiveApplicationConnectionRequestStatus`).
 *
 * Both are decided by a POD ADMIN only (`trustedIssuers.*` and
 * `applicationConnections.approveRequest` are `podAdminProcedure`), so they
 * are read for a pod admin only. Anyone else gets an EMPTY answer — the asks
 * are not theirs to see, which is a fact about the viewer, never a failed
 * read. A failed admin check or table read throws, and the caller names the
 * half unreadable (`settle`).
 *
 * Before this read, the issuer ask reached needs-you only as the
 * `system.issuer_pending_approval` notification: no door, and never cleared
 * by the decision. The table is the ask now; the notification is bell news
 * (registry `needsYou: "informational"`), actioned on the decision
 * (`TrustedIssuerService`).
 */

import {
  and,
  asc,
  db,
  eq,
  gt,
  federatedApplicationConnectionRequests,
  trustedIssuers,
} from "@synap/database";
import { isPodAdmin } from "../../utils/workspace-role.js";
import type {
  PendingAppRequestSignalInput,
  PendingIssuerSignalInput,
} from "./needs-you-union.js";

/** How many rows one half pulls before its number is a floor. */
export const ACCESS_REQUEST_SCAN_LIMIT = 100;

export interface AccessRequestHalf<T> {
  rows: T[];
  /** The scan hit its cap, so the count is a floor. */
  truncated: boolean;
}

/**
 * The viewer's pod-admin check, run at most ONCE per read and shared by both
 * halves (a pod admin decides both), and only when a half actually reads.
 */
export function podAdminCheck(userId: string): () => Promise<boolean> {
  let admin: Promise<boolean> | undefined;
  return () => (admin ??= isPodAdmin(userId));
}

/** Pending issuers, oldest first (the one waiting longest is the most overdue). */
export async function listPendingIssuers(args: {
  isAdmin: () => Promise<boolean>;
}): Promise<AccessRequestHalf<PendingIssuerSignalInput>> {
  if (!(await args.isAdmin())) return { rows: [], truncated: false };
  const rows = await db
    .select({
      id: trustedIssuers.id,
      displayName: trustedIssuers.displayName,
      issuerUrl: trustedIssuers.issuerUrl,
      createdAt: trustedIssuers.createdAt,
    })
    .from(trustedIssuers)
    .where(
      and(
        eq(trustedIssuers.status, "pending"),
        // A built-in issuer is seeded approved; one could only read pending
        // through a hand edit, and the console offers it no decision.
        eq(trustedIssuers.isBuiltIn, false)
      )
    )
    .orderBy(asc(trustedIssuers.createdAt))
    .limit(ACCESS_REQUEST_SCAN_LIMIT + 1);
  return {
    rows: rows.slice(0, ACCESS_REQUEST_SCAN_LIMIT),
    truncated: rows.length > ACCESS_REQUEST_SCAN_LIMIT,
  };
}

/** App connection requests waiting on an owner, oldest first. */
export async function listPendingAppRequests(args: {
  isAdmin: () => Promise<boolean>;
  now?: Date;
}): Promise<AccessRequestHalf<PendingAppRequestSignalInput>> {
  if (!(await args.isAdmin())) return { rows: [], truncated: false };
  const t = federatedApplicationConnectionRequests;
  const rows = await db
    .select({
      id: t.id,
      displayName: t.displayName,
      requestedOrigin: t.requestedOrigin,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
    })
    .from(t)
    // Effective `pending`: the stored status AND a live handoff lease. Past
    // the lease the request reads `expired` everywhere, so it is no ask.
    .where(
      and(eq(t.status, "pending"), gt(t.expiresAt, args.now ?? new Date()))
    )
    .orderBy(asc(t.createdAt))
    .limit(ACCESS_REQUEST_SCAN_LIMIT + 1);
  return {
    rows: rows.slice(0, ACCESS_REQUEST_SCAN_LIMIT),
    truncated: rows.length > ACCESS_REQUEST_SCAN_LIMIT,
  };
}
