/**
 * `moveStatus` — THE door for moving a thing's lifecycle status (work model
 * L2, founder W12–W14). Every surface uses it: an agent, a UI drag, the stage
 * door, sync, the entity update door when it carries the lifecycle key.
 *
 *   resolve the target (kind → entity row, role → facet row) + its lifecycle
 *   → classify the target option (category, humanOnly)
 *   → STAGE GATE (an agent's move on the subject of an open session that
 *     follows a playbook, `focus-sessions/subject-move-gate.ts`): a move that
 *     would skip a gated stage is refused; one into a human- or check-gated
 *     stage is routed as that stage's advance, so the gate decides BEFORE the
 *     status is written (a human gate's approval writes it)
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
 * strict CAS. A person's own app sign-in (`app_person`, backend #94) is that
 * PERSON, as for every other write it makes. `system` is server code only: a
 * request can never claim it. The app a move was made with is stamped on its
 * transition by `transitionStamp` (`actorClass: "app"`, `appId`), not here.
 */
import {
  db,
  applyStatusMove,
  canonicalLifecycleOptionKey,
  classifyStatusMove,
  resolveStatusMoveTarget,
  expireProposalsStaleAfterMove,
  listHolds,
  type ApplyStatusMoveResult,
  type StatusMoveActor,
} from "@synap/database";
import { dispatchLifecycleTransition } from "@synap/events";
import {
  decideMoveHold,
  findLifecycleOption,
  isTerminalLifecycleCategory,
  resolveOccurredAt,
  type Hold,
} from "@synap-core/types/lifecycle";
import { createLogger } from "@synap-core/core";
import {
  checkPermissionOrPropose,
  previewPermissionDecision,
} from "../../utils/permission-check.js";
import { roleWriteGrantSpace } from "../../utils/role-write-grant.js";
import { ownWorkOrganiseForTaskClose } from "../governance/own-organise.js";
import { mayWriteStatusTarget } from "./status-write-floor.js";
import { markProposalNotificationsActioned } from "../../notifications/mark-proposal-notifications-actioned.js";
import { appSignInPublicId } from "../app-sign-in-policy.js";
import type { GatedStageEntry } from "../focus-sessions/subject-move-gate.js";

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
  /**
   * What a move into a paused status waits on (W4). An agent's pause without
   * one is refused (`HOLD_REQUIRED`) before anything is filed; a person's or
   * the system's is recorded `unspecified`.
   */
  hold?: Hold | null;
  /**
   * When it really happened, if earlier than now: at most 30 days back, never
   * ahead (`resolveOccurredAt`). The move is marked backdated.
   */
  occurredAt?: string | Date | null;
  /**
   * The hold to record when the move PAUSES and the mover gave none — a
   * process stage's own (`{ on: "thing", ref: "stage:<key>" }`). Ignored on a
   * move that does not pause.
   */
  pauseHold?: Hold;
  /** A replay: the app its proposal was filed by (`proposals.app_id`). */
  appId?: string | null;
  /**
   * A session END move (`subjectProfile.onEnd`): governed like any write of
   * the closer, without the done/lost default floor — the session's end is
   * the guardrail (governance-policy `lifecycleMove.atSessionEnd`). Set ONLY
   * by the close door's writer (session-end-moves.ts); no request input
   * reaches it.
   */
  atSessionEnd?: boolean;
  /**
   * A session BIRTH move (a session started into a playbook's first stage,
   * `writeBirthStageSubjectStatus`): one that would take the thing OUT of a
   * done or lost option always proposes (governance-policy
   * `lifecycleMove.atSessionBirth`, rung 2.076): the person confirms the
   * reopen. Set ONLY by the birth writer; no request input reaches it.
   */
  atSessionBirth?: boolean;
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
 *  - a person's app sign-in (grant names an app, no agent acts: the
 *    `app_person` key, `app-sign-in-policy.ts`) → the PERSON, whatever
 *    `source` it carries: every hub-scoped key is branded AI on the ctx
 *    (`api-key-auth.ts`) and the hub forwarder stamps `source:
 *    "intelligence"` on the body (`hub-protocol/entities.ts` updateEntity),
 *    so neither says who holds this key. Never `system` (its hub ctx has no
 *    `req`);
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
  if (appSignInPublicId()) {
    return { actor: { kind: "human", userId }, approvedProposalId };
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
      /**
       * The move entered a HUMAN-gated stage of a session about this thing:
       * the proposal is that stage's gate, and approving it writes the status
       * (`subject-move-gate.ts`).
       */
      stageGate?: { sessionId: string; stageKey: string };
    }
  | { status: "denied"; reason: string }
  | {
      status: "refused";
      code:
        | "NOT_FOUND"
        | "NO_LIFECYCLE"
        | "NOT_THE_LIFECYCLE"
        | "ROLE_NOT_ATTACHED"
        | "UNKNOWN_OPTION"
        | "HOLD_REQUIRED"
        | "HOLD_INVALID"
        | "HOLD_NOT_A_PAUSE"
        | "OCCURRED_AT_INVALID"
        | "STAGE_GATE";
      reason: string;
      /** STAGE_GATE: the session whose stage gate refused or held the move. */
      sessionId?: string;
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
  // WRITE FLOOR before anything else is said about the thing. A mover must be
  // able to TARGET it for a write — the floor the update doors apply
  // (`entities.update`: `entityWriteVisibleWhere`; `entities.updateFacet`:
  // `canWriteFacet`) — not merely READ it. Doors that accept a subject on read
  // visibility (a session's subject: `isOutputRefVisible`) reach this door
  // too, and governance below runs on the CALLER's lens for a pod-wide row,
  // so a reader of a shared pod-wide row (home space, facet, pod share) could
  // otherwise move its owner's status. Server code (`system`) and an approved
  // replay already hold a decision. Same answer as those doors: NOT_FOUND.
  if (
    input.actor.kind !== "system" &&
    !input.approvedProposalId &&
    !(await mayWriteStatusTarget(target, input.actor.userId))
  ) {
    return {
      status: "refused",
      code: "NOT_FOUND",
      reason: "Entity not found",
    };
  }
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
  // WHEN and WHAT IT WAITS ON, refused before anything is filed: an agent's
  // proposal without a hold could only be refused at approval. A replay keeps
  // the time and hold its proposal was filed with (checked then).
  let occurredAt: Date | null = null;
  if (input.occurredAt != null) {
    if (input.approvedProposalId) {
      occurredAt = new Date(input.occurredAt);
    } else {
      const when = resolveOccurredAt(input.occurredAt);
      if (!when.ok) {
        return {
          status: "refused",
          code: "OCCURRED_AT_INVALID",
          reason: when.message,
        };
      }
      occurredAt = when.occurredAt;
    }
  }
  const fromCategory =
    findLifecycleOption(target.lifecycle, target.current)?.category ?? null;
  // `classifyStatusMove` answered, so the option exists.
  const toCategory = findLifecycleOption(target.lifecycle, to)!.category;
  // A process stage that pauses its subject says what it waits on (the
  // stage), so an agent driving the stage is not asked for one.
  const hold =
    input.hold ?? (toCategory === "paused" ? input.pauseHold : undefined);
  const holdCheck = decideMoveHold({
    from: target.current,
    fromCategory,
    toCategory,
    actorKind: input.actor.kind,
    approved: Boolean(input.approvedProposalId),
    given: hold,
    current:
      fromCategory === "paused"
        ? ((
            await listHolds(db, {
              subjects: [
                {
                  subjectType: "entity",
                  subjectId: target.entityId,
                  facetId: target.facetId,
                },
              ],
            })
          )[0]?.hold ?? null)
        : null,
    since: occurredAt ?? new Date(),
  });
  if (!holdCheck.ok) {
    return {
      status: "refused",
      code: holdCheck.code,
      reason: holdCheck.message,
    };
  }

  // THE STAGE GATE the move would walk (finding 8f2dee79,
  // `focus-sessions/subject-move-gate.ts`): an agent's move on the subject of
  // an open session following a playbook is refused when it would skip a
  // gated stage (the advance's own refusal), and routed as the stage advance
  // when it enters a human- or check-gated stage, BEFORE anything is written.
  // A person's move is the person deciding (the gate floor and the follow
  // treat it so); server code, a replay, a session's end and birth moves
  // already run the session's own lifecycle.
  let gateEntries: GatedStageEntry[] | null = null;
  if (
    agent &&
    !input.approvedProposalId &&
    !input.atSessionEnd &&
    !input.atSessionBirth
  ) {
    // Dynamic: the advance door reaches this door back (its subject write).
    const { planSubjectMoveGates } =
      await import("../focus-sessions/subject-move-gate.js");
    const plan = await planSubjectMoveGates({
      entityId: target.entityId,
      role: target.role ?? null,
      property: target.lifecycle.propertySlug,
      to,
    });
    if (plan.kind === "refused") {
      return {
        status: "refused",
        code: "STAGE_GATE",
        reason: plan.reason,
        sessionId: plan.sessionId,
      };
    }
    if (plan.kind === "enter") gateEntries = plan.entries;
  }

  const governanceWorkspaceId = target.workspaceId ?? input.workspaceId ?? null;
  let receiptId: string | undefined;
  if (input.actor.kind !== "system" && !input.approvedProposalId) {
    // FB1020 B3: an agent closing its OWN FRESH task (same key, last 24 h,
    // untouched by a person) may be applied by the pod's own-organise class
    // row; every other terminal move proposes by default (2.85), as before.
    const ownWorkOrganise =
      agent &&
      lifecycleMove.intoTerminal &&
      input.forcePropose !== true &&
      (await ownWorkOrganiseForTaskClose({
        agentUserId: input.actor.agentUserId,
        target,
        to,
      }));
    const data = {
      id: input.entityId,
      entityId: input.entityId,
      role: target.role,
      facetId: target.facetId,
      property: target.lifecycle.propertySlug,
      // The belief the approval replays against (strict CAS).
      expectedFrom: target.current,
      to,
      reason: input.reason ?? null,
      // Replayed with the move (the approval keeps them).
      ...(hold ? { hold } : {}),
      ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}),
    };
    // The key's grant is checked on the row's own workspace — a pod-wide
    // entity is pod-scope, never the caller's lens (S7). A ROLE's move is a
    // role write: checked where the role lives (THE rule, `roleWriteGrantSpace`
    // — a stamped role in its space, a shared one in a key space it is granted
    // to), as `entity.<kind>.update` (a status move is an update, #239).
    let grantWorkspaceId = target.workspaceId ?? null;
    if (target.facetId) {
      const roleGrant = await roleWriteGrantSpace(
        "update",
        {
          entityId: input.entityId,
          facetId: target.facetId,
          // Only an add / remove reads the role's spaces.
          profileId: null,
          storedWorkspaceId: target.workspaceId ?? null,
        },
        { subjectType: "entity", action: "transition", data }
      );
      if ("denied" in roleGrant) {
        return { status: "denied", reason: roleGrant.denied };
      }
      grantWorkspaceId = roleGrant.space;
    }
    const permissionOpts: Parameters<typeof checkPermissionOrPropose>[0] = {
      userId: input.actor.userId,
      agentUserId: input.actor.agentUserId ?? undefined,
      workspaceId: governanceWorkspaceId,
      grantWorkspaceId,
      // A shared role's row names no space: its proposal is filed in the space
      // the grant was checked in. Record only: the decision is unchanged.
      proposalWorkspaceId:
        target.workspaceId ?? grantWorkspaceId ?? input.workspaceId ?? null,
      subjectType: "entity",
      action: "transition",
      // An unattributed agent reaches the anonymous AI ladder; never "user".
      source: agent
        ? input.actor.agentUserId
          ? "agent"
          : "intelligence"
        : "user",
      lifecycleMove: {
        ...lifecycleMove,
        // A reopen: from a done/lost option to an open one, read from the
        // lifecycle's own categories (the same derivation the end move's
        // `already_settled` reads).
        outOfTerminal:
          isTerminalLifecycleCategory(fromCategory) &&
          !isTerminalLifecycleCategory(toCategory),
        ...(input.atSessionEnd ? { atSessionEnd: true } : {}),
        ...(input.atSessionBirth ? { atSessionBirth: true } : {}),
      },
      forcePropose: input.forcePropose,
      ...(ownWorkOrganise ? { ownWorkOrganise: true } : {}),
      reasoning:
        input.reason ??
        `Move ${target.lifecycle.propertySlug} from "${target.current ?? "none"}" to "${to}".`,
      sessionId: input.sessionId ?? undefined,
      data,
    };
    if (gateEntries) {
      // A mover the ladder would DENY files no gate either; otherwise the
      // gate is the decision: entering the stage is what the person approves,
      // and the approval writes the status (as the approver).
      const preview = await previewPermissionDecision(permissionOpts);
      if (preview.decision === "deny") {
        return { status: "denied", reason: preview.reason };
      }
      const { enterGatedStages } =
        await import("../focus-sessions/subject-move-gate.js");
      const gated = await enterGatedStages({
        entries: gateEntries,
        property: target.lifecycle.propertySlug,
        to,
        agentUserId: input.actor.agentUserId ?? null,
      });
      if (gated.kind === "gate_filed") {
        return {
          status: "proposed",
          proposalId: gated.proposalId,
          proposalType: gated.proposalType,
          stageGate: { sessionId: gated.sessionId, stageKey: gated.stageKey },
        };
      }
      if (gated.kind === "held") {
        return {
          status: "refused",
          code: "STAGE_GATE",
          reason: gated.reason,
          sessionId: gated.sessionId,
        };
      }
      // Every check passed: the stage stands, the move goes on as asked.
    }
    const perm = await checkPermissionOrPropose(permissionOpts);
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
    hold,
    occurredAt,
    appId: input.appId,
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
