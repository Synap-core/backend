/**
 * Property-def RETIRE — the governed retirement of a FIELD (a `property_defs`
 * row), mirroring `retire-profile.ts` (pod hygiene D5/D7) for kinds.
 *
 * THE GAP IT CLOSES: the only removal door was tRPC `propertyDefs.delete`, a
 * HUMAN door, ungoverned, and gated with `assertWorkspaceWrite` on the row —
 * whose no-owner branch denies a global or profile-base def (workspace_id NULL)
 * to EVERYONE, the founder included. Those defs could only be removed by raw
 * SQL. This door reaches them through the SAME authority rule `propertyDefs.
 * update` already applies ({@link assertPropertyDefSchemaWrite}), behind a
 * review step.
 *
 * POLICY — identical to `profile.propose_retire`:
 *   - ALWAYS a PENDING proposal, for a human too (filed directly by
 *     `insertPendingProposal`, DIRECT door `property_def/retire`). The propose
 *     half has NO execute branch, so there is nothing for
 *     `checkPermissionOrPropose` to decide and no attribution miss that could
 *     turn it into a direct write.
 *   - Authority on the LOADED row, before any count is returned: overlay def →
 *     editor+ of its workspace; base def → the owning profile's schema writer
 *     (a system kind ⇒ pod admin); global def → pod admin.
 *   - ONE preflight (`inspectPropertyDefRetirement` → pure
 *     `decidePropertyDefRetirement`) read by the propose door AND the approval
 *     half, so a value written between filing and approval refuses at approval.
 *
 * SEMANTICS — where this DIVERGES from kind retirement, stated:
 *   - HARD delete, not soft. `property_defs` has no `is_active` / tombstone
 *     column (a kind has `is_active`), so "retire" is the existing
 *     `propertyDefs.delete` semantics: the row goes; `profile_properties` links
 *     and `entity_property_index` rows cascade by FK.
 *   - USAGE REFUSES, with NO data migration offered. A kind's refusal files a
 *     `profile/merge` when a same-slug twin or same-name sibling exists; a field
 *     has no such merge target model yet (the conversions engine's
 *     `renamePropertyKey` could back one — not built here). The refusal says
 *     what to move or clear first.
 *
 * WHAT THE PREFLIGHT COUNTS (pod-wide, like the kind preflight — a value in a
 * workspace the caller cannot see is still a value):
 *   BLOCKS: `entity_property_index` rows for the def; live entities of the
 *     def's profile whose `properties` JSON carries the slug (the index can lag
 *     the JSON); live facets of the def's profile carrying the slug.
 *   REPORTED: `profile_properties` links (they cascade), a relation mapping.
 * NOT covered (measured, stated): a view filter / sort / column naming the slug
 * in its JSON config, a cell or prompt naming it in prose.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  isNull,
  drizzleSql,
  propertyDefs,
  entities,
  entityFacets,
  profileProperties,
  proposals,
  ProposalStatus,
  ProfileRepository,
  insertPendingProposal,
} from "@synap/database";
import { entityPropertyIndex } from "@synap/database/schema";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { createLogger } from "@synap-core/core";
import { assertProfileSchemaWrite } from "../../utils/profile-schema-write-access.js";
import { auditLog } from "../../utils/audit-log.js";

const logger = createLogger({ module: "pod-hygiene-retire-property-def" });

// ── Authority ────────────────────────────────────────────────────────────────

/**
 * WHOSE SCHEMA a property def is — the owner `assertProfileSchemaWrite` is
 * asked about, decided on the LOADED row, never a request value. The ONE
 * derivation, shared by `propertyDefs.update`, `propertyDefs.proposeRetire`
 * and this retirement:
 *   • overlay def (workspaceId set) → editor+ of THAT workspace;
 *   • base def on a profile        → that profile's owner (a system kind's
 *                                    base def ⇒ pod admin);
 *   • global def (no profile)      → pod admin (the empty owner).
 */
export async function resolvePropertyDefSchemaOwner(
  database: unknown,
  def: { id: string; workspaceId: string | null; profileId: string | null }
): Promise<{ workspaceId?: string | null; userId?: string | null }> {
  if (def.workspaceId) return { workspaceId: def.workspaceId };
  if (!def.profileId) return {};
  const owningProfile = await new ProfileRepository(
    database as ConstructorParameters<typeof ProfileRepository>[0]
  ).getById(def.profileId);
  if (!owningProfile) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Profile not found for property definition: ${def.id}`,
    });
  }
  return owningProfile;
}

/** The schema-write floor on a def (level editor — any change is not additive). */
export async function assertPropertyDefSchemaWrite(
  database: unknown,
  userId: string,
  def: { id: string; workspaceId: string | null; profileId: string | null }
): Promise<void> {
  await assertProfileSchemaWrite(
    database,
    userId,
    await resolvePropertyDefSchemaOwner(database, def),
    { level: "editor", actingWorkspaceId: null }
  );
}

// ── Preflight ────────────────────────────────────────────────────────────────

export interface RetirePropertyDefRow {
  id: string;
  slug: string;
  profileId: string | null;
  workspaceId: string | null;
  valueType: string;
  relationDefId: string | null;
}

export interface PropertyDefDependents {
  /** `entity_property_index` rows for this def. */
  indexedValues: number;
  /** Live entities of the def's profile whose JSON carries the slug. */
  entityValues: number;
  /** Live facets of the def's profile whose JSON carries the slug. */
  facetValues: number;
  /** `profile_properties` links — they cascade with the def. */
  profileLinks: number;
}

export type PropertyDefRetireDecision =
  { verdict: "retirable" } | { verdict: "refused"; reasons: string[] };

/** PURE: the verdict. Every caller reads this one function. */
export function decidePropertyDefRetirement(
  d: PropertyDefDependents
): PropertyDefRetireDecision {
  const reasons: string[] = [];
  if (d.indexedValues > 0)
    reasons.push(
      `${d.indexedValues} stored value(s) are indexed for this field`
    );
  if (d.entityValues > 0)
    reasons.push(`${d.entityValues} record(s) still carry a value for it`);
  if (d.facetValues > 0)
    reasons.push(`${d.facetValues} role facet(s) still carry a value for it`);
  return reasons.length === 0
    ? { verdict: "retirable" }
    : { verdict: "refused", reasons };
}

const countOf = () => drizzleSql<number>`cast(count(*) as integer)`;

export async function inspectPropertyDefRetirement(defId: string): Promise<{
  def: RetirePropertyDefRow;
  dependents: PropertyDefDependents;
  decision: PropertyDefRetireDecision;
} | null> {
  const [def] = await db
    .select({
      id: propertyDefs.id,
      slug: propertyDefs.slug,
      profileId: propertyDefs.profileId,
      workspaceId: propertyDefs.workspaceId,
      valueType: propertyDefs.valueType,
      relationDefId: propertyDefs.relationDefId,
    })
    .from(propertyDefs)
    .where(eq(propertyDefs.id, defId))
    .limit(1);
  if (!def) return null;

  const hasKey = (col: unknown) => drizzleSql`${col} ? ${def.slug}`;
  const [[idx], ent, fac, [links]] = await Promise.all([
    db
      .select({ n: countOf() })
      .from(entityPropertyIndex)
      .where(eq(entityPropertyIndex.propertyDefId, def.id)),
    def.profileId
      ? db
          .select({ n: countOf() })
          .from(entities)
          .where(
            and(
              eq(entities.profileId, def.profileId),
              isNull(entities.deletedAt),
              hasKey(entities.properties)
            )
          )
      : Promise.resolve([{ n: 0 }]),
    def.profileId
      ? db
          .select({ n: countOf() })
          .from(entityFacets)
          .where(
            and(
              eq(entityFacets.profileId, def.profileId),
              isNull(entityFacets.deletedAt),
              hasKey(entityFacets.properties)
            )
          )
      : Promise.resolve([{ n: 0 }]),
    db
      .select({ n: countOf() })
      .from(profileProperties)
      .where(eq(profileProperties.propertyDefId, def.id)),
  ]);

  const dependents: PropertyDefDependents = {
    indexedValues: Number(idx?.n ?? 0),
    entityValues: Number(ent[0]?.n ?? 0),
    facetValues: Number(fac[0]?.n ?? 0),
    profileLinks: Number(links?.n ?? 0),
  };
  return {
    def: def as RetirePropertyDefRow,
    dependents,
    decision: decidePropertyDefRetirement(dependents),
  };
}

/** PURE: the rows a retire review card renders. */
export function propertyDefRetireReviewRows(
  def: RetirePropertyDefRow,
  d: PropertyDefDependents
): Record<string, string | number> {
  return {
    field: def.slug,
    scope: def.workspaceId
      ? "Space overlay"
      : def.profileId
        ? "Base field of its kind (every space)"
        : "Global (every kind)",
    stored_values: d.indexedValues + d.entityValues + d.facetValues,
    kinds_linking_it: d.profileLinks,
    on_approve:
      "The field definition is deleted. Its links to kinds go with it. No record loses a value: a field that still holds values cannot be retired.",
  };
}

// ── Propose door ─────────────────────────────────────────────────────────────

export type ProposePropertyDefRetireResult =
  | {
      status: "proposed";
      proposalId: string;
      dependents: PropertyDefDependents;
    }
  | { status: "already_pending"; proposalId: string }
  | {
      status: "refused";
      reasons: string[];
      dependents: PropertyDefDependents;
      /** Always null: no field data migration exists yet (see file header). */
      migrationProposalId: null;
      noMigrationReason: string;
    };

export const NO_FIELD_MIGRATION_REASON =
  "No field data migration is offered. Move the values to another field or clear them, then retire.";

async function pendingRetireFor(defId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, "property_def"),
        eq(proposals.proposalType, "retire"),
        eq(proposals.targetId, defId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * File a `property_def/retire` proposal — or REFUSE when the field still holds
 * values. Never writes the def. Authority is decided on the LOADED row before
 * any dependency number is returned.
 */
export async function proposePropertyDefRetire(params: {
  userId: string;
  propertyDefId: string;
  agentUserId?: string | null;
  reason?: string;
}): Promise<ProposePropertyDefRetireResult> {
  const inspection = await inspectPropertyDefRetirement(params.propertyDefId);
  if (!inspection) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Property definition not found: ${params.propertyDefId}`,
    });
  }
  const { def, dependents, decision } = inspection;
  await assertPropertyDefSchemaWrite(db, params.userId, def);

  if (decision.verdict === "refused") {
    return {
      status: "refused",
      reasons: decision.reasons,
      dependents,
      migrationProposalId: null,
      noMigrationReason: NO_FIELD_MIGRATION_REASON,
    };
  }

  const existing = await pendingRetireFor(def.id);
  if (existing) return { status: "already_pending", proposalId: existing };

  const { proposal } = await insertPendingProposal({
    workspaceId: def.workspaceId,
    targetType: "property_def",
    targetId: def.id,
    proposalType: "retire",
    data: {
      sourceId: params.userId,
      id: def.id,
      slug: def.slug,
      profileId: def.profileId,
      scopeWorkspaceId: def.workspaceId,
      dependents,
      changeType: "update",
      properties: propertyDefRetireReviewRows(def, dependents),
      summary: buildObjectActionTitle({
        action: "retire",
        objectKind: "property_def",
        objectName: def.slug,
      }),
      reasoning:
        params.reason ??
        "Nothing stores a value in this field. Retiring deletes its definition; no record loses data.",
    },
    createdBy: params.userId,
    proposedByUserId: params.agentUserId ? null : params.userId,
    subjectUserId: params.userId,
    ...(params.agentUserId ? { agentUserId: params.agentUserId } : {}),
  });
  return { status: "proposed", proposalId: proposal.id, dependents };
}

// ── Apply (approval half) ────────────────────────────────────────────────────

/**
 * Delete at APPROVAL time. Re-runs the preflight AND the authority floor on
 * the APPROVER: a value written since filing refuses (the proposal lands
 * APPROVAL_FAILED, retryable) instead of cascading it away.
 */
export async function applyPropertyDefRetire(params: {
  propertyDefId: string;
  approverUserId: string;
  sourceProposalId: string;
}): Promise<
  | { applied: "verified"; deletedIds: string[] }
  | { applied: "none"; reason: string }
> {
  const inspection = await inspectPropertyDefRetirement(params.propertyDefId);
  if (!inspection) {
    return { applied: "none", reason: "The field was already removed." };
  }
  const { def, decision } = inspection;
  await assertPropertyDefSchemaWrite(db, params.approverUserId, def);
  if (decision.verdict === "refused") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Retire refused at approval: ${decision.reasons.join("; ")}`,
    });
  }

  // The receipt is the DELETE's own RETURNING, never "we got here".
  const deleted = await db
    .delete(propertyDefs)
    .where(eq(propertyDefs.id, def.id))
    .returning({ id: propertyDefs.id });

  void auditLog({
    subjectType: "property_def",
    action: "retire",
    phase: "completed",
    subjectId: def.id,
    userId: params.approverUserId,
    workspaceId: def.workspaceId,
    proposalId: params.sourceProposalId,
  });
  logger.info(
    {
      propertyDefId: def.id,
      slug: def.slug,
      proposalId: params.sourceProposalId,
    },
    "property def retired (deleted) through an approved proposal"
  );
  return { applied: "verified", deletedIds: deleted.map((r) => r.id) };
}
