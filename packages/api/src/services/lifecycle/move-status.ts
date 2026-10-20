/**
 * `moveStatus` — THE door for moving a thing's lifecycle status (work model
 * L2, founder W12–W14). Every surface uses it: an agent, a UI drag, the stage
 * door, sync, the entity update door when it carries the lifecycle key.
 *
 *   resolve the target (kind → entity row, role → facet row) + its lifecycle
 *   → classify the target option (category, humanOnly)
 *   → GOVERN: `checkPermissionOrPropose(entity.transition, lifecycleMove)` —
 *     RBAC for a person; for an agent the engine's floor: a human-only option
 *     always proposes, into done/lost proposes by default, other moves execute
 *   → WRITE: `applyStatusMove` (@synap/database) — one compare-and-set
 *     statement writing the columns (the truth) and `properties[slug]` (the
 *     read projection). Agents are strict CAS; a person's move wins.
 *     The owed event is written in the same transaction (outbox, D8).
 *   → EMIT: `dispatchLifecycleTransition` (@synap/events) — the ONE event;
 *     a failed delivery stays owed and the sweeper retries it.
 *
 * A proposed agent move is SUCCESS (the person reviews it). Its approval
 * replays the move with the agent's original `expectedFrom`
 * (`executors/entity-transition.ts`), so a person moving the thing meanwhile
 * makes that approval fail as stale instead of overwriting them. Every replay
 * is strict, whoever filed it.
 *
 * WHO IS MOVING (`statusMoveActorFor`, the one derivation for the request
 * doors): an AI write with no agent attribution (a service / hub key) is an
 * unattributed AGENT, never a person — governed on the anonymous AI ladder and
 * strict CAS. `system` is server code only: a request can never claim it.
 */
import {
  db,
  applyStatusMove,
  canonicalLifecycleOptionKey,
  classifyStatusMove,
  resolveStatusMoveTarget,
  expireProposalsStaleAfterMove,
  type ApplyStatusMoveResult,
  type StatusMoveActor,
} from "@synap/database";
import { dispatchLifecycleTransition } from "@synap/events";
import { createLogger } from "@synap-core/core";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { markProposalNotificationsActioned } from "../../notifications/mark-proposal-notifications-actioned.js";

const logger = createLogger({ module: "move-status" });

export interface MoveStatusInput {
  entityId: string;
  /** Role-profile slug: move the ROLE's status (its facet), not the kind's. */
  role?: string | null;
  /** Name the facet when a role is attached more than once. */
  facetId?: string | null;
  /**
   * The property the caller means to move. When given and it is NOT the
   * declared lifecycle, the door refuses with `NOT_THE_LIFECYCLE` (the caller
   * is writing a plain property and keeps its own path).
   */
  property?: string;
  /** What the mover saw. `undefined` = not expressed (the current value). */
  expectedFrom?: string | null;
  to: string;
  actor: StatusMoveActor;
  sessionId?: string | null;
  reason?: string | null;
  /** The caller's workspace lens (governance + trigger routing for pod-wide kinds). */
  workspaceId?: string | null;
  /** OR-ed into governance (never downgrades). */
  forcePropose?: boolean;
  /** An approved proposal replaying this move — governance already decided. */
  approvedProposalId?: string | null;
}

const AI_SOURCES = new Set(["ai", "intelligence", "agent"]);

/** The request facts `statusMoveActorFor` reads (a subset of the tRPC ctx). */
export interface StatusMoveCallerContext {
  userId?: string | null;
  /** Server-set: `intelligence` for a hub / api-key caller. */
  source?: string | null;
  /** Server-set: true only for a hub-protocol key. */
  isHubProtocol?: boolean;
  /** Server-set: the authenticated agent (agent key / approval caller). */
  agentUserId?: string | null;
  /** Server-set: an internal caller that already holds a governance decision. */
  governanceProposalId?: string;
  /** Present on every request that arrived over the wire. */
  req?: unknown;
}

/**
 * Who a request-door status move is made by, derived ONCE for
 * `entities.update` and `entities.updateFacet` (backend review F1/F2/F15):
 *  - an attributed agent (body or ctx) → `agent`;
 *  - an AI caller (AI `source` in the body or on the ctx, or a hub key) with
 *    no agent → an UNATTRIBUTED agent (`agentUserId: null`), never a person;
 *  - `source: "system"` → `system` only for server code (no wire request);
 *    a client that sends it is a person;
 *  - an internal caller holding a decision (`ctx.governanceProposalId`) is a
 *    REPLAY: governance is skipped and the CAS is strict.
 */
export function statusMoveActorFor(
  ctx: StatusMoveCallerContext,
  input: { source?: string | null; agentUserId?: string | null }
): { actor: StatusMoveActor; approvedProposalId?: string } {
  const userId = ctx.userId ?? "";
  const agentUserId = input.agentUserId ?? ctx.agentUserId ?? null;
  const approvedProposalId = ctx.governanceProposalId || undefined;
  if (agentUserId) {
    return {
      actor: { kind: "agent", userId, agentUserId },
      approvedProposalId,
    };
  }
  const aiCaller =
    ctx.isHubProtocol === true ||
    AI_SOURCES.has(ctx.source ?? "") ||
    AI_SOURCES.has(input.source ?? "");
  if (aiCaller) {
    return {
      actor: { kind: "agent", userId, agentUserId: null },
      approvedProposalId,
    };
  }
  if (input.source === "system" && ctx.req === undefined) {
    return { actor: { kind: "system", userId }, approvedProposalId };
  }
  return { actor: { kind: "human", userId }, approvedProposalId };
}

export type MoveStatusResult =
  | ApplyStatusMoveResult
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl?: string;
      proposalType: string;
    }
  | { status: "denied"; reason: string }
  | {
      status: "refused";
      code:
        | "NOT_FOUND"
        | "NO_LIFECYCLE"
        | "NOT_THE_LIFECYCLE"
        | "ROLE_NOT_ATTACHED"
        | "UNKNOWN_OPTION";
      reason: string;
    };

export async function moveStatus(
  input: MoveStatusInput
): Promise<MoveStatusResult> {
  const resolved = await resolveStatusMoveTarget(db, {
    entityId: input.entityId,
    role: input.role,
    facetId: input.facetId,
    workspaceId: input.workspaceId,
  });
  if (!resolved.ok) {
    return { status: "refused", code: resolved.code, reason: resolved.reason };
  }
  const { target } = resolved;
  if (input.property && input.property !== target.lifecycle.propertySlug) {
    return {
      status: "refused",
      code: "NOT_THE_LIFECYCLE",
      reason: `"${input.property}" is not the lifecycle of ${target.role ?? target.entityType ?? "this kind"} ("${target.lifecycle.propertySlug}" is)`,
    };
  }
  // INPUT NORMALISER: `in_progress` for a declared `in-progress` (case or
  // separator only) moves to the declared option; everything below — the
  // governance classification, the proposal, the write, the event — sees the
  // canonical key. Anything else is refused, naming the options.
  const to = canonicalLifecycleOptionKey(target.lifecycle, input.to);
  const lifecycleMove = classifyStatusMove(target.lifecycle, to);
  if (!lifecycleMove) {
    return {
      status: "refused",
      code: "UNKNOWN_OPTION",
      reason: `"${input.to}" is not a status of ${target.role ?? target.entityType ?? "this kind"} (${target.lifecycle.options.map((o) => o.key).join(", ")})`,
    };
  }
  const agent = input.actor.kind === "agent";
  // Strict compare-and-set: every non-person, and every approval replay.
  const strict =
    input.actor.kind !== "human" || Boolean(input.approvedProposalId);
  // An agent acting on a belief that is already false never files a proposal
  // that could only fail at approval.
  if (
    strict &&
    input.expectedFrom !== undefined &&
    (input.expectedFrom ?? null) !== target.current
  ) {
    return {
      status: "conflict",
      expectedFrom: input.expectedFrom ?? null,
      actual: target.current,
    };
  }
  if (target.current === to) {
    return { status: "unchanged", current: to };
  }

  const governanceWorkspaceId = target.workspaceId ?? input.workspaceId ?? null;
  let receiptId: string | undefined;
  if (input.actor.kind !== "system" && !input.approvedProposalId) {
    const perm = await checkPermissionOrPropose({
      userId: input.actor.userId,
      agentUserId: input.actor.agentUserId ?? undefined,
      workspaceId: governanceWorkspaceId,
      // The key's grant is checked on the row's own workspace — a pod-wide
      // entity or role facet is pod-scope, never the caller's lens (S7).
      grantWorkspaceId: target.workspaceId ?? null,
      subjectType: "entity",
      action: "transition",
      // An unattributed agent reaches the anonymous AI ladder; never "user".
      source: agent
        ? input.actor.agentUserId
          ? "agent"
          : "intelligence"
        : "user",
      lifecycleMove,
      forcePropose: input.forcePropose,
      reasoning:
        input.reason ??
        `Move ${target.lifecycle.propertySlug} from "${target.current ?? "none"}" to "${to}".`,
      sessionId: input.sessionId ?? undefined,
      data: {
        id: input.entityId,
        entityId: input.entityId,
        role: target.role,
        facetId: target.facetId,
        property: target.lifecycle.propertySlug,
        // The belief the approval replays against (strict CAS).
        expectedFrom: target.current,
        to,
        reason: input.reason ?? null,
      },
    });
    if ("denied" in perm && perm.denied) {
      return { status: "denied", reason: perm.reason };
    }
    if ("proposalId" in perm) {
      return {
        status: "proposed",
        proposalId: perm.proposalId,
        reviewUrl: perm.reviewUrl,
        proposalType: perm.proposalType,
      };
    }
    receiptId = "granted" in perm ? perm.autoApprovedProposalId : undefined;
  }

  const result = await applyStatusMove(db, {
    target,
    expectedFrom: input.expectedFrom,
    to,
    actor: input.actor,
    strict,
    sessionId: input.sessionId,
    reason: input.reason,
    proposalId: input.approvedProposalId ?? receiptId ?? null,
    lensWorkspaceId: input.workspaceId,
  });
  if (result.status === "moved") {
    // Owed in the move's transaction; a failed delivery stays owed (sweeper).
    await dispatchLifecycleTransition(result.transition.transitionId);
    // A person decided: pending agent proposals that believed another status
    // are stale, never left counting toward a worker's backlog (L2, F16). The
    // move already landed, so a failure here is logged, not thrown.
    if (result.transition.actorKind === "human") {
      try {
        const expired = await expireProposalsStaleAfterMove(
          db,
          result.transition
        );
        if (expired.length) markProposalNotificationsActioned(expired);
      } catch (err) {
        logger.warn(
          { err, entityId: input.entityId },
          "stale agent proposals not expired after a person's move"
        );
      }
    }
  }
  return result;
}
