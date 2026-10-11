/**
 * W1f — minting a key WITH a grant.
 *
 * `GrantInputSchema` is the one wire shape every human-facing mint door accepts
 * (`apiKeys.create`, `apiKeys.createForWorkspace`, `/setup/service`).
 * `attachGrantOrRevoke` writes the grant through GrantRepository (the one write
 * door) right after the key exists; if that fails, the key is REVOKED before
 * the error propagates — a key minted for a narrow grant must never survive
 * without one.
 *
 * P5 — deny by default: a key with no grant row may touch NOTHING, so every
 * mint door attaches one. A door whose key is the holder's own full reach (the
 * person's CLI, a system/service/IS key) attaches `attachFullAccessGrant` —
 * an explicit `*`, shown and revocable like any other grant.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db, eq, GrantRepository, GrantRoleRepository } from "@synap/database";
import { apiKeys } from "@synap/database/schema";
import { MAX_GRANT_PERMISSIONS } from "@synap-core/types/grants";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import {
  assertPermissions,
  InvalidPermissionError,
} from "@synap/governance-policy/grants";
import {
  permissionCovers,
  requestsFromGrantScopes,
  requestsWithin,
} from "./agent-connect.js";

export const GrantInputSchema = z.object({
  /** `<subject>[.<kind>].<action>` patterns, e.g. `entity.knowledge.read`. */
  permissions: z
    .array(z.string().min(1).max(120))
    .min(1)
    .max(MAX_GRANT_PERMISSIONS),
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

/** What an explicit full-access grant is called on every key list. */
export const FULL_ACCESS_GRANT_LABEL = "Full access";

/**
 * Attach the explicit full-access `*` grant to a key minted as its holder's
 * own full reach — still bounded by the holder's floor, never wider. Same
 * revoke-on-failure contract as `attachGrantOrRevoke`.
 */
export async function attachFullAccessGrant(args: {
  apiKeyId: string;
  principalUserId: string;
  onBehalfOf: string;
  /** The key's own expiry (null = never). */
  expiresAt: Date | null;
  createdBy: string;
}): Promise<void> {
  await attachGrantOrRevoke({
    ...args,
    grant: { permissions: ["*"], label: FULL_ACCESS_GRANT_LABEL },
  });
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
  /** A grant's own `expiresAt` (null = never) overrides `expiresAt` below. */
  grants: Array<GrantInput & { expiresAt?: Date | null }>;
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
        expiresAt:
          grant.expiresAt !== undefined ? grant.expiresAt : args.expiresAt,
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

/** One live grant a key holds, with its own end (null = never). */
export interface LiveGrantScope {
  permissions: string[];
  workspaceIds: string[] | null;
  projectIds: string[] | null;
  entityIds: string[] | null;
  expiresAt: Date | null;
}

/**
 * Every live grant a key holds. EMPTY = it may touch nothing (P5, deny by
 * default: never granted, or every grant ended).
 */
export async function liveGrantsOfKey(
  apiKeyId: string
): Promise<LiveGrantScope[]> {
  const reach = (await new GrantRepository(db).reachForKeys([apiKeyId])).get(
    apiKeyId
  );
  return (reach?.grants ?? [])
    .filter((g) => g.permissions.length > 0)
    .map((g) => ({
      permissions: [...g.permissions],
      workspaceIds: g.workspaceIds ? [...g.workspaceIds] : null,
      projectIds: g.projectIds ? [...g.projectIds] : null,
      entityIds: g.entityIds ? [...g.entityIds] : null,
      expiresAt: g.expiresAt ?? null,
    }));
}

/** The earlier of two ends (null = never). */
export function earlierEnd(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

type ScopeShape = {
  permissions: readonly string[];
  workspaceIds?: readonly string[] | null;
  projectIds?: readonly string[] | null;
  entityIds?: readonly string[] | null;
};

/** Both pinnings at once (null = unpinned); `undefined` = they share nothing. */
function bothPinnings(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined
): string[] | null | undefined {
  if (!a?.length) return b?.length ? [...b] : null;
  if (!b?.length) return [...a];
  const shared = a.filter((x) => b.includes(x));
  return shared.length > 0 ? shared : undefined;
}

/**
 * `wanted`, cut down to what the holder's live grants reach — one grant per
 * (wanted × live) overlap, never wider than either, each ending no later than
 * its live grant nor `keyEndsAt`. A permission only partly inside a live one
 * is narrowed to the live one's (`permissionCovers`, the `agent/connect` rule).
 * `[{ permissions: ['*'] }]` = copy the live grants. Empty = no overlap.
 */
export function scopesWithinLive(
  wanted: readonly ScopeShape[],
  live: readonly LiveGrantScope[],
  keyEndsAt: Date | null
): Array<GrantInput & { expiresAt: Date | null }> {
  const out: Array<GrantInput & { expiresAt: Date | null }> = [];
  for (const w of wanted)
    for (const l of live) {
      const workspaceIds = bothPinnings(w.workspaceIds, l.workspaceIds);
      const projectIds = bothPinnings(w.projectIds, l.projectIds);
      const entityIds = bothPinnings(w.entityIds, l.entityIds);
      if (
        workspaceIds === undefined ||
        projectIds === undefined ||
        entityIds === undefined
      )
        continue;
      const permissions = new Set<string>();
      for (const p of w.permissions)
        for (const q of l.permissions) {
          if (permissionCovers(q, p)) permissions.add(p);
          else if (permissionCovers(p, q)) permissions.add(q);
        }
      if (permissions.size === 0) continue;
      out.push({
        permissions: [...permissions],
        ...(workspaceIds ? { workspaceIds } : {}),
        ...(projectIds ? { projectIds } : {}),
        ...(entityIds ? { entityIds } : {}),
        expiresAt: earlierEnd(l.expiresAt, keyEndsAt),
      });
    }
  return out;
}

/**
 * Is `grant` inside the holder's live grants? Each (permission × space) it asks
 * for must be covered (`requestsWithin`) by ONE live grant whose project and
 * object pinning it keeps. Returns when that cover ends (the earliest of the
 * latest covering ends), or `null` when it reaches beyond them.
 */
export function grantWithinLive(
  grant: ScopeShape,
  live: readonly LiveGrantScope[]
): { endsAt: Date | null } | null {
  const keeps = (
    outer: readonly string[] | null,
    inner: readonly string[] | null | undefined
  ) =>
    !outer?.length ||
    (!!inner?.length && inner.every((x) => outer.includes(x)));
  let endsAt: Date | null = null;
  let first = true;
  for (const request of requestsFromGrantScopes([grant])) {
    const covering = live.filter(
      (l) =>
        keeps(l.projectIds, grant.projectIds) &&
        keeps(l.entityIds, grant.entityIds) &&
        requestsWithin([request], requestsFromGrantScopes([l]))
    );
    if (covering.length === 0) return null;
    const latest = covering.some((l) => l.expiresAt === null)
      ? null
      : covering.reduce<Date>(
          (m, l) => (l.expiresAt! > m ? l.expiresAt! : m),
          covering[0]!.expiresAt!
        );
    endsAt = first ? latest : earlierEnd(endsAt, latest);
    first = false;
  }
  return first ? null : { endsAt };
}
