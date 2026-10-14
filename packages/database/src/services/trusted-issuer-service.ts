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
   * `database` defaults to the pod's connection; a caller that already holds
   * the same handle under another import (the api package, a PGlite test)
   * passes it so every read and write of this registry goes through one door.
   */
  constructor(private readonly database: typeof db = db) {}

  /**
   * Find a trusted issuer by its issuer URL.
   * Returns null if no record exists.
   */
  async getByUrl(issuerUrl: string): Promise<TrustedIssuer | null> {
    const row = await this.database.query.trustedIssuers.findFirst({
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

    const [inserted] = await this.database
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
    const [updated] = await this.database
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
    const [updated] = await this.database
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
    const result = await this.database
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
    const result = await this.database
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
    return this.database.query.trustedIssuers.findMany({
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
      /**
       * Scopes the issuer declares for itself; never granted without consent.
       * `undefined` = the ask is UNKNOWN (discovery failed) — the stored
       * request is kept as it is, never read as "asks for nothing".
       */
      requestedScopes?: readonly string[];
      /** Pod opted in to granting issuer-declared scopes without review. */
      autoAcceptRequestedScopes?: boolean;
    }>
  ): Promise<
    Array<{
      issuerUrl: string;
      pendingScopes: string[];
      /** Scopes this call added to the row's grant (pinned or auto-accepted). */
      grantedScopes: string[];
    }>
  > {
    const results: Array<{
      issuerUrl: string;
      pendingScopes: string[];
      grantedScopes: string[];
    }> = [];
    for (const entry of entries) {
      const existing = await this.getByUrl(entry.issuerUrl);
      if (existing && !existing.isBuiltIn) continue;

      const plan = planBuiltInScopes({
        current: existing?.allowedScopes ?? [],
        pinned: entry.allowedScopes,
        requested: entry.requestedScopes ?? [],
        autoAcceptRequested: entry.autoAcceptRequestedScopes === true,
        declined: existing ? getDeclinedScopes(existing) : [],
      });
      const askKnown = entry.requestedScopes !== undefined;
      const pendingScopes = askKnown
        ? plan.pendingScopes
        : existing
          ? getPendingScopes(existing)
          : [];
      const requestData = askKnown
        ? withPendingScopeRequest(
            existing?.initialRequestData ?? null,
            plan.pendingScopes
          )
        : {
            value: (existing?.initialRequestData ?? null) as Record<
              string,
              unknown
            > | null,
            changed: false,
          };

      if (existing) {
        const scopesChanged =
          plan.allowedScopes.length !== existing.allowedScopes.length;
        if (scopesChanged || requestData.changed) {
          await this.database
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
        await this.database
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
      const before = existing?.allowedScopes ?? [];
      results.push({
        issuerUrl: entry.issuerUrl,
        pendingScopes,
        grantedScopes: plan.allowedScopes.filter((s) => !before.includes(s)),
      });
    }
    return results;
  }

  /**
   * The owner's YES to a pending scope request (D7) — the approval half of a
   * `trusted_issuer.widen_scopes` proposal. Grants `scopes` on top of what the
   * row holds and clears them from the stored request, in one row-locked
   * transaction.
   *
   * Never wider than the issuer's own ask: every scope not yet granted must be
   * in the row's CURRENT request (pending, or declined and now reconsidered),
   * so a revised proposal payload or a stale proposal cannot grant a scope the
   * issuer no longer asks for (`not_requested`, nothing written). Never
   * resurrects a revoked or rejected issuer (`not_approved`) — unlike
   * `approve`, which is the owner's explicit admin door for exactly that.
   */
  async grantRequestedScopes(
    id: string,
    reviewedBy: string,
    scopes: readonly string[]
  ): Promise<GrantRequestedScopesResult> {
    return this.database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(trustedIssuers)
        .where(eq(trustedIssuers.id, id))
        .for("update");
      if (!row) return { status: "not_found" as const };
      if (row.status !== "approved") {
        return { status: "not_approved" as const, issuerStatus: row.status };
      }
      const toGrant = Array.from(new Set(scopes)).filter(
        (s) => !row.allowedScopes.includes(s)
      );
      const asked = new Set([
        ...readScopeRequest(row.initialRequestData, PENDING_SCOPE_REQUEST_KEY),
        ...readScopeRequest(row.initialRequestData, DECLINED_SCOPE_REQUEST_KEY),
      ]);
      const notAsked = toGrant.filter((s) => !asked.has(s));
      if (notAsked.length > 0) {
        return { status: "not_requested" as const, scopes: notAsked.sort() };
      }
      const allowedScopes = [...row.allowedScopes, ...toGrant];
      const [updated] = await tx
        .update(trustedIssuers)
        .set({
          allowedScopes,
          initialRequestData: withoutRequestedScopes(
            row.initialRequestData,
            allowedScopes
          ) as TrustedIssuerInsert["initialRequestData"],
          reviewedBy,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(trustedIssuers.id, id))
        .returning();
      return {
        status: "granted" as const,
        issuer: updated!,
        granted: toGrant.sort(),
      };
    });
  }

  /**
   * The owner's NO to a pending scope request (D7): moves the request from
   * pending to declined, so the next boot neither re-asks nor re-files it
   * (`planBuiltInScopes` leaves an identical ask declined). Only when `scopes`
   * IS the current pending set — a decision about an older ask never clears a
   * newer one. Returns whether the row changed.
   */
  async declineRequestedScopes(
    id: string,
    scopes: readonly string[],
    proposalId: string
  ): Promise<boolean> {
    const row = await this.database.query.trustedIssuers.findFirst({
      where: eq(trustedIssuers.id, id),
    });
    if (!row) return false;
    const pending = getPendingScopes(row);
    if (pending.length === 0 || !sameScopeSet(pending, scopes)) return false;
    const base =
      row.initialRequestData &&
      typeof row.initialRequestData === "object" &&
      !Array.isArray(row.initialRequestData)
        ? { ...(row.initialRequestData as Record<string, unknown>) }
        : {};
    delete base[PENDING_SCOPE_REQUEST_KEY];
    const declined: DeclinedScopeRequest = {
      scopes: [...pending].sort(),
      declinedAt: new Date().toISOString(),
      proposalId,
    };
    base[DECLINED_SCOPE_REQUEST_KEY] = declined;
    await this.database
      .update(trustedIssuers)
      .set({
        initialRequestData: base as TrustedIssuerInsert["initialRequestData"],
        updatedAt: new Date(),
      })
      .where(eq(trustedIssuers.id, id));
    return true;
  }
}

export type GrantRequestedScopesResult =
  | { status: "not_found" }
  | { status: "not_approved"; issuerStatus: string }
  | { status: "not_requested"; scopes: string[] }
  | { status: "granted"; issuer: TrustedIssuer; granted: string[] };

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
 * Where the owner's NO to a scope request lives (same row, same column). An
 * identical ask stays declined across boots; a DIFFERENT ask is a new request.
 */
export const DECLINED_SCOPE_REQUEST_KEY = "declinedScopeRequest";

export interface DeclinedScopeRequest {
  scopes: string[];
  declinedAt: string;
  /** The rejected `trusted_issuer.widen_scopes` proposal that recorded it. */
  proposalId: string;
}

/**
 * Pure scope plan for a built-in issuer (D7). The issuer never widens its
 * own grant: `allowedScopes` = what the row holds ∪ the release-pinned set;
 * a requested scope outside that is pending — unless the pod opted in to
 * auto-accept, in which case it is granted and nothing is pending.
 *
 * `declined` is the set the owner already said no to: an ask that is exactly
 * that set stays declined (nothing pending, nothing re-filed); any other ask
 * is a new request and is pending in full.
 */
export function planBuiltInScopes(input: {
  current: readonly string[];
  pinned: readonly string[];
  requested: readonly string[];
  autoAcceptRequested: boolean;
  declined?: readonly string[];
}): { allowedScopes: string[]; pendingScopes: string[] } {
  const allowed = Array.from(new Set([...input.current, ...input.pinned]));
  const extra = Array.from(new Set(input.requested)).filter(
    (s) => !allowed.includes(s)
  );
  if (input.autoAcceptRequested) {
    return { allowedScopes: [...allowed, ...extra], pendingScopes: [] };
  }
  if (
    extra.length > 0 &&
    input.declined &&
    sameScopeSet(extra, input.declined)
  ) {
    return { allowedScopes: allowed, pendingScopes: [] };
  }
  return { allowedScopes: allowed, pendingScopes: extra.sort() };
}

/** The scope set the owner declined (`DECLINED_SCOPE_REQUEST_KEY`), or []. */
export function getDeclinedScopes(issuer: TrustedIssuer): string[] {
  return readScopeRequest(
    issuer.initialRequestData,
    DECLINED_SCOPE_REQUEST_KEY
  ).filter((s) => !issuer.allowedScopes.includes(s));
}

/** Order-insensitive set equality over scope names. */
export function sameScopeSet(
  a: readonly string[],
  b: readonly string[]
): boolean {
  const x = Array.from(new Set(a)).sort();
  const y = Array.from(new Set(b)).sort();
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

function readScopeRequest(data: unknown, key: string): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const req = (data as Record<string, unknown>)[key];
  if (!req || typeof req !== "object") return [];
  const scopes = (req as { scopes?: unknown }).scopes;
  if (!Array.isArray(scopes)) return [];
  return scopes.filter((s): s is string => typeof s === "string");
}

/**
 * The stored request minus every scope now granted; a request left empty is
 * dropped, and a column left empty is null.
 */
function withoutRequestedScopes(
  data: unknown,
  allowed: readonly string[]
): Record<string, unknown> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const base = { ...(data as Record<string, unknown>) };
  for (const key of [PENDING_SCOPE_REQUEST_KEY, DECLINED_SCOPE_REQUEST_KEY]) {
    const req = base[key];
    if (!req || typeof req !== "object") continue;
    const left = readScopeRequest(base, key).filter(
      (s) => !allowed.includes(s)
    );
    if (left.length === 0) delete base[key];
    else base[key] = { ...(req as Record<string, unknown>), scopes: left };
  }
  return Object.keys(base).length > 0 ? base : null;
}

/**
 * The scopes an issuer has asked for and the owner has not granted yet.
 * Filters by the row's CURRENT grant, so an owner approval clears the ask
 * immediately (the next boot also rewrites the stored request).
 */
export function getPendingScopes(issuer: TrustedIssuer): string[] {
  return readScopeRequest(
    issuer.initialRequestData,
    PENDING_SCOPE_REQUEST_KEY
  ).filter((s) => !issuer.allowedScopes.includes(s));
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
