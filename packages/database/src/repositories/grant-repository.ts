/**
 * GrantRepository — the ONE write door for `grants` (W1, 2026-10-06).
 *
 * A grant bounds what one API key may touch; effective access is always
 * grant ∩ the human floor. Every insert validates its permission patterns with
 * the shared grammar (`@synap/governance-policy/grants`), so a malformed
 * pattern can never be stored and silently match nothing (or everything).
 *
 * One ACTIVE grant SET per key: `attach` / `attachMany` revoke every previous
 * active grant of the same key in the same transaction. A key with several
 * active grants may act where ANY one permits (`KeyGrant`): each grant is its
 * own (permissions × resources) scope, never merged with the others.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { assertPermissions } from "@synap/governance-policy/grants";
import { db } from "../client-pg.js";
import { grants, type GrantRecord } from "../schema/grants.js";
import type { KeyGrant } from "../utils/request-write-context.js";

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

const emptyToNull = (v?: string[] | null) =>
  v && v.length > 0 ? [...new Set(v)] : null;

export class GrantRepository {
  private readonly db: PostgresJsDatabase<any>;

  constructor(dbInstance: PostgresJsDatabase<any> = db) {
    this.db = dbInstance;
  }

  /** Attach a grant to a key (replacing its previous active grants). */
  async attach(input: AttachGrantInput): Promise<GrantRecord> {
    const [row] = await this.attachMany([input]);
    return row;
  }

  /**
   * Attach SEVERAL grants to ONE key, replacing its previous active grants, in
   * one transaction. Each input is a separate scope: the key may act where any
   * one of them permits — this is how a request set that is not a cross
   * product (People in Sales + Notes in Finance) is held without widening.
   */
  async attachMany(inputs: AttachGrantInput[]): Promise<GrantRecord[]> {
    if (inputs.length === 0) {
      throw new Error("attachMany needs at least one grant");
    }
    const apiKeyId = inputs[0].apiKeyId;
    if (inputs.some((i) => i.apiKeyId !== apiKeyId)) {
      throw new Error("attachMany attaches grants to ONE key");
    }
    for (const input of inputs) assertPermissions(input.permissions);
    return this.db.transaction(async (tx) => {
      await tx
        .update(grants)
        .set({ revokedAt: new Date(), revokedBy: inputs[0].createdBy })
        .where(and(eq(grants.apiKeyId, apiKeyId), isNull(grants.revokedAt)));
      return tx
        .insert(grants)
        .values(
          inputs.map((input) => ({
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
          }))
        )
        .returning();
    });
  }

  /**
   * What bounds this key:
   *   - `null`  — the key never had a grant (legacy key: scopes + human floor);
   *   - every active, unexpired grant, one scope each;
   *   - ONE DENY-ALL scope (no permissions) when none is active any more.
   *     Falling back to the ungranted behaviour there would turn a revocation
   *     into a widening.
   */
  async resolveForKey(apiKeyId: string): Promise<KeyGrant | null> {
    const rows = await this.db
      .select({
        permissions: grants.permissions,
        workspaceIds: grants.workspaceIds,
        projectIds: grants.projectIds,
        entityIds: grants.entityIds,
        expiresAt: grants.expiresAt,
        revokedAt: grants.revokedAt,
        // The app identity, carried so a write can be attributed "via <app>".
        clientId: grants.clientId,
      })
      .from(grants)
      .where(eq(grants.apiKeyId, apiKeyId))
      .orderBy(desc(grants.createdAt));
    if (rows.length === 0) return null;
    const now = new Date();
    const live = rows.filter(
      (r) => r.revokedAt === null && (r.expiresAt === null || r.expiresAt > now)
    );
    const clientId = (live[0] ?? rows[0]).clientId;
    if (live.length === 0) return { scopes: [{ permissions: [] }], clientId };
    return {
      scopes: live.map((r) => ({
        permissions: r.permissions,
        workspaceIds: r.workspaceIds,
        projectIds: r.projectIds,
        entityIds: r.entityIds,
      })),
      clientId,
    };
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
      .where(and(inArray(grants.apiKeyId, apiKeyIds), isNull(grants.revokedAt)))
      .returning({ id: grants.id });
    return rows.length;
  }
}
