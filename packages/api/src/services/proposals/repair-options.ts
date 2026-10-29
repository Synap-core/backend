/**
 * repair-options — what a person (or the agent that filed it) can do to make
 * a FAILED entity proposal apply, drawn from the data, never from its prose.
 *
 * ## Why (decision fa6c8833, 2026-10-29)
 *
 * An agent wrote `uo_category: "preference"` on five founder preferences; the
 * field allows `preferences`. Each failed only when the founder clicked
 * Approve, and the card offered Reject or "Ask AI". The founder rejected three,
 * two sessions re-filed the same five, and the queue doubled. The fix the
 * founder asked for: the pod says what is wrong with WHICH field, proposes the
 * value it meant, lets the person pick another allowed one, and — when no
 * allowed value is close — lets them add the value to the field.
 *
 * ## What it reads
 *
 * The proposal's stored payload re-validated against the kind as it is NOW
 * (`PropertyValidationService`, the materializer's own check), so the answer
 * is what the next approval would meet — a field fixed on the kind since the
 * failure is no longer listed. Entity `create` and `update` only; every other
 * proposal answers `repairable: false` and keeps the class-driven actions
 * (`resolveFailureActions`, Ask AI, Dismiss).
 *
 * One projection, three surfaces: relay, the browser (`@synap-core/web`
 * proposal UI) and pod-admin read `proposals.repairOptions`, and act through
 * `proposals.repair`.
 */

import {
  db,
  eq,
  entities,
  ProfileResolutionService,
  PropertyValidationService,
  addEnumOptionRefusal,
  resolvePropertyOptions,
  resolvePropertyLabel,
  type EffectiveProperty,
  type PropertyIssue,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";

/** Why a value cannot join a field's closed set (`addEnumOptionRefusal`). */
export type AddOptionRefusal =
  "not_a_closed_set" | "already_allowed" | "lifecycle" | "close_match";

/** One field the proposal cannot carry as it stands. */
export interface ProposalRepairField {
  /** The property key. */
  key: string;
  /** Its human label (`uiHints.displayName` / `label`, else the key). */
  label: string;
  kind: PropertyIssue["kind"];
  /** The validator's sentence (names the key and the rule). */
  message: string;
  /** The value(s) the proposal carries that the field refuses. */
  rejected?: string[];
  /** The field's allowed values, when it is a closed set. */
  options?: string[];
  /** The allowed value one typo away from the rejected one. */
  didYouMean?: string;
  /**
   * May the rejected value join the field's options (option C)? Only a
   * single rejected value on a closed set that is not the lifecycle and has
   * no close allowed value.
   */
  canAddOption: boolean;
  addOptionRefusal?: AddOptionRefusal;
}

export interface ProposalRepair {
  proposalId: string;
  /**
   * There is something to fix by value on this proposal. `false` for a kind
   * of proposal this does not read, or when the payload is valid now (the
   * failure came from elsewhere: a conflict, a permission, a provider).
   */
  repairable: boolean;
  fields: ProposalRepairField[];
  /** The kind the proposal names, when it no longer resolves. */
  missingKind?: string;
}

interface RepairSource {
  id: string;
  status: string;
  targetType: string;
  targetId: string;
  proposalType: string;
  workspaceId: string | null;
  data: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The payload an entity executor replays: nested-first, flat fallback. */
export function entityProposalInner(data: unknown): Record<string, unknown> {
  const outer = asRecord(data);
  return asRecord(outer.data ?? outer);
}

/** Is this a proposal the repair card can read? */
export function isRepairableKind(p: {
  targetType: string;
  proposalType: string;
}): boolean {
  return (
    p.targetType === "entity" &&
    (p.proposalType === "create" || p.proposalType === "update")
  );
}

/**
 * The kind a proposal writes and the properties it writes, resolved for the
 * viewer. `profileSlug` on a create; the entity's own kind on an update.
 */
async function resolveTarget(
  source: RepairSource,
  userId: string,
  profiles: ProfileResolutionService
): Promise<
  | {
      status: "ok";
      profileId: string;
      profileDefaults: Record<string, unknown>;
    }
  | { status: "missing"; slug: string }
  | { status: "unknown" }
> {
  const inner = entityProposalInner(source.data);
  if (source.proposalType === "create") {
    const slug =
      typeof inner.profileSlug === "string" ? inner.profileSlug : undefined;
    if (!slug) return { status: "unknown" };
    const profile = await profiles.resolveProfile(
      slug,
      userId,
      source.workspaceId
    );
    if (!profile) return { status: "missing", slug };
    return {
      status: "ok",
      profileId: profile.id,
      profileDefaults:
        (profile.defaultValues as Record<string, unknown> | null) ?? {},
    };
  }
  const entityId =
    (typeof inner.id === "string" && inner.id) || source.targetId;
  const [row] = await db
    .select({ profileId: entities.profileId })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  return row?.profileId
    ? { status: "ok", profileId: row.profileId, profileDefaults: {} }
    : { status: "unknown" };
}

/** The field one issue is about, as the repair card draws it. */
function describeField(
  issue: PropertyIssue,
  prop: EffectiveProperty | undefined
): ProposalRepairField {
  const options = prop ? resolvePropertyOptions(prop) : undefined;
  const single =
    issue.kind === "not_in_options" && issue.rejected?.length === 1
      ? issue.rejected[0]
      : undefined;
  const refusal =
    issue.kind !== "not_in_options"
      ? ({ refusal: "not_a_closed_set" } as const)
      : single === undefined || !prop
        ? ({ refusal: "not_a_closed_set" } as const)
        : addEnumOptionRefusal(
            {
              constraints: prop.constraints as Record<string, unknown> | null,
              uiHints: prop.uiHints as Record<string, unknown> | null,
              isLifecycle: prop.isLifecycle,
            },
            single
          );
  return {
    key: issue.key,
    label: prop ? resolvePropertyLabel(prop) : issue.key,
    kind: issue.kind,
    message: issue.message,
    ...(issue.rejected ? { rejected: issue.rejected } : {}),
    ...(options?.length ? { options } : {}),
    ...(issue.didYouMean ? { didYouMean: issue.didYouMean } : {}),
    canAddOption: refusal === null,
    ...(refusal ? { addOptionRefusal: refusal.refusal } : {}),
  };
}

/**
 * THE projection. Pure over the database read; authority is the caller's
 * (`proposals.repairOptions` gates on the same ladder as approve).
 */
export async function describeProposalRepair(
  source: RepairSource,
  userId: string
): Promise<ProposalRepair> {
  const none: ProposalRepair = {
    proposalId: source.id,
    repairable: false,
    fields: [],
  };
  if (!isRepairableKind(source)) return none;
  if (
    source.status !== ProposalStatus.APPROVAL_FAILED &&
    source.status !== ProposalStatus.PENDING
  ) {
    return none;
  }

  const profiles = new ProfileResolutionService(db);
  const target = await resolveTarget(source, userId, profiles);
  if (target.status === "missing") {
    return { ...none, missingKind: target.slug };
  }
  if (target.status !== "ok") return none;

  const inner = entityProposalInner(source.data);
  const properties = asRecord(inner.properties);
  const validation = new PropertyValidationService(profiles);
  const result =
    source.proposalType === "create"
      ? await validation.validateEntityCreateForProposal(
          properties,
          target.profileId,
          source.workspaceId,
          {
            ...(typeof inner.title === "string" ? { title: inner.title } : {}),
            profileDefaults: target.profileDefaults,
          }
        )
      : await validation.validateProperties(
          properties,
          target.profileId,
          source.workspaceId,
          // An update patches some fields; a field it does not touch is not
          // missing.
          { enforceRequired: false }
        );

  const effective = await profiles.getEffectiveProperties(
    target.profileId,
    source.workspaceId
  );
  const fields = result.issues.map((issue) =>
    describeField(
      issue,
      effective.find((p) => p.slug === issue.key)
    )
  );
  return { proposalId: source.id, repairable: fields.length > 0, fields };
}

/**
 * The property def a repair adds an option to: the effective one the
 * proposal's lens sees, so an overlay grows its overlay and a base field its
 * base row.
 */
export async function findEffectiveField(
  source: RepairSource,
  userId: string,
  key: string
): Promise<EffectiveProperty | undefined> {
  const profiles = new ProfileResolutionService(db);
  const target = await resolveTarget(source, userId, profiles);
  if (target.status !== "ok") return undefined;
  const effective = await profiles.getEffectiveProperties(
    target.profileId,
    source.workspaceId
  );
  return effective.find((p) => p.slug === key);
}
