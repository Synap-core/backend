/**
 * DECLARE A LIFECYCLE ON AN EXISTING KIND — the governed door (work model L1).
 *
 * THE GAP IT CLOSES: `declareLifecycle` (@synap/database) was reached only by
 * the template doors (workspace create / reconcile) and the system seeder. A
 * kind an agent or a person made on a live pod (the pod's `finding`) could never
 * gain a lifecycle: `synap_define_kind` adds fields and grows enums, but it
 * cannot flip `profile_properties.is_lifecycle` or give options a category.
 * So every such thing kept `status` NULL, and every reader had to guess what a
 * NULL meant.
 *
 * POLICY — identical to `property_def/retire` (a schema change on a kind that
 * every space may read):
 *   - ALWAYS a PENDING proposal, for a person too (`insertPendingProposal`,
 *     DIRECT door `profile/declare_lifecycle`). The propose half has NO execute
 *     branch: nothing here can auto-apply, whatever a rule says.
 *   - Authority on the LOADED profile row (`assertProfileSchemaWrite`, level
 *     editor: a pod-owned kind needs a pod admin), at filing AND again on the
 *     APPROVER.
 *   - ONE preflight (`inspectKindLifecycleDeclaration` → pure
 *     `decideKindLifecycleDeclaration`) read by the propose door AND the
 *     approval half, so a lifecycle declared, or a value written, between filing
 *     and approval refuses at approval instead of being overwritten.
 *
 * WHAT APPROVAL DOES (one transaction): the status field is created as a BASE
 * field of the kind (or the existing base field is given the options), its
 * options are written through the one mapper (`buildStoredConstraints`, so
 * `enum` is derived from them), `declareLifecycle` validates and flips the
 * link, and `setLifecycleInitialStatus` sets the status new things start in.
 * The declaration's own validation is `declareLifecycle`'s and
 * `parseLifecycleOptions`' — this door does not fork it.
 *
 * WHAT IT REFUSES, and why:
 *   - a kind (or an ancestor) that already declares a lifecycle: this door
 *     never REPLACES one. Appending an option is the field's update; a
 *     recategorise or retire is the lifecycle door (`changeLifecycleOptions`).
 *   - a field that is not this kind's own base field (a global or another
 *     kind's field, or a base + overlay pair): its options would change every
 *     kind that shares it.
 *   - an existing option key the new list drops, or a value records already
 *     carry that no option names: stored keys stay stable, names go in labels.
 *   - `dateBinding` / `waits`: they name the kind's properties, which only the
 *     lifecycle door checks; bind them there once the lifecycle exists.
 *
 * WHAT IT DOES NOT DO: give existing records a status. The projection copies
 * only values rows already carry, so a record with no status keeps none until
 * it is moved (`moveStatus`, e.g. a batched `synap_update_entities`).
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  isNull,
  drizzleSql,
  profiles,
  propertyDefs,
  profileProperties,
  entities,
  entityFacets,
  proposals,
  ProposalStatus,
  ProfileResolutionService,
  PropertyDefRepository,
  PropertyValueType,
  ProfilePropertyRepository,
  insertPendingProposal,
  parseLifecycleOptions,
  buildStoredConstraints,
  readStoredEnumOptions,
  declareLifecycle,
  setLifecycleInitialStatus,
  LIFECYCLE_CATEGORIES,
  type LifecycleOption,
} from "@synap/database";
import {
  buildObjectActionTitle,
  humanizeToken,
} from "@synap-core/types/vocabulary";
import { createLogger } from "@synap-core/core";
import { assertProfileSchemaWrite } from "../../utils/profile-schema-write-access.js";
import { auditLog } from "../../utils/audit-log.js";

const logger = createLogger({ module: "declare-kind-lifecycle" });

/** The default lifecycle field: the slug every system lifecycle uses. */
export const DEFAULT_LIFECYCLE_PROPERTY = "status";

/** Same slug rule as `propertyDefs.create`. */
const PROPERTY_SLUG = /^[a-z0-9-]+$/;

export const DECLARE_LIFECYCLE_PROPOSAL_TYPE = "declare_lifecycle" as const;

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface DeclareKindLifecycleInput {
  profileId: string;
  /** The status field's slug. Default {@link DEFAULT_LIFECYCLE_PROPERTY}. */
  property?: string;
  /** The complete option list, each `{ key, category, label?, tone?, humanOnly?, stuckAfterDays? }`. */
  options: unknown[];
  /** The option a new thing starts in when its creator names none. */
  initialStatus?: string | null;
}

// ── Preflight ────────────────────────────────────────────────────────────────

/** The profile row the door reads (and asks authority about). */
export interface DeclareLifecycleProfile {
  id: string;
  slug: string;
  displayName: string;
  profileKind: string | null;
  isActive: boolean;
  scope: string | null;
  workspaceId: string | null;
  userId: string | null;
}

/** A def linked to the profile under the requested slug. */
export interface LinkedDef {
  id: string;
  profileId: string | null;
  workspaceId: string | null;
  valueType: string;
  storedKeys: string[];
}

/** What the preflight read — everything the pure decision needs. */
export interface KindLifecycleFacts {
  profile: DeclareLifecycleProfile;
  property: string;
  /** The lifecycle the profile already resolves (own or an ancestor's). */
  existingLifecycle: { propertySlug: string; options: string[] } | null;
  /** Defs linked to the profile under `property` (0, 1, or base + overlay). */
  linked: LinkedDef[];
  /** An UNLINKED base def of this profile under `property`, if one exists. */
  unlinkedBase: LinkedDef | null;
  /** Distinct values live records / facets of this kind carry under `property`. */
  storedValues: string[];
  /** Live records of this kind (to say what the declaration leaves unset). */
  records: number;
}

/** Where the status field comes from on approval. */
export type LifecycleFieldPlan =
  | { mode: "create" }
  | { mode: "link"; propertyDefId: string }
  | { mode: "rewrite"; propertyDefId: string };

export type KindLifecycleDecision =
  | {
      verdict: "declarable";
      options: LifecycleOption[];
      initialStatus: string | null;
      field: LifecycleFieldPlan;
    }
  | { verdict: "refused"; reasons: string[] };

/**
 * PURE: the verdict. The propose door and the approval half both read it, so
 * what the reviewer approved is re-judged against the pod as it is then.
 */
export function decideKindLifecycleDeclaration(
  facts: KindLifecycleFacts,
  input: Pick<DeclareKindLifecycleInput, "options" | "initialStatus">
): KindLifecycleDecision {
  const reasons: string[] = [];
  const { profile, property } = facts;

  if (!profile.isActive) {
    reasons.push(`"${profile.slug}" is retired`);
  }
  if (facts.existingLifecycle) {
    const e = facts.existingLifecycle;
    reasons.push(
      `"${profile.slug}" already declares "${e.propertySlug}" as its lifecycle (${e.options.join(", ")}). ` +
        `This door never replaces one: append an option (with its category) through the field's update, ` +
        `recategorise or retire one through the lifecycle door (propertyDefs.changeLifecycleOptions)`
    );
  }
  if (!PROPERTY_SLUG.test(property)) {
    reasons.push(
      `"${property}" is not a field key (lowercase letters, digits and -)`
    );
  }

  // The option list: the model's own parser — no second validation.
  const { options, errors } = parseLifecycleOptions(input.options);
  reasons.push(...errors);
  const raw = Array.isArray(input.options) ? input.options : [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    if (o.dateBinding !== undefined || o.waits !== undefined) {
      reasons.push(
        `option "${String(o.key)}": dateBinding and waits name the kind's properties; ` +
          `declare the lifecycle first, then bind them through the lifecycle door`
      );
    }
  }
  const keys = new Set(options.map((o) => o.key));

  const initialStatus = input.initialStatus ?? null;
  if (initialStatus !== null && !keys.has(initialStatus)) {
    reasons.push(
      `initialStatus "${initialStatus}" is not one of the options (${[...keys].join(", ")})`
    );
  }

  // The field.
  let field: LifecycleFieldPlan = { mode: "create" };
  if (facts.linked.length > 1) {
    reasons.push(
      `"${property}" is linked to "${profile.slug}" more than once (base + overlay); a lifecycle is declared on one base field`
    );
  } else if (facts.linked.length === 1) {
    const def = facts.linked[0]!;
    if (def.profileId !== profile.id || def.workspaceId !== null) {
      reasons.push(
        def.profileId === null
          ? `"${property}" on "${profile.slug}" is a GLOBAL field other kinds share; its options cannot become this kind's lifecycle. Pass another field key`
          : def.profileId !== profile.id
            ? `"${property}" on "${profile.slug}" belongs to another kind; its options cannot become this kind's lifecycle. Pass another field key`
            : `"${property}" on "${profile.slug}" is one space's overlay; a lifecycle is declared on the kind's base field`
      );
    }
    if (def.valueType !== "string") {
      reasons.push(
        `"${property}" holds ${def.valueType} values; a lifecycle is a select (string) field`
      );
    }
    const dropped = def.storedKeys.filter((k) => !keys.has(k));
    if (dropped.length) {
      reasons.push(
        `"${property}" already offers ${dropped.map((k) => `"${k}"`).join(", ")}: keep every stored key (rename it with a label)`
      );
    }
    field = { mode: "rewrite", propertyDefId: def.id };
  } else if (facts.unlinkedBase) {
    if (facts.unlinkedBase.valueType !== "string") {
      reasons.push(
        `"${property}" holds ${facts.unlinkedBase.valueType} values; a lifecycle is a select (string) field`
      );
    }
    const dropped = facts.unlinkedBase.storedKeys.filter((k) => !keys.has(k));
    if (dropped.length) {
      reasons.push(
        `"${property}" already offers ${dropped.map((k) => `"${k}"`).join(", ")}: keep every stored key (rename it with a label)`
      );
    }
    field = { mode: "link", propertyDefId: facts.unlinkedBase.id };
  }

  const stray = facts.storedValues.filter((v) => !keys.has(v));
  if (stray.length) {
    reasons.push(
      `records of "${profile.slug}" already carry ${stray.map((v) => `"${v}"`).join(", ")} under "${property}": add an option for each`
    );
  }

  return reasons.length
    ? { verdict: "refused", reasons }
    : { verdict: "declarable", options, initialStatus, field };
}

function storedKeysOf(def: {
  constraints: unknown;
  uiHints: unknown;
}): string[] {
  const opts =
    readStoredEnumOptions({
      constraints: def.constraints as Record<string, unknown> | null,
      uiHints: def.uiHints as Record<string, unknown> | null,
    }) ?? [];
  return opts.map((o) => o.key);
}

const countOf = () => drizzleSql<number>`cast(count(*) as integer)`;

/** I/O: read every fact the decision needs. `null` = no such profile. */
export async function inspectKindLifecycleDeclaration(
  input: Pick<DeclareKindLifecycleInput, "profileId" | "property">
): Promise<KindLifecycleFacts | null> {
  const property = (input.property ?? DEFAULT_LIFECYCLE_PROPERTY).trim();
  const [profile] = await db
    .select({
      id: profiles.id,
      slug: profiles.slug,
      displayName: profiles.displayName,
      profileKind: profiles.profileKind,
      isActive: profiles.isActive,
      scope: profiles.scope,
      workspaceId: profiles.workspaceId,
      userId: profiles.userId,
    })
    .from(profiles)
    .where(eq(profiles.id, input.profileId))
    .limit(1);
  if (!profile) return null;

  const effective = await new ProfileResolutionService(
    db
  ).getEffectiveLifecycle(profile.id);

  const linkedRows = await db
    .select({
      id: propertyDefs.id,
      profileId: propertyDefs.profileId,
      workspaceId: propertyDefs.workspaceId,
      valueType: propertyDefs.valueType,
      constraints: propertyDefs.constraints,
      uiHints: propertyDefs.uiHints,
    })
    .from(profileProperties)
    .innerJoin(
      propertyDefs,
      eq(propertyDefs.id, profileProperties.propertyDefId)
    )
    .where(
      and(
        eq(profileProperties.profileId, profile.id),
        eq(propertyDefs.slug, property)
      )
    );
  const linked: LinkedDef[] = linkedRows.map((r) => ({
    id: r.id,
    profileId: r.profileId,
    workspaceId: r.workspaceId,
    valueType: r.valueType,
    storedKeys: storedKeysOf(r),
  }));

  let unlinkedBase: LinkedDef | null = null;
  if (linked.length === 0) {
    const [base] = await db
      .select({
        id: propertyDefs.id,
        profileId: propertyDefs.profileId,
        workspaceId: propertyDefs.workspaceId,
        valueType: propertyDefs.valueType,
        constraints: propertyDefs.constraints,
        uiHints: propertyDefs.uiHints,
      })
      .from(propertyDefs)
      .where(
        and(
          eq(propertyDefs.profileId, profile.id),
          isNull(propertyDefs.workspaceId),
          eq(propertyDefs.slug, property)
        )
      )
      .limit(1);
    if (base) unlinkedBase = { ...base, storedKeys: storedKeysOf(base) };
  }

  // Pod-wide, like the retire preflight: a value in a space the caller cannot
  // see is still a value the lifecycle must name.
  const valueOf = (col: unknown) => drizzleSql<string>`${col} ->> ${property}`;
  const [entityValues, facetValues, [records]] = await Promise.all([
    db
      .selectDistinct({ v: valueOf(entities.properties) })
      .from(entities)
      .where(
        and(
          eq(entities.profileId, profile.id),
          isNull(entities.deletedAt),
          drizzleSql`${entities.properties} ->> ${property} is not null`
        )
      ),
    db
      .selectDistinct({ v: valueOf(entityFacets.properties) })
      .from(entityFacets)
      .where(
        and(
          eq(entityFacets.profileId, profile.id),
          isNull(entityFacets.deletedAt),
          drizzleSql`${entityFacets.properties} ->> ${property} is not null`
        )
      ),
    db
      .select({ n: countOf() })
      .from(entities)
      .where(
        and(eq(entities.profileId, profile.id), isNull(entities.deletedAt))
      ),
  ]);
  const storedValues = [
    ...new Set(
      [...entityValues, ...facetValues]
        .map((r) => r.v)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    ),
  ].sort();

  return {
    profile: {
      ...profile,
      profileKind: profile.profileKind ?? null,
      isActive: profile.isActive !== false,
    },
    property,
    existingLifecycle: effective
      ? {
          propertySlug: effective.propertySlug,
          options: effective.options.map((o) => o.key),
        }
      : null,
    linked,
    unlinkedBase,
    storedValues,
    records: Number(records?.n ?? 0),
  };
}

// ── Review display ───────────────────────────────────────────────────────────

/** One option as the reviewer reads it: `fixing = Fixing (active)`. */
export function describeLifecycleOption(o: LifecycleOption): string {
  const label = o.label ?? humanizeToken(o.key);
  return `${o.key} = ${label} (${o.category}${o.humanOnly ? ", only a person moves it here" : ""})`;
}

/** PURE: the rows the review card renders. Names the kind, the options and their categories. */
export function kindLifecycleReviewRows(
  facts: KindLifecycleFacts,
  decision: Extract<KindLifecycleDecision, { verdict: "declarable" }>
): Record<string, string | number> {
  return {
    kind: `${facts.profile.displayName} (${facts.profile.slug})`,
    field:
      decision.field.mode === "create"
        ? `${facts.property} (a new field of this kind)`
        : `${facts.property} (the kind's existing field)`,
    options: decision.options.map(describeLifecycleOption).join(" · "),
    categories: `Each option belongs to one of ${LIFECYCLE_CATEGORIES.join(", ")}: readers count by category, never by the option's name.`,
    new_records_start_in: decision.initialStatus ?? "no status",
    existing_records: facts.records,
    on_approve: `"${facts.property}" becomes the lifecycle of ${facts.profile.displayName}: every status move goes through the one status door. Existing records keep the status they carry (none, today) until they are moved.`,
  };
}

/**
 * The ONE title for this door's proposals: `Declare lifecycle "finding"`. No
 * object kind: the builder would read `Declare lifecycle Kind "finding"`, and
 * the review rows already name the kind.
 */
export function kindLifecycleProposalTitle(slug: string): string {
  return buildObjectActionTitle({
    action: DECLARE_LIFECYCLE_PROPOSAL_TYPE,
    objectName: slug,
  });
}

// ── Propose door ─────────────────────────────────────────────────────────────

export type ProposeKindLifecycleResult =
  | {
      status: "proposed";
      proposalId: string;
      profileSlug: string;
      property: string;
      options: LifecycleOption[];
      initialStatus: string | null;
    }
  | { status: "already_pending"; proposalId: string }
  | { status: "refused"; reasons: string[] };

async function pendingDeclarationFor(
  profileId: string
): Promise<string | null> {
  const [row] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, "profile"),
        eq(proposals.proposalType, DECLARE_LIFECYCLE_PROPOSAL_TYPE),
        eq(proposals.targetId, profileId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * File a `profile/declare_lifecycle` proposal, or REFUSE with every reason.
 * Never writes the schema. Authority is decided on the LOADED profile before
 * anything about its records is returned.
 */
export async function proposeKindLifecycle(params: {
  userId: string;
  agentUserId?: string | null;
  input: DeclareKindLifecycleInput;
  reason?: string;
}): Promise<ProposeKindLifecycleResult> {
  const facts = await inspectKindLifecycleDeclaration(params.input);
  if (!facts) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Kind not found: ${params.input.profileId}`,
    });
  }
  await assertProfileSchemaWrite(db, params.userId, facts.profile, {
    level: "editor",
    actingWorkspaceId: null,
  });

  const decision = decideKindLifecycleDeclaration(facts, params.input);
  if (decision.verdict === "refused") {
    return { status: "refused", reasons: decision.reasons };
  }

  const existing = await pendingDeclarationFor(facts.profile.id);
  if (existing) return { status: "already_pending", proposalId: existing };

  const { proposal } = await insertPendingProposal({
    workspaceId: facts.profile.workspaceId,
    targetType: "profile",
    targetId: facts.profile.id,
    // A literal, so the approval-half tripwire's pair scan sees this filing.
    proposalType: "declare_lifecycle",
    data: {
      sourceId: params.userId,
      id: facts.profile.id,
      profileId: facts.profile.id,
      slug: facts.profile.slug,
      property: facts.property,
      options: decision.options,
      initialStatus: decision.initialStatus,
      field: decision.field,
      changeType: "update",
      properties: kindLifecycleReviewRows(facts, decision),
      summary: kindLifecycleProposalTitle(facts.profile.slug),
      reasoning:
        params.reason ??
        `Give ${facts.profile.displayName} a lifecycle, so where each one stands is a declared status with a category.`,
    },
    createdBy: params.userId,
    proposedByUserId: params.agentUserId ? null : params.userId,
    subjectUserId: params.userId,
    ...(params.agentUserId ? { agentUserId: params.agentUserId } : {}),
  });
  return {
    status: "proposed",
    proposalId: proposal.id,
    profileSlug: facts.profile.slug,
    property: facts.property,
    options: decision.options,
    initialStatus: decision.initialStatus,
  };
}

// ── Apply (approval half) ────────────────────────────────────────────────────

export interface ApplyKindLifecycleResult {
  applied: "verified";
  propertyDefId: string;
  /** `declareLifecycle`'s own answer. */
  declared: "declared" | "unchanged";
  initialStatus: string | null;
}

/**
 * Declare at APPROVAL time, from what the reviewer saw (`proposal.data`).
 * Re-runs the preflight AND the authority floor on the APPROVER, then writes
 * the field, declares and sets the initial status in ONE transaction: a
 * refusal by `declareLifecycle` rolls the field back with it.
 */
export async function applyKindLifecycle(params: {
  approverUserId: string;
  sourceProposalId: string;
  input: DeclareKindLifecycleInput;
}): Promise<ApplyKindLifecycleResult> {
  const facts = await inspectKindLifecycleDeclaration(params.input);
  if (!facts) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Declare refused at approval: the kind ${params.input.profileId} no longer exists`,
    });
  }
  await assertProfileSchemaWrite(db, params.approverUserId, facts.profile, {
    level: "editor",
    actingWorkspaceId: null,
  });
  const decision = decideKindLifecycleDeclaration(facts, params.input);
  if (decision.verdict === "refused") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Declare refused at approval: ${decision.reasons.join("; ")}`,
    });
  }

  const result = await db.transaction(async (tx) => {
    const t = tx as unknown as typeof db;
    const enumOptions = decision.options;
    let propertyDefId: string;
    if (decision.field.mode === "create") {
      const def = await new PropertyDefRepository(t).create({
        slug: facts.property,
        valueType: PropertyValueType.STRING,
        constraints: buildStoredConstraints({ constraints: { enumOptions } }),
        uiHints: { label: humanizeToken(facts.property), inputType: "select" },
        profileId: facts.profile.id,
      });
      propertyDefId = def.id;
    } else {
      propertyDefId = decision.field.propertyDefId;
      const [def] = await t
        .select({ constraints: propertyDefs.constraints })
        .from(propertyDefs)
        .where(eq(propertyDefs.id, propertyDefId))
        .limit(1);
      await t
        .update(propertyDefs)
        .set({
          constraints: buildStoredConstraints({
            constraints: {
              ...((def?.constraints ?? {}) as Record<string, unknown>),
              enumOptions,
            },
          }),
          updatedAt: new Date(),
        })
        .where(eq(propertyDefs.id, propertyDefId));
    }
    if (decision.field.mode !== "rewrite") {
      await new ProfilePropertyRepository(t).link({
        profileId: facts.profile.id,
        propertyDefId,
      });
    }

    const declared = await declareLifecycle(t, {
      profileId: facts.profile.id,
      propertySlug: facts.property,
    });
    if (declared.status === "refused" || declared.status === "kept") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Declare refused at approval: ${
          declared.status === "refused"
            ? declared.reason
            : `the kind keeps "${declared.existing}"`
        }`,
      });
    }
    if (decision.initialStatus !== null) {
      const initial = await setLifecycleInitialStatus(t, {
        propertyDefId,
        initialStatus: decision.initialStatus,
      });
      if (initial.status === "refused") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Initial status refused at approval: ${initial.reason}`,
        });
      }
    }
    return { propertyDefId, declared: declared.status };
  });

  void auditLog({
    subjectType: "profile",
    action: DECLARE_LIFECYCLE_PROPOSAL_TYPE,
    phase: "completed",
    subjectId: facts.profile.id,
    userId: params.approverUserId,
    workspaceId: facts.profile.workspaceId,
    proposalId: params.sourceProposalId,
  });
  logger.info(
    {
      profileId: facts.profile.id,
      slug: facts.profile.slug,
      property: facts.property,
      propertyDefId: result.propertyDefId,
      proposalId: params.sourceProposalId,
    },
    "lifecycle declared on an existing kind through an approved proposal"
  );
  return {
    applied: "verified",
    propertyDefId: result.propertyDefId,
    declared: result.declared,
    initialStatus: decision.initialStatus,
  };
}

/** Read the door's input back off a stored proposal (what the reviewer saw). */
export function kindLifecycleInputFromProposal(proposal: {
  targetId: string;
  data: unknown;
}): DeclareKindLifecycleInput {
  const d = (proposal.data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(d.options)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Lifecycle proposal is missing its options",
    });
  }
  return {
    profileId: proposal.targetId,
    property:
      typeof d.property === "string" ? d.property : DEFAULT_LIFECYCLE_PROPERTY,
    options: d.options,
    initialStatus: typeof d.initialStatus === "string" ? d.initialStatus : null,
  };
}
