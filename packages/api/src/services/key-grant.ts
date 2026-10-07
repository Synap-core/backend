/**
 * W1f — minting a key WITH a grant.
 *
 * `GrantInputSchema` is the one wire shape every human-facing mint door accepts
 * (`apiKeys.create`, `apiKeys.createForWorkspace`, `/setup/service`).
 * `attachGrantOrRevoke` writes the grant through GrantRepository (the one write
 * door) right after the key exists; if that fails, the key is REVOKED before
 * the error propagates — a key minted for a narrow grant must never survive
 * as a legacy, ungranted (i.e. full-access) key.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db, eq, GrantRepository, GrantRoleRepository } from "@synap/database";
import { apiKeys } from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import {
  assertPermissions,
  InvalidPermissionError,
} from "@synap/governance-policy/grants";

export const GrantInputSchema = z.object({
  /** `<subject>[.<kind>].<action>` patterns, e.g. `entity.knowledge.read`. */
  permissions: z.array(z.string().min(1).max(120)).min(1).max(64),
  workspaceIds: z.array(z.string().uuid()).max(64).optional(),
  projectIds: z.array(z.string().uuid()).max(64).optional(),
  entityIds: z.array(z.string().uuid()).max(256).optional(),
  label: z.string().max(120).optional(),
  /**
   * The stored role this grant was built from (lineage). Recorded only when
   * the role is the minting person's own; the PERMISSIONS above are what bind
   * the key — a role is a template, never a live link.
   */
  roleId: z.string().uuid().optional(),
});
export type GrantInput = z.infer<typeof GrantInputSchema>;

/**
 * `expiresInDays` on human mints: omitted → 90 (DEFAULT_KEY_TTL_DAYS), a
 * number → that many days, `null` → never.
 */
export const ExpiresInDaysSchema = z
  .number()
  .int()
  .min(1)
  .max(36_500)
  .nullable()
  .optional();

/** Validate patterns at the door (400), before anything is minted. */
export function assertGrantInput(grant: GrantInput | undefined): void {
  if (!grant) return;
  try {
    assertPermissions(grant.permissions);
  } catch (err) {
    if (err instanceof InvalidPermissionError)
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    throw err;
  }
}

export async function attachGrantOrRevoke(args: {
  apiKeyId: string;
  principalUserId: string;
  onBehalfOf: string;
  grant: GrantInput;
  expiresAt: Date | null;
  createdBy: string;
  clientId?: string | null;
}): Promise<void> {
  const { grant, ...rest } = args;
  await attachGrantsOrRevoke({ ...rest, grants: [grant] });
}

/**
 * Several grants on ONE key — the key may act where ANY one permits, each on
 * its own (never their cross product). Same revoke-on-failure contract.
 */
export async function attachGrantsOrRevoke(args: {
  apiKeyId: string;
  principalUserId: string;
  onBehalfOf: string;
  grants: GrantInput[];
  expiresAt: Date | null;
  createdBy: string;
  clientId?: string | null;
}): Promise<void> {
  try {
    for (const grant of args.grants) {
      if (
        grant.roleId &&
        !(await new GrantRoleRepository(db).findOwned(
          args.onBehalfOf,
          grant.roleId
        ))
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That role is not one of yours.",
        });
    }
    await new GrantRepository(db).attachMany(
      args.grants.map((grant) => ({
        apiKeyId: args.apiKeyId,
        principalUserId: args.principalUserId,
        onBehalfOf: args.onBehalfOf,
        permissions: grant.permissions,
        workspaceIds: grant.workspaceIds ?? null,
        projectIds: grant.projectIds ?? null,
        entityIds: grant.entityIds ?? null,
        expiresAt: args.expiresAt,
        label: grant.label ?? null,
        clientId: args.clientId ?? null,
        roleId: grant.roleId ?? null,
        createdBy: args.createdBy,
      }))
    );
  } catch (err) {
    await revokeApiKeys(db, {
      where: eq(apiKeys.id, args.apiKeyId),
      revokedBy: args.createdBy,
      reason: "Grant could not be attached — key revoked",
    });
    throw err;
  }
}
