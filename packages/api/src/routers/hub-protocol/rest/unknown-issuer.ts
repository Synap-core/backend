/**
 * An issuer this pod has never seen asks to be trusted (`/setup/agent`,
 * `/setup/service`). The ONE place that files a pending `trusted_issuers` row
 * from an unauthenticated request.
 *
 * WHY (audit 2026-10-28 F1). Both doors are skip-listed from hub auth. They
 * used to `jwt.decode` the bearer and, for any https `iss`, insert a pending
 * row and notify every pod admin, before any signature check. An unsigned
 * token per hostname filled the admins' inbox, and the display name was the
 * attacker's hostname: a phishing lure ("approve synap-live-cp.com").
 *
 * Now a row is filed only when ALL of these hold, cheapest first:
 *   1. The claims are those of a real request to THIS pod: ES256 with a `kid`,
 *      `aud` = this pod, an unexpired `exp`, a `jti`, and a purpose `type`
 *      the door accepts. No network, no database.
 *   2. The caller's source (client IP) has made fewer than
 *      {@link UNKNOWN_ISSUER_ATTEMPTS_PER_SOURCE} such attempts in the window.
 *      Counted BEFORE the fetch, so a failed signature still spends one.
 *   3. The signature verifies against the keys the issuer itself publishes at
 *      `<iss>/.well-known/jwks.json` (fetched through the SSRF-guarded
 *      `verifyIssuerJwt`: public addresses only, pinned DNS, size and time
 *      capped). Proves the caller controls that issuer; grants no trust.
 *   4. Fewer than {@link PENDING_ISSUER_CEILING} issuers are already waiting
 *      for a decision.
 * Anything else is refused with no row, no notification and no event.
 *
 * WHAT IT DOES NOT STOP: someone who owns a real domain and serves a JWKS can
 * still file ONE pending row per domain, within the per-source and ceiling
 * limits. Approval stays a human decision on the trusted-issuers page.
 * The per-source counter is in process memory: it resets on restart and is
 * per API process. The ceiling is the durable bound.
 */

import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import type { Context } from "hono";
import {
  db,
  eq,
  and,
  inArray,
  workspaces,
  workspaceMembers,
  eventRepository,
  TrustedIssuerService,
} from "@synap/database";
import { NotificationService } from "../../../notifications/NotificationService.js";
import {
  NOTIFICATION_EVENT_TYPE_MAP,
  NOTIFICATION_EVENT_SOURCE,
} from "../../../notifications/notification-event-map.js";
import { podAudience, verifyIssuerJwt } from "../../../utils/jwks-client.js";
import { logger } from "./_shared.js";

/** Attempts that reach the signature check, per source, per window. */
export const UNKNOWN_ISSUER_ATTEMPTS_PER_SOURCE = 5;
const SOURCE_WINDOW_MS = 60 * 60 * 1000;
/** Bound on the counter map itself, so many sources cannot grow it forever. */
const MAX_TRACKED_SOURCES = 10_000;
/** Pending issuers waiting for a decision; past it no new one is filed. */
export const PENDING_ISSUER_CEILING = 20;

const attemptsBySource = new Map<string, number[]>();

export type UnknownIssuerOutcome =
  | { status: "pending"; issuerId: string }
  | { status: "refused"; reason: "unverified" | "rate_limited" | "ceiling" };

/** The client address every pod-edge limiter keys on (see `clientIp`, apps/api). */
export function requestSource(c: {
  req: { header(name: string): string | undefined };
}): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

function claimsAddressThisPod(
  token: string,
  audience: string,
  expectedTypes: readonly string[]
): boolean {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded !== "object") return false;
  const { header, payload } = decoded;
  if (header.alg !== "ES256" || typeof header.kid !== "string" || !header.kid)
    return false;
  if (!payload || typeof payload !== "object") return false;
  const claims = payload as Record<string, unknown>;
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(audience)) return false;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now())
    return false;
  if (typeof claims.jti !== "string" || !claims.jti) return false;
  return typeof claims.type === "string" && expectedTypes.includes(claims.type);
}

/** Spends one attempt for `source`; false when its window is already full. */
function spendAttempt(source: string): boolean {
  const now = Date.now();
  const recent = (attemptsBySource.get(source) ?? []).filter(
    (at) => now - at < SOURCE_WINDOW_MS
  );
  if (recent.length >= UNKNOWN_ISSUER_ATTEMPTS_PER_SOURCE) {
    attemptsBySource.set(source, recent);
    return false;
  }
  recent.push(now);
  attemptsBySource.delete(source);
  attemptsBySource.set(source, recent);
  if (attemptsBySource.size > MAX_TRACKED_SOURCES) {
    const oldest = attemptsBySource.keys().next().value;
    if (oldest !== undefined) attemptsBySource.delete(oldest);
  }
  return true;
}

/** Test seam: forget every source's attempts. */
export function resetUnknownIssuerAttempts(): void {
  attemptsBySource.clear();
}

async function notifyAdminsOfPendingIssuer(
  issuer: { id: string },
  iss: string,
  derivedDisplayName: string
): Promise<void> {
  try {
    const podAdminWorkspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.systemSlug, "pod-admin"),
      columns: { id: true },
    });
    if (!podAdminWorkspace) return;
    const admins = await db.query.workspaceMembers.findMany({
      where: and(
        eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
        inArray(workspaceMembers.role, ["admin", "owner"])
      ),
      columns: { userId: true },
    });
    for (const admin of admins) {
      await NotificationService.create({
        type: "system.issuer_pending_approval",
        workspaceId: podAdminWorkspace.id,
        userId: admin.userId,
        sourceType: "system",
        sourceId: issuer.id,
        data: {
          issuerUrl: iss,
          displayName: derivedDisplayName,
        },
      });
    }
    // Domain-typed event alongside the per-admin notifications — see
    // notification-event-map.ts. Attributed to the first resolved admin
    // (there is no single "acting user" for an issuer asking to be trusted).
    // Runs once per issuer: the next request for the same URL finds the row
    // `registerPending` just created and never reaches this function.
    const mappedEventType =
      NOTIFICATION_EVENT_TYPE_MAP["system.issuer_pending_approval"];
    if (mappedEventType && admins[0]) {
      await eventRepository.append({
        id: randomUUID(),
        version: "v1",
        type: mappedEventType,
        subjectType: "issuer",
        subjectId: issuer.id,
        data: { issuerUrl: iss, displayName: derivedDisplayName },
        userId: admins[0].userId,
        source: NOTIFICATION_EVENT_SOURCE,
        timestamp: new Date(),
      });
    }
  } catch (notifyErr) {
    logger.warn(
      { err: notifyErr, issuerUrl: iss },
      "unknown issuer: failed to notify admins about pending issuer"
    );
  }
}

/**
 * Files `issuerUrl` (canonical, absent from the registry) as pending, or
 * refuses. See the file header for the four conditions.
 */
export async function requestTrustForUnknownIssuer(input: {
  token: string;
  issuerUrl: string;
  source: string;
  requestedVia: "setup-agent" | "setup-service";
  expectedTypes: readonly string[];
}): Promise<UnknownIssuerOutcome> {
  const { token, issuerUrl, source, requestedVia } = input;
  const audience = podAudience();
  if (!audience || !claimsAddressThisPod(token, audience, input.expectedTypes))
    return { status: "refused", reason: "unverified" };

  if (!spendAttempt(source)) {
    logger.warn(
      { issuerUrl, source, requestedVia },
      "unknown issuer: too many trust requests from this source — refused"
    );
    return { status: "refused", reason: "rate_limited" };
  }

  const payload = await verifyIssuerJwt<object>(token, issuerUrl, audience);
  if (!payload) return { status: "refused", reason: "unverified" };

  const issuerSvc = new TrustedIssuerService();
  const waiting = (await issuerSvc.list()).filter(
    (row) => row.status === "pending"
  ).length;
  if (waiting >= PENDING_ISSUER_CEILING) {
    logger.warn(
      { issuerUrl, waiting, requestedVia },
      "unknown issuer: pending-issuer ceiling reached — refused"
    );
    return { status: "refused", reason: "ceiling" };
  }

  const derivedDisplayName = new URL(issuerUrl).hostname;
  const issuer = await issuerSvc.registerPending(
    issuerUrl,
    derivedDisplayName,
    { requestedVia }
  );
  await notifyAdminsOfPendingIssuer(issuer, issuerUrl, derivedDisplayName);
  logger.warn(
    { issuerUrl, requestedVia },
    "unknown issuer: verified JWT from an unregistered issuer filed as pending — admin approval required"
  );
  return { status: "pending", issuerId: issuer.id };
}

/** The HTTP answer for an outcome; both setup doors return it verbatim. */
export function unknownIssuerResponse(
  c: Context,
  outcome: UnknownIssuerOutcome,
  issuerUrl: string,
  adminUrl: string
): Response {
  if (outcome.status === "pending") {
    return c.json(
      { code: "ISSUER_PENDING_APPROVAL", adminUrl, issuerUrl },
      202
    );
  }
  if (outcome.reason === "unverified") {
    return c.json(
      {
        code: "ISSUER_NOT_VERIFIED",
        error:
          "This issuer is not registered on this pod. A token from it must be signed with a key the issuer publishes and addressed to this pod.",
      },
      401
    );
  }
  return c.json(
    {
      code: "ISSUER_REQUESTS_LIMITED",
      error:
        "Too many requests from unregistered issuers. Ask the pod admin to add the issuer on the trusted-issuers page.",
    },
    429
  );
}
