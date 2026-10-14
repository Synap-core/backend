/**
 * TrustedIssuerService — CRUD for the trusted_issuers registry.
 *
 * Manages the Pod-level allowlist of external services that are permitted to
 * sign JWTs and call provisioning endpoints. Replaces environment-based
 * implicit trust with a database-backed approval workflow.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../client-pg.js";
import { trustedIssuers } from "../schema/trusted-issuers.js";
import type {
  TrustedIssuer,
  TrustedIssuerInsert,
} from "../schema/trusted-issuers.js";

export class TrustedIssuerService {
  /**
   * Find a trusted issuer by its issuer URL.
   * Returns null if no record exists.
   */
  async getByUrl(issuerUrl: string): Promise<TrustedIssuer | null> {
    const row = await db.query.trustedIssuers.findFirst({
      where: eq(trustedIssuers.issuerUrl, issuerUrl),
    });
    return row ?? null;
  }

  /**
   * Register an unknown issuer as pending approval.
   *
   * If a record with the same issuerUrl already exists (in any status), returns
   * the existing record without overwriting anything. This is idempotent —
   * calling it repeatedly for the same URL is always safe.
   */
  async registerPending(
    issuerUrl: string,
    displayName: string,
    requestData: unknown
  ): Promise<TrustedIssuer> {
    const existing = await this.getByUrl(issuerUrl);
    if (existing) {
      return existing;
    }

    const [inserted] = await db
      .insert(trustedIssuers)
      .values({
        issuerUrl,
        displayName,
        status: "pending",
        isBuiltIn: false,
        initialRequestData:
          requestData as TrustedIssuerInsert["initialRequestData"],
      })
      .onConflictDoNothing()
      .returning();

    // Conflict race: another request inserted first — fetch and return
    if (!inserted) {
      const raceRow = await this.getByUrl(issuerUrl);
      if (!raceRow) {
        throw new Error(
          `TrustedIssuerService.registerPending: unexpected state — no row for ${issuerUrl} after insert conflict`
        );
      }
      return raceRow;
    }

    return inserted;
  }

  /**
   * Approve a pending issuer, granting it the specified scopes.
   */
  async approve(
    id: string,
    reviewedBy: string,
    allowedScopes: string[]
  ): Promise<TrustedIssuer> {
    const [updated] = await db
      .update(trustedIssuers)
      .set({
        status: "approved",
        allowedScopes,
        reviewedBy,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(trustedIssuers.id, id))
      .returning();

    if (!updated) {
      throw new Error(`TrustedIssuerService.approve: issuer ${id} not found`);
    }

    return updated;
  }

  /**
   * Atomically approve a pending issuer during the locally authenticated
   * first-link flow. Unlike the administrative `approve` operation, this
   * cannot resurrect an issuer another Pod owner has rejected or revoked.
   */
  async approvePending(
    id: string,
    reviewedBy: string,
    allowedScopes: string[]
  ): Promise<TrustedIssuer | null> {
    const [updated] = await db
      .update(trustedIssuers)
      .set({
        status: "approved",
        allowedScopes,
        reviewedBy,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(trustedIssuers.id, id), eq(trustedIssuers.status, "pending"))
      )
      .returning();
    return updated ?? null;
  }

  /**
   * Reject a pending issuer with a human-readable reason.
   */
  async reject(id: string, reviewedBy: string, reason: string): Promise<void> {
    const result = await db
      .update(trustedIssuers)
      .set({
        status: "rejected",
        reviewedBy,
        reviewedAt: new Date(),
        rejectionReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(trustedIssuers.id, id))
      .returning({ id: trustedIssuers.id });

    if (result.length === 0) {
      throw new Error(`TrustedIssuerService.reject: issuer ${id} not found`);
    }
  }

  /**
   * Revoke a previously-approved issuer.
   * Sets status to "revoked"; the issuer will be refused on next auth attempt.
   */
  async revoke(id: string, reviewedBy: string): Promise<void> {
    const result = await db
      .update(trustedIssuers)
      .set({
        status: "revoked",
        reviewedBy,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(trustedIssuers.id, id))
      .returning({ id: trustedIssuers.id });

    if (result.length === 0) {
      throw new Error(`TrustedIssuerService.revoke: issuer ${id} not found`);
    }
  }

  /**
   * List all trusted issuers, newest first.
   */
  async list(): Promise<TrustedIssuer[]> {
    return db.query.trustedIssuers.findMany({
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  /**
   * Seed deployment-provided issuers on Pod startup.
   *
   * Scopes are PINNED, never widened by the issuer (security decision D7):
   * `allowedScopes` is the release-pinned bootstrap set the pod code decides
   * (`CONTROL_PLANE_ISSUER_SCOPES` for the CP). `requestedScopes` is what the
   * issuer itself declares (the CP's `/federation/metadata`); any requested
   * scope beyond what the row already holds is recorded as a PENDING scope
   * request for the owner (`getPendingScopes`) and is granted only when the
   * owner approves it through `trustedIssuers.approve` — or, when the pod
   * opted in (`autoAcceptRequestedScopes`, the `trust.autoAcceptCpScopes`
   * pod setting), granted here.
   *
   * For each entry:
   * - If no row exists → insert with status "approved", isBuiltIn = true and
   *   the planned scopes (see `planBuiltInScopes`).
   * - If a built-in row already exists → add newly pinned scopes without
   *   removing any operator-approved scope; record/refresh the pending request.
   * - If a non-built-in row already exists → leave it untouched.
   *
   * Safe to call on every pod boot — fully idempotent (an unchanged pending
   * request keeps its original `requestedAt`). Returns, per seeded built-in
   * row, the scopes still waiting for the owner.
   */
  async seedBuiltIn(
    entries: Array<{
      issuerUrl: string;
      displayName: string;
      description?: string;
      /** Release-pinned bootstrap scopes — the only scopes granted here by default. */
      allowedScopes: readonly string[];
      /** Scopes the issuer declares for itself; never granted without consent. */
      requestedScopes?: readonly string[];
      /** Pod opted in to granting issuer-declared scopes without review. */
      autoAcceptRequestedScopes?: boolean;
    }>
  ): Promise<Array<{ issuerUrl: string; pendingScopes: string[] }>> {
    const results: Array<{ issuerUrl: string; pendingScopes: string[] }> = [];
    for (const entry of entries) {
      const existing = await this.getByUrl(entry.issuerUrl);
      if (existing && !existing.isBuiltIn) continue;

      const plan = planBuiltInScopes({
        current: existing?.allowedScopes ?? [],
        pinned: entry.allowedScopes,
        requested: entry.requestedScopes ?? [],
        autoAcceptRequested: entry.autoAcceptRequestedScopes === true,
      });
      const requestData = withPendingScopeRequest(
        existing?.initialRequestData ?? null,
        plan.pendingScopes
      );

      if (existing) {
        const scopesChanged =
          plan.allowedScopes.length !== existing.allowedScopes.length;
        if (scopesChanged || requestData.changed) {
          await db
            .update(trustedIssuers)
            .set({
              ...(scopesChanged ? { allowedScopes: plan.allowedScopes } : {}),
              ...(requestData.changed
                ? {
                    initialRequestData:
                      requestData.value as TrustedIssuerInsert["initialRequestData"],
                  }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(trustedIssuers.id, existing.id));
        }
      } else {
        await db
          .insert(trustedIssuers)
          .values({
            issuerUrl: entry.issuerUrl,
            displayName: entry.displayName,
            description: entry.description ?? null,
            allowedScopes: plan.allowedScopes,
            status: "approved",
            isBuiltIn: true,
            initialRequestData:
              requestData.value as TrustedIssuerInsert["initialRequestData"],
          })
          .onConflictDoNothing();
      }
      results.push({
        issuerUrl: entry.issuerUrl,
        pendingScopes: plan.pendingScopes,
      });
    }
    return results;
  }
}

/**
 * Where a built-in issuer's pending scope request lives: a key on the row's
 * `initial_request_data` (the issuer's own request payload). No new column —
 * the request is the issuer's ask, and `trustedIssuers.list` already returns
 * the row to the owner.
 */
export const PENDING_SCOPE_REQUEST_KEY = "pendingScopeRequest";

export interface PendingScopeRequest {
  scopes: string[];
  requestedAt: string;
}

/**
 * Pure scope plan for a built-in issuer (D7). The issuer never widens its
 * own grant: `allowedScopes` = what the row holds ∪ the release-pinned set;
 * a requested scope outside that is pending — unless the pod opted in to
 * auto-accept, in which case it is granted and nothing is pending.
 */
export function planBuiltInScopes(input: {
  current: readonly string[];
  pinned: readonly string[];
  requested: readonly string[];
  autoAcceptRequested: boolean;
}): { allowedScopes: string[]; pendingScopes: string[] } {
  const allowed = Array.from(new Set([...input.current, ...input.pinned]));
  const extra = Array.from(new Set(input.requested)).filter(
    (s) => !allowed.includes(s)
  );
  if (input.autoAcceptRequested) {
    return { allowedScopes: [...allowed, ...extra], pendingScopes: [] };
  }
  return { allowedScopes: allowed, pendingScopes: extra.sort() };
}

/**
 * The scopes an issuer has asked for and the owner has not granted yet.
 * Filters by the row's CURRENT grant, so an owner approval clears the ask
 * immediately (the next boot also rewrites the stored request).
 */
export function getPendingScopes(issuer: TrustedIssuer): string[] {
  const data = issuer.initialRequestData;
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const req = (data as Record<string, unknown>)[PENDING_SCOPE_REQUEST_KEY];
  if (!req || typeof req !== "object") return [];
  const scopes = (req as { scopes?: unknown }).scopes;
  if (!Array.isArray(scopes)) return [];
  return scopes.filter(
    (s): s is string =>
      typeof s === "string" && !issuer.allowedScopes.includes(s)
  );
}

function withPendingScopeRequest(
  current: unknown,
  pendingScopes: string[]
): { value: Record<string, unknown> | null; changed: boolean } {
  const base =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : null;
  const prev = base?.[PENDING_SCOPE_REQUEST_KEY] as
    PendingScopeRequest | undefined;
  const prevScopes = Array.isArray(prev?.scopes) ? [...prev.scopes].sort() : [];
  const same =
    prevScopes.length === pendingScopes.length &&
    prevScopes.every((s, i) => s === pendingScopes[i]);
  if (same) return { value: base, changed: false };
  if (pendingScopes.length === 0) {
    if (!base) return { value: null, changed: false };
    delete base[PENDING_SCOPE_REQUEST_KEY];
    return {
      value: Object.keys(base).length > 0 ? base : null,
      changed: true,
    };
  }
  const request: PendingScopeRequest = {
    scopes: pendingScopes,
    requestedAt: new Date().toISOString(),
  };
  return {
    value: { ...(base ?? {}), [PENDING_SCOPE_REQUEST_KEY]: request },
    changed: true,
  };
}
