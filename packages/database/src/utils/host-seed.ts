/**
 * HOST SEED — a person's standing approval for an agent ALSO covers the box
 * it runs on, when that box is the agent's (computers plan v2 §4, review K2,
 * decision c83e0661 "a standing approval must cover agent and computer").
 *
 * Why: the host step (`resolveAgentGovernanceDecision`) resolves an agent on a
 * computer twice — as itself and as its computer — and the stricter verdict
 * wins. An `auto` rule on the agent alone is therefore overridden by the
 * computer's default `propose`, and the agent's box can do nothing more than
 * a person's own computer. Loosening the host step would loosen every agent on
 * every computer; instead the SAME rule is written for the computer, at the
 * moment the person approves it for the agent. Nothing is loosened that the
 * person did not approve:
 *
 *   - only an `auto` rule for ONE agent (`principal_kind = 'agent'`) is
 *     seeded — never `propose` or `deny` (seeding those would tighten the
 *     computer for its other agents), never an `any` / `class` rule;
 *   - only onto the agent's own computer (`users.host_user_id`), and only when
 *     that computer belongs to an agent (`users.computer_belongs_to =
 *     'agent'`, 0388) AND has the same owner as the agent — a person's own or
 *     a shared computer stays strict (its agents are guests);
 *   - the seed is the same rule (scope, space, target, profile, expiry), so
 *     the computer may do exactly what the agent may do, nothing wider.
 *
 * Each seed names the agent rule it copies in `created_by`
 * (`system:host-seed:<agent rule id>`), so revoking that rule revokes its
 * seed (`revokeHostSeeds`), and a computer that stops belonging to an agent
 * loses every seed on it (`revokeAllHostSeedsOn`). The computer's own posture
 * and settings mirror never take a seed back (they skip this namespace).
 *
 * A computer set to `agent` AFTER rules were approved for its agents gets no
 * seed for them (named default, wave 53e873ed lane B4B5): nothing shows the
 * person what would be seeded yet.
 */
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import { users } from "../schema/users.js";
import {
  governanceRules,
  type GovernanceRule,
  type NewGovernanceRule,
} from "../schema/governance-rules.js";
import { MACHINE_CREATED_BY_PREFIX } from "./governance-rule-provenance.js";

type DbHandle = typeof import("../client-pg.js").db;
/** A handle or an open transaction: both run the same reads and writes. */
type DbOrTx = Pick<DbHandle, "select" | "insert" | "update">;

/** `created_by` of a seed: the machine namespace, then the agent rule's id. */
export const HOST_SEED_CREATED_BY_PREFIX = `${MACHINE_CREATED_BY_PREFIX}host-seed:`;

export function hostSeedCreatedBy(agentRuleId: string): string {
  return `${HOST_SEED_CREATED_BY_PREFIX}${agentRuleId}`;
}

/** `revoked_reason` of a seed revoked with the agent rule it copies. */
export const HOST_SEED_REVOKED_WITH_RULE = "host_seed_rule_revoked";
/** `revoked_reason` of a seed whose computer no longer belongs to an agent. */
export const HOST_SEED_REVOKED_NOT_AGENTS = "host_seed_computer_not_agents";

/** The rule fields a seed copies. */
export type SeedableRule = Pick<
  GovernanceRule,
  | "id"
  | "principalKind"
  | "agentUserId"
  | "scopeKind"
  | "workspaceId"
  | "targetKind"
  | "targetPattern"
  | "targetProfile"
  | "verdict"
  | "expiresAt"
>;

/**
 * The computer an agent's `auto` rules are also written for: its host, when
 * the host is a computer that belongs to an agent and has the agent's owner.
 * `null` otherwise (no computer, a person's own or a shared one, someone
 * else's).
 */
export async function seedHostFor(
  db: DbOrTx,
  agentUserId: string
): Promise<string | null> {
  // The host first: most agents have none, and then nothing else is read.
  const [agent] = await db
    .select({ hostUserId: users.hostUserId })
    .from(users)
    .where(eq(users.id, agentUserId));
  const hostUserId = agent?.hostUserId;
  if (!hostUserId || hostUserId === agentUserId) return null;
  const rows = await db
    .select({
      id: users.id,
      agentType: users.agentType,
      createdByUserId: users.createdByUserId,
      computerBelongsTo: users.computerBelongsTo,
    })
    .from(users)
    .where(inArray(users.id, [agentUserId, hostUserId]));
  const owner = rows.find((r) => r.id === agentUserId)?.createdByUserId;
  const host = rows.find((r) => r.id === hostUserId);
  return host &&
    owner &&
    host.agentType === MACHINE_AGENT_TYPE &&
    host.computerBelongsTo === "agent" &&
    host.createdByUserId === owner
    ? host.id
    : null;
}

/**
 * Write each seedable rule again for its agent's box (see the file header for
 * which are), with the rows as written (their ids): in the same transaction
 * when the writer has one. A seed that is not written leaves the box asking,
 * the stricter side. Returns the seeds' ids.
 */
export async function seedHostRules(
  db: DbOrTx,
  rules: readonly SeedableRule[]
): Promise<string[]> {
  const seedable = rules.filter(
    (r) => r.principalKind === "agent" && r.verdict === "auto" && r.agentUserId
  );
  if (seedable.length === 0) return [];
  const hostOf = new Map<string, string | null>();
  const values: NewGovernanceRule[] = [];
  for (const r of seedable) {
    const agentUserId = r.agentUserId!;
    if (!hostOf.has(agentUserId))
      hostOf.set(agentUserId, await seedHostFor(db, agentUserId));
    const host = hostOf.get(agentUserId);
    if (!host) continue;
    values.push({
      principalKind: "agent",
      agentUserId: host,
      scopeKind: r.scopeKind,
      workspaceId: r.scopeKind === "workspace" ? r.workspaceId : null,
      targetKind: r.targetKind,
      targetPattern: r.targetPattern,
      targetProfile: r.targetProfile,
      verdict: "auto",
      expiresAt: r.expiresAt,
      createdBy: hostSeedCreatedBy(r.id),
    });
  }
  if (values.length === 0) return [];
  const inserted = await db
    .insert(governanceRules)
    .values(values)
    .returning({ id: governanceRules.id });
  return inserted.map((r) => r.id);
}

/** Revoke the seeds of these agent rules (they were revoked). */
export async function revokeHostSeeds(
  db: DbOrTx,
  agentRuleIds: readonly string[]
): Promise<number> {
  if (agentRuleIds.length === 0) return 0;
  const revoked = await db
    .update(governanceRules)
    .set({ revokedAt: new Date(), revokedReason: HOST_SEED_REVOKED_WITH_RULE })
    .where(
      and(
        inArray(
          governanceRules.createdBy,
          agentRuleIds.map((id) => hostSeedCreatedBy(id))
        ),
        isNull(governanceRules.revokedAt)
      )
    )
    .returning({ id: governanceRules.id });
  return revoked.length;
}

/** Revoke every seed on a computer (it no longer belongs to an agent). */
export async function revokeAllHostSeedsOn(
  db: DbOrTx,
  computerUserId: string
): Promise<number> {
  const revoked = await db
    .update(governanceRules)
    .set({ revokedAt: new Date(), revokedReason: HOST_SEED_REVOKED_NOT_AGENTS })
    .where(
      and(
        eq(governanceRules.agentUserId, computerUserId),
        like(governanceRules.createdBy, `${HOST_SEED_CREATED_BY_PREFIX}%`),
        isNull(governanceRules.revokedAt)
      )
    )
    .returning({ id: governanceRules.id });
  return revoked.length;
}
