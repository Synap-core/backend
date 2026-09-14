/**
 * Profile RETIRE — the governed, soft, reversible retirement of a kind
 * (pod hygiene, founder decisions D5 + D7, 2026-09-14).
 *
 *   D5  Retiring a kind that still HAS entities is REFUSED, and the refusal
 *       PROPOSES a merge (the conversions engine's `mergeInto` /
 *       `dedupeProfileRows`, filed as a `profile/merge` proposal).
 *   D7  Retire is SOFT: `ProfileRepository.delete()` flips `is_active=false`,
 *       reversible with `ProfileRepository.reactivate()`. No auto-purge.
 *
 * ONE preflight (`inspectProfileRetirement` → pure `decideRetirement`) is read
 * by all three callers — the propose door, the `profile/retire` executor, and
 * the cleanup pack's retire item — so a dependency that appears between filing
 * and approval refuses at approval exactly as it would have refused at filing.
 *
 * ── What the preflight counts, and why the counts are POD-WIDE ───────────────
 * A dependency in a workspace the caller cannot see is still a dependency: a
 * floored count would read "0 entities" and retire a kind another member's
 * records still use. The counts are therefore unfloored, and are only ever
 * returned AFTER `assertProfileSchemaWrite` has admitted the caller as a
 * schema writer of that row.
 *
 *   BLOCKS, with a merge suggestion (usage):  live entities, live facets.
 *   BLOCKS, no merge (wiring would go silent): views scoping the row id;
 *     automations whose `triggerConfig.profileSlug` names the slug — counted
 *     only when this is the slug's LAST active row, since a twin keeps the
 *     trigger resolvable. A compiled rule IS an automation, so rules keyed on
 *     the slug are covered through the automation they produced.
 *   REPORTED only:  profile_relations rows (the kind's own schema; a soft
 *     retire leaves them in place and a reactivate brings them back).
 *
 * NOT covered (measured, stated): an IS prompt, a skill body or a cell that
 * names the slug in prose — no structured column carries those.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  sql,
  and,
  eq,
  ne,
  or,
  desc,
  inArray,
  isNull,
  drizzleSql,
  profiles,
  entities,
  entityFacets,
  views,
  automations,
  profileRelations,
  proposals,
  ProposalStatus,
  ProfileScope,
  ProfileResolutionService,
  markProfileRetired,
  readProfileRetirement,
  insertPendingProposal,
  runConversions,
  type ConversionOp,
  type Profile,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { assertProfileSchemaWrite } from "../../utils/profile-schema-write-access.js";
import { isPodAdmin } from "../../utils/workspace-role.js";
import { auditLog } from "../../utils/audit-log.js";

const logger = createLogger({ module: "pod-hygiene-retire-profile" });

// ── Types ────────────────────────────────────────────────────────────────────

export interface RetireProfileRow {
  id: string;
  slug: string;
  displayName: string;
  scope: string;
  workspaceId: string | null;
  userId: string | null;
  profileKind: string;
  isActive: boolean;
  /** Carries the retirement tombstone (`ui_hints.retired`). */
  uiHints: Profile["uiHints"];
  createdAt: Date;
}

/** The ONE retired reading: soft-deleted, or tombstoned by `markProfileRetired`. */
function isRetiredRow(row: Pick<Profile, "isActive" | "uiHints">): boolean {
  return !row.isActive || readProfileRetirement(row) !== null;
}

export interface RetireDependents {
  entities: number;
  liveFacets: number;
  views: number;
  /** `null` = not counted because another active row keeps the slug live. */
  automations: number | null;
  profileRelations: number;
}

/** A merge the conversions engine can apply, named against a real row. */
export type MergeSuggestion =
  | {
      op: "dedupeProfileRows";
      slug: string;
      canonical: "system" | "earliest";
      /** The row the engine will keep — named so the reviewer sees it. */
      canonicalProfileId: string;
    }
  | {
      op: "mergeInto";
      fromSlug: string;
      intoSlug: string;
      intoProfileId: string;
    };

export type RetireDecision =
  | { verdict: "retirable" }
  | { verdict: "already_retired" }
  | { verdict: "system" }
  | {
      verdict: "refused";
      reasons: string[];
      /** Present only when the refusal is about USAGE (entities / facets). */
      mergeSuggestion: MergeSuggestion | null;
      /** Why no merge was suggested, when usage blocked but none was found. */
      noMergeReason: string | null;
    };

export interface RetireInspection {
  profile: RetireProfileRow;
  dependents: RetireDependents;
  decision: RetireDecision;
}

// ── Pure decision ────────────────────────────────────────────────────────────

const SCOPE_RANK: Record<ProfileScope, number> = {
  [ProfileScope.SYSTEM]: 0,
  [ProfileScope.SHARED]: 1,
  [ProfileScope.WORKSPACE]: 2,
  [ProfileScope.USER]: 3,
};

/**
 * PURE: pick a merge target for a row that still has usage.
 *
 * - A TWIN (another active row, same slug, same kind) collapses through
 *   `dedupeProfileRows`. The engine chooses the survivor itself, so the
 *   suggestion names the SAME rule the engine applies (`system` when a system
 *   row exists, else `earliest`) and refuses to suggest a collapse whose
 *   survivor would be the very row being retired.
 * - Otherwise a DIFFERENT slug with the same display name, same kind, same
 *   scope and same workspace merges through `mergeInto` — the engine's
 *   same-scope pairing predicate, so the op it is handed can actually pair.
 */
export function pickMergeSuggestion(
  profile: RetireProfileRow,
  siblings: readonly RetireProfileRow[]
): { suggestion: MergeSuggestion | null; reason: string | null } {
  const live = siblings.filter(
    (s) =>
      s.isActive && s.id !== profile.id && s.profileKind === profile.profileKind
  );

  const twins = live.filter((s) => s.slug === profile.slug);
  if (twins.length > 0) {
    const all = [profile, ...twins];
    const hasSystem = all.some((r) => r.scope === ProfileScope.SYSTEM);
    const survivor = hasSystem
      ? all.find((r) => r.scope === ProfileScope.SYSTEM)!
      : [...all].sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            (SCOPE_RANK[a.scope as ProfileScope] ?? 9) -
              (SCOPE_RANK[b.scope as ProfileScope] ?? 9)
        )[0]!;
    if (survivor.id === profile.id) {
      return {
        suggestion: null,
        reason: `This row is the one the engine would keep when collapsing the '${profile.slug}' twins, so a merge would drain the other rows INTO it — retire one of the other rows instead.`,
      };
    }
    return {
      suggestion: {
        op: "dedupeProfileRows",
        slug: profile.slug,
        canonical: hasSystem ? "system" : "earliest",
        canonicalProfileId: survivor.id,
      },
      reason: null,
    };
  }

  const name = profile.displayName.trim().toLowerCase();
  const namesake = live.find(
    (s) =>
      s.slug !== profile.slug &&
      s.displayName.trim().toLowerCase() === name &&
      s.scope === profile.scope &&
      (s.workspaceId ?? null) === (profile.workspaceId ?? null)
  );
  if (namesake) {
    return {
      suggestion: {
        op: "mergeInto",
        fromSlug: profile.slug,
        intoSlug: namesake.slug,
        intoProfileId: namesake.id,
      },
      reason: null,
    };
  }

  return {
    suggestion: null,
    reason:
      "No same-slug twin and no same-name kind in the same scope and workspace — there is no merge target to suggest. Move or delete the records first, then retire.",
  };
}

/** PURE: the verdict. Every caller reads this one function. */
export function decideRetirement(
  profile: RetireProfileRow,
  dependents: RetireDependents,
  siblings: readonly RetireProfileRow[]
): RetireDecision {
  if (profile.scope === ProfileScope.SYSTEM) return { verdict: "system" };
  if (isRetiredRow(profile)) return { verdict: "already_retired" };

  const reasons: string[] = [];
  if (dependents.entities > 0)
    reasons.push(`${dependents.entities} record(s) still use this kind`);
  if (dependents.liveFacets > 0)
    reasons.push(`${dependents.liveFacets} live facet(s) still use this role`);
  const usage = reasons.length > 0;
  if (dependents.views > 0)
    reasons.push(`${dependents.views} view(s) are scoped to this kind`);
  if ((dependents.automations ?? 0) > 0)
    reasons.push(
      `${dependents.automations} automation(s) trigger on '${profile.slug}'`
    );

  if (reasons.length === 0) return { verdict: "retirable" };
  if (!usage) {
    return {
      verdict: "refused",
      reasons,
      mergeSuggestion: null,
      noMergeReason: null,
    };
  }
  const { suggestion, reason } = pickMergeSuggestion(profile, siblings);
  return {
    verdict: "refused",
    reasons,
    mergeSuggestion: suggestion,
    noMergeReason: reason,
  };
}

// ── DB tier ──────────────────────────────────────────────────────────────────

// LAZY on purpose: this module is imported by `routers/profiles.ts`, so a
// module-level `profiles.id` read runs at import and breaks every suite that
// mocks `@synap/database` without the `profiles` table.
function profileColumns() {
  return {
    id: profiles.id,
    slug: profiles.slug,
    displayName: profiles.displayName,
    scope: profiles.scope,
    workspaceId: profiles.workspaceId,
    userId: profiles.userId,
    profileKind: profiles.profileKind,
    isActive: profiles.isActive,
    uiHints: profiles.uiHints,
    createdAt: profiles.createdAt,
  };
}

const countOf = () => drizzleSql<number>`cast(count(*) as integer)`;

/** Load the row, count its dependents (pod-wide), and decide. */
export async function inspectProfileRetirement(
  profileId: string
): Promise<RetireInspection | null> {
  const [profile] = (await db
    .select(profileColumns())
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .limit(1)) as RetireProfileRow[];
  if (!profile) return null;

  const siblings = (await db
    .select(profileColumns())
    .from(profiles)
    .where(
      and(
        eq(profiles.isActive, true),
        ne(profiles.id, profile.id),
        or(
          eq(profiles.slug, profile.slug),
          drizzleSql`lower(trim(${profiles.displayName})) = ${profile.displayName.trim().toLowerCase()}`
        )
      )
    )) as RetireProfileRow[];
  const slugStaysLive = siblings.some((s) => s.slug === profile.slug);

  const [[ent], [fac], [vw], autoRows, [rel]] = await Promise.all([
    db
      .select({ n: countOf() })
      .from(entities)
      .where(
        and(eq(entities.profileId, profile.id), isNull(entities.deletedAt))
      ),
    db
      .select({ n: countOf() })
      .from(entityFacets)
      .where(
        and(
          eq(entityFacets.profileId, profile.id),
          isNull(entityFacets.deletedAt)
        )
      ),
    db
      .select({ n: countOf() })
      .from(views)
      .where(
        drizzleSql`${views.scopeProfileIds} @> ARRAY[${profile.id}]::uuid[]`
      ),
    slugStaysLive
      ? Promise.resolve(null)
      : db
          .select({ n: countOf() })
          .from(automations)
          .where(
            drizzleSql`${automations.triggerConfig}->>'profileSlug' = ${profile.slug}`
          ),
    db
      .select({ n: countOf() })
      .from(profileRelations)
      .where(
        or(
          eq(profileRelations.sourceProfileId, profile.id),
          eq(profileRelations.targetProfileId, profile.id)
        )
      ),
  ]);

  const dependents: RetireDependents = {
    entities: Number(ent?.n ?? 0),
    liveFacets: Number(fac?.n ?? 0),
    views: Number(vw?.n ?? 0),
    automations: autoRows === null ? null : Number(autoRows[0]?.n ?? 0),
    profileRelations: Number(rel?.n ?? 0),
  };

  return {
    profile,
    dependents,
    decision: decideRetirement(profile, dependents, siblings),
  };
}

// ── Propose door ─────────────────────────────────────────────────────────────

export type ProposeRetireResult =
  | { status: "proposed"; proposalId: string; dependents: RetireDependents }
  | { status: "already_pending"; proposalId: string }
  | { status: "already_retired" }
  | {
      status: "refused";
      reasons: string[];
      dependents: RetireDependents;
      /** The filed `profile/merge` proposal, when a merge target exists. */
      mergeProposalId: string | null;
      noMergeReason: string | null;
    };

async function pendingProposalFor(
  targetId: string,
  proposalType: "retire" | "merge"
): Promise<string | null> {
  const [row] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, "profile"),
        eq(proposals.proposalType, proposalType),
        eq(proposals.targetId, targetId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    )
    .limit(1);
  return row?.id ?? null;
}

export const MERGE_NEEDS_POD_ADMIN =
  "Merging kinds rewrites every row of this kind across the pod, so only a pod admin can file or approve it. Ask a pod admin to merge, then retire.";

/**
 * PURE: the rows a retire review card renders (`properties.*` is the channel
 * the update renderer shows on desktop and relay). Counts are the preflight's.
 */
export function retireReviewRows(
  d: RetireDependents
): Record<string, string | number> {
  return {
    records_using_it: d.entities,
    live_role_facets: d.liveFacets,
    views_scoped_to_it: d.views,
    automations_triggered_by_it:
      d.automations ??
      "Not counted: another active row keeps this kind's name in use",
    relation_types_on_it: d.profileRelations,
    on_approve:
      "Hidden everywhere. Nothing is deleted, and it can be reactivated.",
  };
}

/** PURE: the rows a merge review card renders — direction, scale, authority. */
export function mergeReviewRows(
  suggestion: MergeSuggestion,
  d: RetireDependents,
  refusedBecause: readonly string[]
): Record<string, string | number> {
  const direction: Record<string, string> =
    suggestion.op === "dedupeProfileRows"
      ? { collapses_duplicate_rows_of: suggestion.slug }
      : { moves_records_from: suggestion.fromSlug, into: suggestion.intoSlug };
  return {
    ...direction,
    records_on_this_row: d.entities,
    needs_a_pod_admin_to_approve:
      "Yes: it rewrites every row of this kind across the pod",
    retire_was_refused_because: refusedBecause.join("; "),
  };
}

/**
 * File a `profile/retire` proposal — or, when the kind is still in use, REFUSE
 * and file a `profile/merge` suggestion instead (D5). Never writes the profile.
 *
 * Authority is decided on the LOADED row (`assertProfileSchemaWrite`, editor),
 * before any dependency number is returned.
 */
export async function proposeProfileRetire(params: {
  userId: string;
  profileId: string;
  actingWorkspaceId: string | null;
  reason?: string;
}): Promise<ProposeRetireResult> {
  const inspection = await inspectProfileRetirement(params.profileId);
  if (!inspection) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found" });
  }
  const { profile, dependents, decision } = inspection;
  if (decision.verdict === "system") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "System profiles cannot be retired",
    });
  }
  await assertProfileSchemaWrite(db, params.userId, profile, {
    level: "editor",
    actingWorkspaceId: params.actingWorkspaceId,
  });

  if (decision.verdict === "already_retired")
    return { status: "already_retired" };

  if (decision.verdict === "refused") {
    let mergeProposalId: string | null = null;
    let noMergeReason = decision.noMergeReason;
    const suggestion = decision.mergeSuggestion;
    // A merge rewrites every row of the slug pod-wide, so only a pod admin can
    // approve it. Refuse to FILE one for anyone else — a proposal its own
    // requester can never approve is an Approve button that ends in failure.
    if (suggestion && !(await isPodAdmin(params.userId))) {
      noMergeReason = MERGE_NEEDS_POD_ADMIN;
    } else if (suggestion) {
      mergeProposalId = await pendingProposalFor(profile.id, "merge");
      if (!mergeProposalId) {
        const { proposal } = await insertPendingProposal({
          workspaceId: profile.workspaceId,
          targetType: "profile",
          targetId: profile.id,
          proposalType: "merge",
          data: {
            sourceId: params.userId,
            id: profile.id,
            slug: profile.slug,
            displayName: profile.displayName,
            suggestion,
            dependents,
            refusedRetireReasons: decision.reasons,
            changeType: "update",
            properties: mergeReviewRows(
              suggestion,
              dependents,
              decision.reasons
            ),
            summary:
              suggestion.op === "dedupeProfileRows"
                ? `Collapse the duplicate '${profile.slug}' kind rows into one`
                : `Merge the '${profile.slug}' kind into '${suggestion.intoSlug}'`,
            reasoning:
              "Retiring this kind was refused because it is still in use. Merging moves its records onto the suggested kind first; the emptied kind can then be retired.",
          },
          createdBy: params.userId,
          proposedByUserId: params.userId,
          subjectUserId: params.userId,
        });
        mergeProposalId = proposal.id;
      }
    }
    return {
      status: "refused",
      reasons: decision.reasons,
      dependents,
      mergeProposalId,
      noMergeReason,
    };
  }

  const existing = await pendingProposalFor(profile.id, "retire");
  if (existing) return { status: "already_pending", proposalId: existing };

  const { proposal } = await insertPendingProposal({
    workspaceId: profile.workspaceId,
    targetType: "profile",
    targetId: profile.id,
    proposalType: "retire",
    data: {
      sourceId: params.userId,
      id: profile.id,
      slug: profile.slug,
      displayName: profile.displayName,
      scope: profile.scope,
      dependents,
      changeType: "update",
      properties: retireReviewRows(dependents),
      summary: `Retire the '${profile.displayName}' kind`,
      reasoning:
        params.reason ??
        "Nothing uses this kind. Retiring hides it everywhere; nothing is deleted, and it can be reactivated.",
    },
    createdBy: params.userId,
    proposedByUserId: params.userId,
    subjectUserId: params.userId,
  });
  return { status: "proposed", proposalId: proposal.id, dependents };
}

// ── Apply (approval half) ────────────────────────────────────────────────────

export type ApplyRetireResult =
  | {
      applied: "verified";
      profileId: string;
      slug: string;
      /** Canonical row stamped on the tombstone (an APPLIED merge, still live). */
      mergedInto: string | null;
      /** Why an applied merge's canonical was NOT stamped, when one was found. */
      mergedIntoSkipped: string | null;
    }
  | { applied: "none"; reason: string };

/**
 * PURE: did an approved `profile/merge` actually APPLY? Read from the
 * conversions ledger's own `OpResult.status`, stored by the merge executor on
 * `data.mergeResult` — `applied`, or `skipped` (that same opKey was already
 * applied). `noop`, `error`, or no result at all = it did not apply.
 */
export function isAppliedMerge(data: unknown): boolean {
  const status = (data as { mergeResult?: { status?: unknown } } | null)
    ?.mergeResult?.status;
  return status === "applied" || status === "skipped";
}

/** PURE: the canonical row a merge suggestion names. */
export function mergeCanonicalId(data: unknown): string | null {
  const s = (data as { suggestion?: MergeSuggestion } | null)?.suggestion;
  if (!s) return null;
  return s.op === "dedupeProfileRows" ? s.canonicalProfileId : s.intoProfileId;
}

/**
 * Option A (orchestrator, 2026-09-14): a retire inherits `mergedInto` from the
 * MOST RECENT APPLIED `profile/merge` on this profile — looked up by PROFILE ID,
 * never slug — and only when that canonical row is still active and not itself
 * tombstoned. Otherwise it is a plain retire; `skipped` says why when an applied
 * merge existed but its canonical cannot be named.
 */
export async function resolveAppliedMergeTarget(
  profileId: string
): Promise<{ mergedInto: string | null; skipped: string | null }> {
  const merges = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, "profile"),
        eq(proposals.proposalType, "merge"),
        eq(proposals.targetId, profileId),
        eq(proposals.status, ProposalStatus.APPROVED)
      )
    )
    .orderBy(desc(proposals.reviewedAt));
  const applied = merges.find((m) => isAppliedMerge(m.data));
  if (!applied) return { mergedInto: null, skipped: null };

  const canonicalId = mergeCanonicalId(applied.data);
  if (!canonicalId) {
    return {
      mergedInto: null,
      skipped: "the applied merge names no canonical kind",
    };
  }
  const [canonical] = await db
    .select({ isActive: profiles.isActive, uiHints: profiles.uiHints })
    .from(profiles)
    .where(eq(profiles.id, canonicalId));
  if (!canonical || isRetiredRow(canonical)) {
    return {
      mergedInto: null,
      skipped: `the merge target ${canonicalId} is no longer an active kind`,
    };
  }
  return { mergedInto: canonicalId, skipped: null };
}

/**
 * Soft-retire at APPROVAL time. Re-runs the preflight: a dependency that
 * appeared since filing throws (the proposal lands APPROVAL_FAILED with the
 * reason, retryable) instead of retiring a kind that is now in use.
 */
export async function applyProfileRetire(params: {
  profileId: string;
  approverUserId: string;
  sourceProposalId: string;
}): Promise<ApplyRetireResult> {
  const inspection = await inspectProfileRetirement(params.profileId);
  if (!inspection) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Profile to retire no longer exists",
    });
  }
  const { profile, decision } = inspection;
  if (decision.verdict === "system") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "System profiles cannot be retired",
    });
  }
  await assertProfileSchemaWrite(db, params.approverUserId, profile, {
    level: "editor",
    actingWorkspaceId: profile.workspaceId,
  });
  if (decision.verdict === "already_retired") {
    return { applied: "none", reason: "The kind was already retired." };
  }
  if (decision.verdict === "refused") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Retire refused at approval: ${decision.reasons.join("; ")}`,
    });
  }

  const { mergedInto, skipped } = await resolveAppliedMergeTarget(profile.id);

  // ONE write: `is_active=false` + the `ui_hints.retired` tombstone, so a later
  // reconcile/install reports a conflict instead of reviving the row.
  await markProfileRetired(db, profile.id, {
    reason: "Retired through an approved profile/retire proposal",
    byProposalId: params.sourceProposalId,
    ...(mergedInto ? { mergedInto } : {}),
  });
  ProfileResolutionService.invalidateEntityScopeCache(profile.slug);

  // The helper returns nothing, so the receipt is the storage engine's own
  // read-back of BOTH halves — never "we got here without throwing".
  const [after] = await db
    .select({ isActive: profiles.isActive, uiHints: profiles.uiHints })
    .from(profiles)
    .where(eq(profiles.id, profile.id));
  const tombstone = after ? readProfileRetirement(after) : null;
  if (
    !after ||
    after.isActive ||
    tombstone?.byProposalId !== params.sourceProposalId
  ) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Retire did not land: the profile is still active or carries no tombstone for this proposal",
    });
  }

  void auditLog({
    subjectType: "profile",
    action: "retire",
    phase: "completed",
    subjectId: profile.id,
    userId: params.approverUserId,
    workspaceId: profile.workspaceId,
    proposalId: params.sourceProposalId,
  });
  logger.info(
    {
      profileId: profile.id,
      slug: profile.slug,
      proposalId: params.sourceProposalId,
    },
    "profile retired (soft, reversible via reactivate)"
  );
  return {
    applied: "verified",
    profileId: profile.id,
    slug: profile.slug,
    mergedInto,
    mergedIntoSkipped: skipped,
  };
}

/** Build the ONE conversion op a merge suggestion names. */
export function mergeSuggestionToOp(
  suggestion: MergeSuggestion,
  proposalId: string
): ConversionOp {
  const opKey = `pod-hygiene.merge.${proposalId}`;
  if (suggestion.op === "dedupeProfileRows") {
    return {
      op: "dedupeProfileRows",
      opKey,
      slug: suggestion.slug,
      canonical: suggestion.canonical,
    };
  }
  return {
    op: "mergeInto",
    opKey,
    fromSlugs: [suggestion.fromSlug],
    intoSlug: suggestion.intoSlug,
  };
}

/**
 * Apply an approved merge suggestion through the conversions ENGINE (ledgered
 * under a proposal-scoped opKey, so a re-approve is a ledger skip). Never the
 * destructive tail: the source rows stay active, emptied, and retiring them is
 * a separate `profile/retire` decision. The op rewrites every row of the slug
 * pod-wide, so the approver must be a pod admin.
 */
export async function applyProfileMerge(params: {
  proposalId: string;
  approverUserId: string;
  suggestion: MergeSuggestion;
}): Promise<{ status: string; counts: Record<string, number | undefined> }> {
  if (!(await isPodAdmin(params.approverUserId))) {
    throw new TRPCError({ code: "FORBIDDEN", message: MERGE_NEEDS_POD_ADMIN });
  }
  const op = mergeSuggestionToOp(params.suggestion, params.proposalId);
  const summary = await runConversions(
    sql,
    { version: 1, ops: [op] },
    { dryRun: false, destructiveTail: false }
  );
  const result = summary.results[0];
  if (summary.hadError || !result || result.status === "error") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Merge refused by the conversions engine: ${result?.error ?? "no result"}`,
    });
  }
  ProfileResolutionService.invalidateEntityScopeCache(
    params.suggestion.op === "dedupeProfileRows"
      ? params.suggestion.slug
      : params.suggestion.fromSlug
  );
  return {
    status: result.status,
    counts: result.counts as Record<string, number | undefined>,
  };
}

/** Ids of kinds that already carry a pending retire proposal. */
export async function profilesWithPendingRetire(
  profileIds: readonly string[]
): Promise<Set<string>> {
  if (profileIds.length === 0) return new Set();
  const rows = await db
    .select({ targetId: proposals.targetId })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, "profile"),
        eq(proposals.proposalType, "retire"),
        eq(proposals.status, ProposalStatus.PENDING),
        inArray(proposals.targetId, [...profileIds])
      )
    );
  return new Set(rows.map((r) => r.targetId));
}
