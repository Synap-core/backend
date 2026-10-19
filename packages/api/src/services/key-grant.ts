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
import {
  and,
  db,
  eq,
  gt,
  isNull,
  or,
  GrantRepository,
  GrantRoleRepository,
} from "@synap/database";
import { apiKeys, grants as grantRows, users } from "@synap/database/schema";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import {
  MAX_GRANT_PERMISSIONS,
  meetScope,
  pinningWithin,
} from "@synap-core/types/grants";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import {
  assertPermissions,
  InvalidPermissionError,
} from "@synap/governance-policy/grants";
import { requestsFromGrantScopes, requestsWithin } from "./agent-connect.js";

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
    // A hosted agent never holds more than its computer; a computer whose
    // grant changed re-clips the agents it hosts (MACHINE-IDENTITY-PLAN §2c).
    // Inside the try: if the clip fails, the key is revoked below.
    await clipHostedAgentGrants(args.principalUserId, args.createdBy);
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

/**
 * `wanted`, cut down to what the holder's live grants reach — one grant per
 * (wanted × live) overlap, never wider than either, each ending no later than
 * its live grant nor `keyEndsAt`. Each overlap is the exact meet of the two
 * (`meetScope`, @synap-core/types/grants algebra): a permission only partly
 * inside a live one is cut to the part they share — `entity.note` against
 * `entity.read` keeps `entity.note.read`, it is no longer dropped.
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
      const met = meetScope(w, l);
      if (!met) continue;
      out.push({
        permissions: met.permissions,
        ...(met.workspaceIds ? { workspaceIds: met.workspaceIds } : {}),
        ...(met.projectIds ? { projectIds: met.projectIds } : {}),
        ...(met.entityIds ? { entityIds: met.entityIds } : {}),
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
  let endsAt: Date | null = null;
  let first = true;
  for (const request of requestsFromGrantScopes([grant])) {
    const covering = live.filter(
      (l) =>
        pinningWithin(grant.projectIds, l.projectIds) &&
        pinningWithin(grant.entityIds, l.entityIds) &&
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

// ---------------------------------------------------------------------------
// Hosted agents never exceed their computer (MACHINE-IDENTITY-PLAN §2c).
// ---------------------------------------------------------------------------

/**
 * What a principal may touch right now: the live grants of every key it holds
 * that still works (active, not revoked, not expired). Empty = nothing — a
 * computer whose keys were all revoked lends its agents nothing.
 */
async function liveGrantsOfPrincipal(
  userId: string
): Promise<LiveGrantScope[]> {
  const now = new Date();
  const keys = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.isActive, true),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now))
      )
    );
  const out: LiveGrantScope[] = [];
  for (const key of keys) out.push(...(await liveGrantsOfKey(key.id)));
  return out;
}

/** One scope, written so two equal reaches compare equal. */
function scopeKey(s: {
  permissions: readonly string[];
  workspaceIds?: readonly string[] | null;
  projectIds?: readonly string[] | null;
  entityIds?: readonly string[] | null;
  expiresAt?: Date | null;
}): string {
  const sorted = (v?: readonly string[] | null) =>
    v && v.length > 0 ? [...new Set(v)].sort() : null;
  return JSON.stringify([
    sorted(s.permissions),
    sorted(s.workspaceIds),
    sorted(s.projectIds),
    sorted(s.entityIds),
    s.expiresAt ? s.expiresAt.getTime() : null,
  ]);
}

/**
 * THE ONE DOOR that keeps "an agent never exceeds its computer" true for
 * ACCESS. Call it after EVERY grant write, with the principal whose grants
 * changed:
 *   - a COMPUTER (`agent_type = 'machine'`): every agent it hosts
 *     (`users.host_user_id`) is re-clipped to its new reach — the narrowing
 *     or revoke of a computer reaches its agents at once;
 *   - a HOSTED agent: that agent is clipped to its computer's live grants;
 *   - anyone else: nothing to do (one indexed read).
 *
 * A write-time invariant, not a second evaluator: `KeyGrant` stays "any one
 * scope permits" and no consumer intersects anything at request time. Each
 * key's live grants are intersected with the computer's (`scopesWithinLive`,
 * the same rule `/setup/agent` bounds a new key with) and replaced only when
 * that changes them; a key left with nothing in common touches nothing (its
 * live grants revoked). Fails CLOSED: a key whose clip throws has its live
 * grants revoked before the error propagates. Returns how many keys changed.
 *
 * Tripwire: `__tripwires__/hosted-agent-grant-clip.tripwire.test.ts` derives
 * every grant-write site and asserts each one calls this.
 */
export async function clipHostedAgentGrants(
  principalUserId: string,
  by: string
): Promise<number> {
  const [principal] = await db
    .select({
      id: users.id,
      agentType: users.agentType,
      hostUserId: users.hostUserId,
    })
    .from(users)
    .where(eq(users.id, principalUserId))
    .limit(1);
  if (!principal) return 0;

  let hostUserId: string;
  let agentIds: string[];
  if (principal.agentType === MACHINE_AGENT_TYPE) {
    hostUserId = principal.id;
    agentIds = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.hostUserId, principal.id))
    ).map((r) => r.id);
  } else if (principal.hostUserId) {
    hostUserId = principal.hostUserId;
    agentIds = [principal.id];
  } else {
    return 0;
  }
  if (agentIds.length === 0) return 0;

  const hostLive = await liveGrantsOfPrincipal(hostUserId);
  const repo = new GrantRepository(db);
  let changed = 0;
  for (const agentId of agentIds) {
    const keys = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, agentId), isNull(apiKeys.revokedAt)));
    for (const key of keys) {
      try {
        const now = Date.now();
        const live = (
          await db
            .select()
            .from(grantRows)
            .where(
              and(eq(grantRows.apiKeyId, key.id), isNull(grantRows.revokedAt))
            )
        ).filter(
          (r) =>
            r.permissions.length > 0 &&
            (r.expiresAt === null || r.expiresAt.getTime() > now)
        );
        if (live.length === 0) continue; // already touches nothing
        const clipped = new Map<
          string,
          {
            row: (typeof live)[number];
            scope: GrantInput & { expiresAt: Date | null };
          }
        >();
        for (const row of live)
          for (const scope of scopesWithinLive([row], hostLive, row.expiresAt))
            clipped.set(scopeKey(scope), { row, scope });
        const before = new Set(live.map((r) => scopeKey(r)));
        const same =
          before.size === clipped.size &&
          [...clipped.keys()].every((k) => before.has(k));
        if (same) continue;
        changed++;
        if (clipped.size === 0) {
          await repo.revokeForKeys([key.id], by);
          continue;
        }
        await repo.attachMany(
          [...clipped.values()].map(({ row, scope }) => ({
            apiKeyId: key.id,
            principalUserId: row.principalUserId,
            onBehalfOf: row.onBehalfOf,
            permissions: scope.permissions,
            workspaceIds: scope.workspaceIds ?? null,
            projectIds: scope.projectIds ?? null,
            entityIds: scope.entityIds ?? null,
            expiresAt: scope.expiresAt,
            label: row.label,
            clientId: row.clientId,
            roleId: row.roleId,
            createdBy: by,
          }))
        );
      } catch (err) {
        await repo.revokeForKeys([key.id], by);
        throw err;
      }
    }
  }
  return changed;
}
