/**
 * GrantRepository — the ONE write door for `grants` (W1, 2026-10-06).
 *
 * A grant bounds what one API key may touch; effective access is always
 * grant ∩ the human floor. Every insert validates its permission patterns with
 * the shared grammar (`@synap/governance-policy/grants`), so a malformed
 * pattern can never be stored and silently match nothing (or everything).
 *
 * One ACTIVE grant per key: `attach` revokes any previous active grant of the
 * same key in the same transaction.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { assertPermissions } from "@synap/governance-policy/grants";
import { db } from "../client-pg.js";
import { grants, type GrantRecord } from "../schema/grants.js";

export interface AttachGrantInput {
  apiKeyId: string;
  principalUserId: string;
  onBehalfOf: string;
  permissions: string[];
  workspaceIds?: string[] | null;
  projectIds?: string[] | null;
  entityIds?: string[] | null;
  /** null = never. */
  expiresAt: Date | null;
  label?: string | null;
  clientId?: string | null;
  /** The role it was minted from (lineage). */
  roleId?: string | null;
  createdBy: string;
}

/** The fields an enforcement point needs — what `resolveKeyIdentity` carries. */
export interface ActiveGrant {
  id: string;
  permissions: string[];
  workspaceIds: string[] | null;
  projectIds: string[] | null;
  entityIds: string[] | null;
  expiresAt: Date | null;
}

const emptyToNull = (v?: string[] | null) =>
  v && v.length > 0 ? [...new Set(v)] : null;

export class GrantRepository {
  private readonly db: PostgresJsDatabase<any>;

  constructor(dbInstance: PostgresJsDatabase<any> = db) {
    this.db = dbInstance;
  }

  /** Attach a grant to a key (replacing its previous active grant). */
  async attach(input: AttachGrantInput): Promise<GrantRecord> {
    assertPermissions(input.permissions);
    return this.db.transaction(async (tx) => {
      await tx
        .update(grants)
        .set({ revokedAt: new Date(), revokedBy: input.createdBy })
        .where(
          and(eq(grants.apiKeyId, input.apiKeyId), isNull(grants.revokedAt))
        );
      const [row] = await tx
        .insert(grants)
        .values({
          apiKeyId: input.apiKeyId,
          principalUserId: input.principalUserId,
          onBehalfOf: input.onBehalfOf,
          permissions: [...new Set(input.permissions.map((p) => p.trim()))],
          workspaceIds: emptyToNull(input.workspaceIds),
          projectIds: emptyToNull(input.projectIds),
          entityIds: emptyToNull(input.entityIds),
          expiresAt: input.expiresAt,
          label: input.label ?? null,
          clientId: input.clientId ?? null,
          roleId: input.roleId ?? null,
          createdBy: input.createdBy,
        })
        .returning();
      return row;
    });
  }

  /**
   * The grant that bounds this key:
   *   - `null`  — the key never had a grant (legacy key: scopes + human floor);
   *   - the active, unexpired grant;
   *   - a DENY-ALL grant (no permissions) when the key's grant was revoked or
   *     expired. Falling back to the ungranted behaviour there would turn a
   *     revocation into a widening.
   */
  async resolveForKey(apiKeyId: string): Promise<ActiveGrant | null> {
    const [row] = await this.db
      .select({
        id: grants.id,
        permissions: grants.permissions,
        workspaceIds: grants.workspaceIds,
        projectIds: grants.projectIds,
        entityIds: grants.entityIds,
        expiresAt: grants.expiresAt,
        revokedAt: grants.revokedAt,
      })
      .from(grants)
      .where(eq(grants.apiKeyId, apiKeyId))
      .orderBy(desc(grants.createdAt))
      .limit(1);
    if (!row) return null;
    const { revokedAt, ...grant } = row;
    const lapsed =
      revokedAt !== null ||
      (grant.expiresAt !== null && grant.expiresAt <= new Date());
    return lapsed ? { ...grant, permissions: [] } : grant;
  }

  /** Every grant made on a human's behalf (for /my-connections). */
  async listForUser(onBehalfOf: string): Promise<GrantRecord[]> {
    return this.db
      .select()
      .from(grants)
      .where(eq(grants.onBehalfOf, onBehalfOf))
      .orderBy(desc(grants.createdAt));
  }

  /**
   * Revoke the active grants bound to these key ids (the cascade a key rotation
   * or revoke owes). A rotated-away or revoked key otherwise leaves its `grants`
   * row active — the bearer stops, but the grant does not — and the read filter
   * that counts reach only from an ACTIVE key (`AppRepository`) is exactly what
   * hid that from the UI. `resolveForKey` reads a revoked grant as deny-all, so
   * this is what makes "the key stops working" true at the grant layer too.
   *
   * Only ACTIVE grants are touched: an already-revoked grant keeps its original
   * `revoked_by`. Returns how many grants were revoked.
   */
  async revokeForKeys(
    apiKeyIds: string[],
    revokedBy?: string | null
  ): Promise<number> {
    if (apiKeyIds.length === 0) return 0;
    const rows = await this.db
      .update(grants)
      .set({ revokedAt: new Date(), revokedBy: revokedBy ?? null })
      .where(
        and(inArray(grants.apiKeyId, apiKeyIds), isNull(grants.revokedAt))
      )
      .returning({ id: grants.id });
    return rows.length;
  }
}
