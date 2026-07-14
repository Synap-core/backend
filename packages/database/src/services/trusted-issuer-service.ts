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
   * For each entry:
   * - If no row exists → insert with status "approved" and isBuiltIn = true.
   * - If a built-in row already exists → add newly required built-in scopes
   *   without removing any operator-approved scope.
   * - If a non-built-in row already exists → leave it untouched.
   *
   * Safe to call on every pod boot — fully idempotent.
   */
  async seedBuiltIn(
    entries: Array<{
      issuerUrl: string;
      displayName: string;
      description?: string;
      allowedScopes: string[];
    }>
  ): Promise<void> {
    for (const entry of entries) {
      const existing = await this.getByUrl(entry.issuerUrl);
      if (existing) {
        if (existing.isBuiltIn) {
          const allowedScopes = Array.from(
            new Set([...existing.allowedScopes, ...entry.allowedScopes])
          );
          if (allowedScopes.length !== existing.allowedScopes.length) {
            await db
              .update(trustedIssuers)
              .set({ allowedScopes, updatedAt: new Date() })
              .where(eq(trustedIssuers.id, existing.id));
          }
        }
        continue;
      }

      await db
        .insert(trustedIssuers)
        .values({
          issuerUrl: entry.issuerUrl,
          displayName: entry.displayName,
          description: entry.description ?? null,
          allowedScopes: entry.allowedScopes,
          status: "approved",
          isBuiltIn: true,
        })
        .onConflictDoNothing();
    }
  }
}
