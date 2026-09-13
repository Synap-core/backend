/**
 * capture-plan-preflight — the DB half of a connected plan's preflight.
 *
 * Called ONLY from `preflightCaptureGraphOperations` (submit-capture-graph.ts),
 * which is the one preflight a submit, a `validate: true` dry run and a
 * revision of a pending plan all run. The pure half (ref integrity, cycles,
 * limits) is `validatePlanOperations`; this adds what needs the database:
 *
 *   - every EXISTING session id a plan names belongs to the plan's owner — the
 *     same owner floor the edge producers apply at approval, raised at propose
 *     time so a proposal that approval would refuse is never filed;
 *   - every existing entity / project id is visible to that owner;
 *   - each `create_project` step's EVIDENCE: in-plan entity refs + visible
 *     existing ids, against the agent floor `projects.create` enforces. Below
 *     the floor is NOT a refusal inside a plan — the verdict is stamped onto
 *     the step so the reviewer sees it, and an agent-mode plan carrying it can
 *     never auto-apply (`submitCaptureGraph`).
 */

import {
  and,
  eq,
  inArray,
  focusSessions,
  projects,
  MIN_EVIDENCE_ENTITIES,
  type db,
} from "@synap/database";
import type {
  CompositeProposalOperation,
  PlanProjectEvidence,
} from "@synap-core/types/proposals";
import { ownerPrivateVisibleWhere } from "../../utils/user-visible-where.js";
import { isSubjectEntityVisible } from "../../utils/project-subject.js";
import {
  planRefKinds,
  validatePlanOperations,
  type CapturePlanProblem,
} from "./capture-plan.js";

type PlanDb = typeof db;

export interface PlanPreflightResult {
  problems: CapturePlanProblem[];
  /**
   * The same operations with each `create_project` step's `evidence` stamped
   * by the pod (any caller-supplied value is overwritten).
   */
  operations: CompositeProposalOperation[];
}

export async function preflightPlanOperations(
  database: PlanDb,
  operations: CompositeProposalOperation[],
  userId: string
): Promise<PlanPreflightResult> {
  const problems = validatePlanOperations(operations);
  const push = (opIndex: number, message: string) => {
    const op = operations[opIndex];
    const ref = (op as { ref?: unknown }).ref;
    problems.push({
      opIndex,
      ...(typeof ref === "string" && ref ? { ref } : {}),
      op: op.op,
      message,
    });
  };

  // ── Existing sessions: owned by the plan's owner ───────────────────────
  const sessionRefsById = new Map<string, number[]>();
  const noteSession = (id: string | undefined, opIndex: number) => {
    if (!id) return;
    sessionRefsById.set(id, [...(sessionRefsById.get(id) ?? []), opIndex]);
  };
  operations.forEach((op, i) => {
    if (op.op === "create_session") {
      noteSession(op.parentSessionId, i);
      for (const id of op.blockedBySessionIds ?? []) noteSession(id, i);
    } else if (op.op === "create_link") {
      noteSession(op.fromSessionId, i);
      noteSession(op.toSessionId, i);
    } else if (op.op === "create_document") {
      noteSession(op.sessionId, i);
    }
  });
  const uuidShaped = [...sessionRefsById.keys()].filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  );
  if (uuidShaped.length > 0) {
    const owned = await database
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(
          inArray(focusSessions.id, uuidShaped),
          eq(focusSessions.userId, userId)
        )
      );
    const ownedIds = new Set(owned.map((r) => r.id));
    for (const id of uuidShaped) {
      if (ownedIds.has(id)) continue;
      for (const opIndex of sessionRefsById.get(id) ?? []) {
        // One sentence for missing AND not-yours: the owner floor cannot tell
        // them apart, and a split would be an existence oracle.
        push(opIndex, `session ${id} was not found among your sessions`);
      }
    }
  }

  // ── Existing projects: visible ─────────────────────────────────────────
  const projectIdsByOp = new Map<string, number[]>();
  operations.forEach((op, i) => {
    const id =
      op.op === "create_session" || op.op === "create_entity"
        ? op.projectId
        : undefined;
    if (id) projectIdsByOp.set(id, [...(projectIdsByOp.get(id) ?? []), i]);
  });
  // `create_entity.projectId` is also validated by the submit door's own pin
  // check; only plan batches reach this query for it, and a stale pin there is
  // still a problem worth naming at propose time.
  const hasPlanOp = operations.some((op) =>
    [
      "create_session",
      "create_document",
      "create_project",
      "create_link",
    ].includes(op.op)
  );
  if (hasPlanOp && projectIdsByOp.size > 0) {
    const ids = [...projectIdsByOp.keys()];
    const visible = await database
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          inArray(projects.id, ids),
          ownerPrivateVisibleWhere(
            projects.workspaceId,
            projects.userId,
            userId
          )
        )
      );
    const visibleIds = new Set(visible.map((r) => r.id));
    for (const id of ids) {
      if (visibleIds.has(id)) continue;
      for (const opIndex of projectIdsByOp.get(id) ?? []) {
        push(opIndex, `project ${id} was not found`);
      }
    }
  }

  // ── Existing entities: visible (subject / attach / evidence) ───────────
  const entityChecks = new Map<string, number[]>();
  const noteEntity = (id: string | undefined, opIndex: number) => {
    if (!id) return;
    entityChecks.set(id, [...(entityChecks.get(id) ?? []), opIndex]);
  };
  operations.forEach((op, i) => {
    if (op.op === "create_session") noteEntity(op.subjectEntityId, i);
    else if (op.op === "create_document") noteEntity(op.entityId, i);
    else if (op.op === "create_project") {
      noteEntity(op.subjectEntityId, i);
      for (const id of op.evidenceEntityIds ?? []) noteEntity(id, i);
    }
  });
  const visibleEntityIds = new Set<string>();
  for (const id of entityChecks.keys()) {
    if (await isSubjectEntityVisible(database, id, userId)) {
      visibleEntityIds.add(id);
    }
  }
  operations.forEach((op, i) => {
    const mustSee =
      op.op === "create_session"
        ? [op.subjectEntityId]
        : op.op === "create_document"
          ? [op.entityId]
          : op.op === "create_project"
            ? [op.subjectEntityId]
            : [];
    for (const id of mustSee) {
      if (id && !visibleEntityIds.has(id)) {
        push(i, `entity ${id} was not found`);
      }
    }
  });

  // ── Project evidence: stamped, never waived silently ───────────────────
  const kinds = planRefKinds(operations);
  const stamped = operations.map((op): CompositeProposalOperation => {
    if (op.op !== "create_project") return op;
    const inPlan = new Set(
      (op.evidenceRefs ?? []).filter((ref) => kinds.get(ref) === "entity")
    );
    const existing = new Set(
      (op.evidenceEntityIds ?? []).filter((id) => visibleEntityIds.has(id))
    );
    const counted = inPlan.size + existing.size;
    const evidence: PlanProjectEvidence = {
      counted,
      minimum: MIN_EVIDENCE_ENTITIES,
      belowAgentFloor: counted < MIN_EVIDENCE_ENTITIES,
    };
    return { ...op, evidence };
  });

  return { problems, operations: stamped };
}
