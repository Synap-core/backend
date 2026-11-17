/**
 * RELABEL, REORDER OR RETIRE A KIND'S LIFECYCLE OPTIONS — the governed door
 * (ticket fd146324, second half).
 *
 * THE GAP IT CLOSES: the lifecycle door (`changeLifecycleOptions`,
 * @synap/database) was reachable only from a person's tRPC call
 * (`propertyDefs.changeLifecycleOptions`). An agent asked to rename "generating"
 * to "Stills" or retire an unused option could only hand the person manual
 * steps: `synap_declare_lifecycle` never replaces a lifecycle, and the field
 * update only appends.
 *
 * POLICY — the same as `profile/declare_lifecycle` and `property_def/retire`
 * (a schema change on a field every record of the kind stores its status in):
 *   - ALWAYS a PENDING proposal (`insertPendingProposal`, DIRECT door
 *     `property_def/change_lifecycle_options`). No execute branch: nothing here
 *     auto-applies, whatever a rule says.
 *   - Authority on the LOADED def (`assertPropertyDefSchemaWrite`, the floor
 *     the tRPC door applies), at filing AND again on the APPROVER.
 *   - ONE preflight, `planLifecycleOptionsChange`, the read-only half of the
 *     lifecycle door itself: a change the door would refuse is never filed,
 *     and the approval runs the door, which decides again on what is there then.
 *
 * WHAT APPROVAL DOES: `changeLifecycleOptions` — the def's options rewritten
 * through the one mapper, every record at a retired key moved to its remap,
 * the status columns re-projected, in one transaction. Not a status move: no
 * transition events for the remapped records.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  inArray,
  profiles,
  proposals,
  ProposalStatus,
  PropertyDefRepository,
  insertPendingProposal,
  planLifecycleOptionsChange,
  changeLifecycleOptions,
  type ChangeLifecycleOptionsInput,
  type LifecycleOptionsPlan,
} from "@synap/database";
import {
  buildObjectActionTitle,
  humanizeToken,
} from "@synap-core/types/vocabulary";
import { createLogger } from "@synap-core/core";
import { assertPropertyDefSchemaWrite } from "../pod-hygiene/retire-property-def.js";
import { describeLifecycleOption } from "./declare-kind-lifecycle.js";
import { auditLog } from "../../utils/audit-log.js";

const logger = createLogger({ module: "change-lifecycle-options" });

export const CHANGE_LIFECYCLE_OPTIONS_PROPOSAL_TYPE =
  "change_lifecycle_options" as const;

export type ProposeLifecycleOptionsChangeResult =
  | {
      status: "proposed";
      proposalId: string;
      propertyDefId: string;
      property: string;
      options: LifecycleOptionsPlan["options"];
      moves: Array<{ from: string; to: string }>;
    }
  | { status: "already_pending"; proposalId: string }
  | { status: "unchanged"; message: string }
  | { status: "refused"; reasons: string[] };

async function loadDef(propertyDefId: string) {
  const def = await new PropertyDefRepository(db).getById(propertyDefId);
  if (!def) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Property definition not found: ${propertyDefId}`,
    });
  }
  return def;
}

/** The kinds whose lifecycle the def is. */
async function kindsOf(
  profileIds: readonly string[]
): Promise<Array<{ slug: string; displayName: string }>> {
  if (profileIds.length === 0) return [];
  return db
    .select({ slug: profiles.slug, displayName: profiles.displayName })
    .from(profiles)
    .where(inArray(profiles.id, [...profileIds]));
}

/** PURE: the rows the review card renders — before, after, and where things move. */
export function lifecycleOptionsChangeReviewRows(
  kinds: readonly string[],
  plan: LifecycleOptionsPlan
): Record<string, string> {
  return {
    kind: kinds.join(", "),
    field: plan.slug,
    before: plan.before
      .map(
        (o) =>
          `${o.key} = ${o.label ?? humanizeToken(o.key)} (${o.category ?? "no category"})`
      )
      .join(" · "),
    after: plan.options.map(describeLifecycleOption).join(" · "),
    moves:
      plan.moves.length === 0
        ? "No option is retired: no record moves."
        : plan.moves
            .map(([from, to]) => `things at "${from}" move to "${to}"`)
            .join(" · "),
    on_approve: `The options of "${plan.slug}" become the list above; records at a retired option move to its replacement, and no status-change events are sent for them.`,
  };
}

async function pendingChangeFor(propertyDefId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, "property_def"),
        eq(proposals.proposalType, CHANGE_LIFECYCLE_OPTIONS_PROPOSAL_TYPE),
        eq(proposals.targetId, propertyDefId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * File a `property_def/change_lifecycle_options` proposal, or answer why not
 * (refused with the door's own reason, or unchanged). Never writes the schema.
 */
export async function proposeLifecycleOptionsChange(params: {
  userId: string;
  agentUserId?: string | null;
  input: ChangeLifecycleOptionsInput;
  reason?: string;
}): Promise<ProposeLifecycleOptionsChangeResult> {
  const def = await loadDef(params.input.propertyDefId);
  await assertPropertyDefSchemaWrite(db, params.userId, def);

  const plan = await planLifecycleOptionsChange(db, params.input);
  if (plan.status === "refused") {
    return { status: "refused", reasons: [plan.reason] };
  }
  if (plan.status === "unchanged") {
    return {
      status: "unchanged",
      message:
        "These are already the lifecycle's options, in this order: nothing was filed.",
    };
  }

  const existing = await pendingChangeFor(def.id);
  if (existing) return { status: "already_pending", proposalId: existing };

  const kinds = await kindsOf(plan.profileIds);
  const { proposal } = await insertPendingProposal({
    workspaceId: def.workspaceId ?? null,
    targetType: "property_def",
    targetId: def.id,
    // A literal, so the approval-half tripwire's pair scan sees this filing.
    proposalType: "change_lifecycle_options",
    data: {
      sourceId: params.userId,
      id: def.id,
      slug: plan.slug,
      options: plan.options,
      remap: Object.fromEntries(plan.moves),
      changeType: "update",
      properties: lifecycleOptionsChangeReviewRows(
        kinds.map((k) => `${k.displayName} (${k.slug})`),
        plan
      ),
      summary: buildObjectActionTitle({
        action: CHANGE_LIFECYCLE_OPTIONS_PROPOSAL_TYPE,
        objectName: kinds[0]?.slug ?? plan.slug,
      }),
      reasoning:
        params.reason ??
        `Add, relabel, reorder or retire the options of "${plan.slug}".`,
    },
    createdBy: params.userId,
    proposedByUserId: params.agentUserId ? null : params.userId,
    subjectUserId: params.userId,
    ...(params.agentUserId ? { agentUserId: params.agentUserId } : {}),
  });
  return {
    status: "proposed",
    proposalId: proposal.id,
    propertyDefId: def.id,
    property: plan.slug,
    options: plan.options,
    moves: plan.moves.map(([from, to]) => ({ from, to })),
  };
}

/**
 * Apply at APPROVAL time, from what the reviewer saw (`proposal.data`): the
 * authority floor on the APPROVER, then the lifecycle door itself, which
 * refuses what no longer holds (an option gone, a remap target dropped).
 */
export async function applyLifecycleOptionsChange(params: {
  approverUserId: string;
  sourceProposalId: string;
  input: ChangeLifecycleOptionsInput;
}): Promise<{ status: "changed"; remapped: number } | { status: "unchanged" }> {
  const def = await loadDef(params.input.propertyDefId);
  await assertPropertyDefSchemaWrite(db, params.approverUserId, def);
  const result = await changeLifecycleOptions(db, params.input);
  if (result.status === "refused") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Lifecycle change refused at approval: ${result.reason}`,
    });
  }
  void auditLog({
    subjectType: "property_def",
    action: CHANGE_LIFECYCLE_OPTIONS_PROPOSAL_TYPE,
    phase: "completed",
    subjectId: def.id,
    userId: params.approverUserId,
    workspaceId: def.workspaceId ?? null,
    proposalId: params.sourceProposalId,
  });
  logger.info(
    {
      propertyDefId: def.id,
      proposalId: params.sourceProposalId,
      result,
    },
    "lifecycle options changed through an approved proposal"
  );
  return result;
}

/** Read the door's input back off a stored proposal (what the reviewer saw). */
export function lifecycleOptionsChangeInputFromProposal(proposal: {
  targetId: string;
  data: unknown;
}): ChangeLifecycleOptionsInput {
  const d = (proposal.data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(d.options)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Lifecycle change proposal is missing its options",
    });
  }
  const remap =
    d.remap && typeof d.remap === "object"
      ? (d.remap as Record<string, string>)
      : undefined;
  return {
    propertyDefId: proposal.targetId,
    options: d.options,
    ...(remap ? { remap } : {}),
  };
}
