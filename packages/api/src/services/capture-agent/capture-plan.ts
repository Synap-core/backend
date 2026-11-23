/**
 * capture-plan — the PURE half of a connected plan: ref integrity, edge shape,
 * cycle refusal and apply order. No DB.
 *
 * A plan is a composite graph that also carries `create_session` /
 * `create_document` / `create_project` / `create_link` ops (see
 * `CompositeCreateSessionOp` in `@synap-core/types/proposals`). Every check
 * here runs on the STORED op shape, so the same function validates a fresh
 * submit (`preflightCaptureGraphOperations`), a `validate: true` dry run, and a
 * revision of a pending plan (`mergeProposalRevision`) — one implementation,
 * every problem reported at once.
 *
 * What this module deliberately does NOT decide: ownership / visibility of the
 * real ids a plan names (that needs the DB — `capture-plan-preflight.ts`) and
 * governance (`capture-graph-policy.ts`).
 */

import {
  BIND_RENDERER_TARGET_KINDS,
  COMPOSITE_VIEW_TYPES,
  isDomainOperation,
  isLikelyUUID,
  isPlanOperation,
  isUpdateOperation,
  type UPDATE_OPERATION_KINDS,
  updateOperationTargetId,
  PLAN_LINK_TYPES,
  type CompositeProposalOperation,
  type PlanLinkType,
} from "@synap-core/types/proposals";
import {
  normalizeSessionTitle,
  SESSION_TITLE_MAX,
} from "@synap-core/types/focus-sessions";
import { shouldMaterializeAsDocument } from "@synap-core/types/documents";
import { decisionRecordView } from "@synap-core/types/ask";
import {
  STEP_DUE_BY_KEY,
  STEP_PLANNED_FOR_KEY,
  isStepDate,
  stepDateRefusal,
} from "@synap-core/types/units";
import {
  skillAuthoringProblem,
  skillSlugProblem,
} from "../skills/skill-authoring.js";

/**
 * Every step array a capture call may carry (`CapturePlanInput`), the one
 * list both caller doors (MCP `synap_capture`, Hub REST `POST /capture/graph`)
 * read, so neither can accept a step the other cannot.
 */
export const CAPTURE_PLAN_KEYS = [
  "sessions",
  "documents",
  "projects",
  "tracks",
  "edits",
  "links",
  "skills",
  "automations",
  "rules",
  "playbooks",
  "views",
  "cells",
  "renderers",
  "workspaces",
  "kinds",
  "lifecycles",
  "updates",
] as const;

/** The session door's goal bound (`rest/focus-sessions.ts` `goal.max(2000)`). */
export const PLAN_SESSION_GOAL_MAX = 2000;
/** The project door's name bound (`projects.create` `name.max(255)`). */
export const PLAN_PROJECT_NAME_MAX = 255;

// ── Rule Loop enumerations, DERIVED from the op union ──────────────────────
// Hand-written literal arrays are how a validator falls behind the type it
// validates. Each array below is bound to its op field in BOTH directions at
// compile time: `satisfies` refuses a member the union does not have, and the
// `Exclude<…> extends never` floor refuses a union member the array is
// missing. Add a scope or a trigger type to the op and the BUILD stops here.
type SkillScope = Extract<
  CompositeProposalOperation,
  { op: "create_skill" }
>["scope"];
type AutomationTriggerType = Extract<
  CompositeProposalOperation,
  { op: "create_automation" }
>["triggerType"];
type RuleScopeKind = Extract<
  CompositeProposalOperation,
  { op: "create_rule" }
>["scope"]["kind"];

export const SKILL_SCOPES = [
  "pod",
  "user",
  "workspace",
] as const satisfies readonly SkillScope[];
export const AUTOMATION_TRIGGER_TYPES = [
  "event",
  "cron",
  "webhook",
  "manual",
] as const satisfies readonly AutomationTriggerType[];
export const RULE_SCOPE_KINDS = [
  "pod",
  "workspace",
  "user",
] as const satisfies readonly RuleScopeKind[];

type _AllRuleLoopEnumsCovered = [
  Exclude<SkillScope, (typeof SKILL_SCOPES)[number]>,
  Exclude<AutomationTriggerType, (typeof AUTOMATION_TRIGGER_TYPES)[number]>,
  Exclude<RuleScopeKind, (typeof RULE_SCOPE_KINDS)[number]>,
] extends [never, never, never]
  ? true
  : never;
const _allRuleLoopEnumsCovered: _AllRuleLoopEnumsCovered = true;
void _allRuleLoopEnumsCovered;

export type PlanRefKind =
  | "cell"
  | "entity"
  | "session"
  | "document"
  | "project"
  | "skill"
  | "automation"
  | "rule"
  | "playbook"
  | "view"
  | "workspace"
  | "track"
  | "kind"
  | "lifecycle";

export interface CapturePlanProblem {
  /** Index in `operations[]`. */
  opIndex: number;
  /** The op's own ref, when it has one. */
  ref?: string;
  op: CompositeProposalOperation["op"];
  message: string;
}

/** One step → decision / goal edge (a cross-kind `blocked_by` `create_link`). */
export interface PlanCrossKindEdge {
  opIndex: number;
  from: { ref: string } | { sessionId: string };
  to: { kind: "entity" | "track" } & ({ ref: string } | { id: string });
  /** The decision option the step waits on (an arm), when it names one. */
  option?: string;
}

/** True when a `create_link` waits on a decision or a goal, not a session. */
export function isCrossKindLink(
  op: Extract<CompositeProposalOperation, { op: "create_link" }>
): boolean {
  return !!(op.toEntityRef || op.toEntityId || op.toTrackRef || op.toTrackId);
}

/**
 * Every step → decision / goal `blocked_by` the plan declares — the cross-kind
 * half of the plan's edges. `planSessionEdges` is the session↔session half;
 * the two never overlap (`isCrossKindLink`).
 */
export function planCrossKindEdges(
  operations: CompositeProposalOperation[]
): PlanCrossKindEdge[] {
  const edges: PlanCrossKindEdge[] = [];
  operations.forEach((op, opIndex) => {
    if (op.op !== "create_link" || !isCrossKindLink(op)) return;
    const from = op.fromRef
      ? { ref: op.fromRef }
      : { sessionId: op.fromSessionId ?? "" };
    const to = op.toEntityRef
      ? { kind: "entity" as const, ref: op.toEntityRef }
      : op.toEntityId
        ? { kind: "entity" as const, id: op.toEntityId }
        : op.toTrackRef
          ? { kind: "track" as const, ref: op.toTrackRef }
          : { kind: "track" as const, id: op.toTrackId ?? "" };
    edges.push({
      opIndex,
      from,
      to,
      ...(op.option ? { option: op.option } : {}),
    });
  });
  return edges;
}

/** One session↔session edge, from a `create_session` field or a `create_link` op. */
export interface PlanSessionEdge {
  type: PlanLinkType;
  /** The op that declared it. */
  opIndex: number;
  from: { ref: string } | { sessionId: string };
  to: { ref: string } | { sessionId: string };
}

const OP_REF_KIND: Partial<
  Record<CompositeProposalOperation["op"], PlanRefKind>
> = {
  create_entity: "entity",
  create_session: "session",
  create_document: "document",
  create_project: "project",
  create_skill: "skill",
  create_automation: "automation",
  create_rule: "rule",
  create_playbook: "playbook",
  create_view: "view",
  create_cell: "cell",
  create_workspace: "workspace",
  create_track: "track",
  define_kind: "kind",
  declare_lifecycle: "lifecycle",
  // A re-plan's step update names an EXISTING session; its ref resolves to it.
  update_session: "session",
  // An update names an EXISTING row; its ref resolves to that row's id, so
  // a relation may target a reused container (`update_entity`).
  update_skill: "skill",
  update_automation: "automation",
  update_rule: "rule",
  update_playbook: "playbook",
  update_view: "view",
  update_entity: "entity",
};

/** ref → kind for every op that registers a ref (first declaration wins). */
export function planRefKinds(
  operations: CompositeProposalOperation[]
): Map<string, PlanRefKind> {
  const kinds = new Map<string, PlanRefKind>();
  operations.forEach((op, index) => {
    const kind = OP_REF_KIND[op.op];
    if (!kind) return;
    // `$opN` always names an entity op (registerEntityRef) — and any op that
    // registers refs registers its positional one too, so record both.
    const positional = `$op${index}`;
    if (!kinds.has(positional)) kinds.set(positional, kind);
    const ref = (op as { ref?: unknown }).ref;
    if (typeof ref === "string" && ref && !kinds.has(ref)) kinds.set(ref, kind);
  });
  return kinds;
}

/**
 * True when the batch carries any step this module VALIDATES and REPORTS —
 * the plan ops, plus the Rule Loop config ops.
 *
 * Deliberately NOT `isPlanBatch`, and the difference is load-bearing in both
 * directions:
 *
 *   - `isPlanBatch` (`@synap-core/types/proposals`) answers "does this batch
 *     apply ALL-OR-NONE?" — a materializer question about compensation. The
 *     three config ops are not plan ops and keep the per-op resilience the
 *     rest of the composite has; that is unchanged here.
 *   - this answers "does this batch have non-entity steps to check and to
 *     name on the receipt?" — a preflight/receipt question.
 *
 * Collapsing the two is how `validatePlanOperations`' config arms would become
 * DEAD CODE: the preflight is gated on the predicate, so a batch of only
 * skills/automations/rules would skip ref validation entirely and a bad
 * `factRef` would surface as a silently skipped op mid-materialize. Same for
 * the receipt: the filed steps would go unnamed.
 */
export function hasComposedSteps(
  operations: CompositeProposalOperation[]
): boolean {
  return operations.some(
    (op) =>
      isPlanOperation(op) ||
      op.op === "create_skill" ||
      op.op === "create_automation" ||
      op.op === "create_rule" ||
      op.op === "create_playbook" ||
      op.op === "create_view" ||
      op.op === "create_cell" ||
      op.op === "bind_renderer" ||
      isDomainOperation(op) ||
      isUpdateOperation(op)
  );
}

/** Every session↔session edge the plan declares, in declaration order. */
export function planSessionEdges(
  operations: CompositeProposalOperation[]
): PlanSessionEdge[] {
  const edges: PlanSessionEdge[] = [];
  operations.forEach((op, opIndex) => {
    if (op.op === "create_session") {
      const from = { ref: op.ref };
      if (op.parentRef) {
        edges.push({
          type: "spawned_from",
          opIndex,
          from,
          to: { ref: op.parentRef },
        });
      } else if (op.parentSessionId) {
        edges.push({
          type: "spawned_from",
          opIndex,
          from,
          to: { sessionId: op.parentSessionId },
        });
      }
      for (const blocker of op.blockedByRefs ?? []) {
        edges.push({ type: "blocked_by", opIndex, from, to: { ref: blocker } });
      }
      for (const blocker of op.blockedBySessionIds ?? []) {
        edges.push({
          type: "blocked_by",
          opIndex,
          from,
          to: { sessionId: blocker },
        });
      }
    } else if (op.op === "create_link" && !isCrossKindLink(op)) {
      const from = op.fromRef
        ? { ref: op.fromRef }
        : { sessionId: op.fromSessionId ?? "" };
      const to = op.toRef
        ? { ref: op.toRef }
        : { sessionId: op.toSessionId ?? "" };
      edges.push({ type: op.type, opIndex, from, to });
    }
  });
  return edges;
}

function edgeKey(end: PlanSessionEdge["from"]): string {
  return "ref" in end ? `ref:${end.ref}` : `id:${end.sessionId}`;
}

/**
 * Nodes of a directed cycle among IN-PLAN sessions, or null. Only in-plan
 * nodes can close a cycle: an existing session cannot point back at a session
 * this plan has not created yet.
 */
function findCycle(
  edges: Array<{ from: string; to: string }>
): string[] | null {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of out.get(node) ?? []) {
      const s = state.get(next);
      if (s === "visiting") return [...stack.slice(stack.indexOf(next)), next];
      if (!s) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of out.keys()) {
    if (!state.has(node)) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Every structural problem in a plan, at once. Empty for a batch with no plan
 * ops and valid refs — so it is safe to run on every composite.
 */
export function validatePlanOperations(
  operations: CompositeProposalOperation[],
  /**
   * Where the batch will be filed. Present on every door that knows it (the
   * submit / dry-run / revision preflight); absent only for a pure structural
   * check, which then skips the placement rules below.
   */
  placement?: { workspaceId: string | null }
): CapturePlanProblem[] {
  const problems: CapturePlanProblem[] = [];
  const kinds = planRefKinds(operations);
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

  // Ref uniqueness across EVERY ref-bearing op — one namespace, so a session
  // and an entity can never share a handle.
  const seen = new Set<string>();
  operations.forEach((op, index) => {
    const ref = (op as { ref?: unknown }).ref;
    if (typeof ref !== "string" || !ref) return;
    if (seen.has(ref))
      push(
        index,
        `duplicate ref "${ref}" — every ref must be unique across the whole plan`
      );
    seen.add(ref);
  });

  /** A ref must exist AND name the expected kind. */
  const expectRef = (
    opIndex: number,
    field: string,
    ref: string,
    expected: PlanRefKind
  ) => {
    const kind = kinds.get(ref);
    if (!kind) {
      push(opIndex, `${field} "${ref}" names no ${expected} in this plan`);
    } else if (kind !== expected) {
      push(
        opIndex,
        `${field} "${ref}" names a ${kind}, but must name a ${expected}`
      );
    }
  };
  const expectId = (opIndex: number, field: string, id: string) => {
    if (!isLikelyUUID(id)) push(opIndex, `${field} "${id}" is not a UUID`);
  };
  /**
   * A Rule Loop ref: an op ref in THIS batch naming `expected`, OR a real
   * UUID naming a row that already exists. Both are what
   * `resolveCompositeRef` accepts, so this mirrors it exactly — anything else
   * makes it THROW mid-materialize, where the op is logged and skipped after
   * its siblings have already landed.
   */
  const expectRefOrId = (
    opIndex: number,
    field: string,
    ref: string,
    expected: PlanRefKind
  ) => {
    const kind = kinds.get(ref);
    if (kind) {
      if (kind !== expected) {
        push(
          opIndex,
          `${field} "${ref}" names a ${kind}, but must name a ${expected}`
        );
      }
      return;
    }
    if (!isLikelyUUID(ref)) {
      push(
        opIndex,
        `${field} "${ref}" names no ${expected} in this batch and is not a ${expected} id`
      );
    }
  };
  const notBoth = (
    opIndex: number,
    refField: string,
    refValue: unknown,
    idField: string,
    idValue: unknown
  ) => {
    if (refValue && idValue) {
      push(opIndex, `send ${refField} OR ${idField}, never both`);
    }
  };

  /** A space named by `workspaceRef` (a space this batch creates) or `workspaceId`. */
  const expectSpace = (
    opIndex: number,
    op: { workspaceRef?: string; workspaceId?: string }
  ) => {
    notBoth(
      opIndex,
      "workspaceRef",
      op.workspaceRef,
      "workspaceId",
      op.workspaceId
    );
    if (op.workspaceRef)
      expectRef(opIndex, "workspaceRef", op.workspaceRef, "workspace");
    if (op.workspaceId) expectId(opIndex, "workspaceId", op.workspaceId);
  };
  // Existing steps this plan re-plans (`update_session`).
  const replannedSessionIds = new Set(
    operations.flatMap((op) =>
      op.op === "update_session" && typeof op.sessionId === "string"
        ? [op.sessionId]
        : []
    )
  );

  operations.forEach((op, i) => {
    switch (op.op) {
      case "create_entity":
        notBoth(i, "projectRef", op.projectRef, "projectId", op.projectId);
        if (op.projectRef) expectRef(i, "projectRef", op.projectRef, "project");
        return;
      case "create_relation":
        // A relation is entity DATA: an in-plan endpoint must be an entity,
        // never a session/project/document handle that would resolve to a
        // non-entity id.
        for (const [field, ref] of [
          ["sourceRef", op.sourceRef],
          ["targetRef", op.targetRef],
        ] as const) {
          const kind = kinds.get(ref);
          if (kind && kind !== "entity") {
            push(
              i,
              `relation ${field} "${ref}" names a ${kind} — relations connect entities only`
            );
          } else if (!kind && ref !== "$primary" && !isLikelyUUID(ref)) {
            push(
              i,
              `relation ${field} "${ref}" names no entity in this plan and is not an entity id`
            );
          }
        }
        return;
      case "create_session": {
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a session step needs a `ref`");
        if (typeof op.goal !== "string" || !op.goal.trim()) {
          push(i, "a session step needs a `goal`");
        } else if (op.goal.length > PLAN_SESSION_GOAL_MAX) {
          push(i, `goal must be at most ${PLAN_SESSION_GOAL_MAX} characters`);
        }
        const title = normalizeSessionTitle(op.title ?? null);
        if (title && title.length > SESSION_TITLE_MAX) {
          push(
            i,
            `title must be at most ${SESSION_TITLE_MAX} characters — ONE line naming the session; put the outcome in goal`
          );
        }
        notBoth(
          i,
          "parentRef",
          op.parentRef,
          "parentSessionId",
          op.parentSessionId
        );
        notBoth(
          i,
          "subjectRef",
          op.subjectRef,
          "subjectEntityId",
          op.subjectEntityId
        );
        notBoth(i, "projectRef", op.projectRef, "projectId", op.projectId);
        if (op.parentRef) {
          if (op.parentRef === op.ref)
            push(i, "a session cannot be its own parent");
          else expectRef(i, "parentRef", op.parentRef, "session");
        }
        if (op.parentSessionId)
          expectId(i, "parentSessionId", op.parentSessionId);
        for (const blocker of op.blockedByRefs ?? []) {
          if (blocker === op.ref)
            push(i, "a session cannot be blocked by itself");
          else expectRef(i, "blockedByRefs", blocker, "session");
        }
        for (const id of op.blockedBySessionIds ?? [])
          expectId(i, "blockedBySessionIds", id);
        // B5 / P4: the step's time and birth, as the session door checks them.
        for (const key of [STEP_PLANNED_FOR_KEY, STEP_DUE_BY_KEY] as const) {
          if (op[key] != null && !isStepDate(op[key]))
            push(i, stepDateRefusal(key));
        }
        if (op.startNow !== undefined && typeof op.startNow !== "boolean")
          push(i, "startNow must be true or false");
        if (op.subjectRef) expectRef(i, "subjectRef", op.subjectRef, "entity");
        if (op.subjectEntityId)
          expectId(i, "subjectEntityId", op.subjectEntityId);
        if (op.projectRef) expectRef(i, "projectRef", op.projectRef, "project");
        if (op.projectId) expectId(i, "projectId", op.projectId);
        notBoth(i, "trackRef", op.trackRef, "trackId", op.trackId);
        if (op.trackRef) expectRef(i, "trackRef", op.trackRef, "track");
        if (op.trackId) expectId(i, "trackId", op.trackId);
        if (
          op.expectedOutputs !== undefined &&
          !Array.isArray(op.expectedOutputs)
        ) {
          push(i, "expectedOutputs must be an array");
        }
        // Criteria are the session's definition of done, PROPOSED here for the
        // person to validate. Shape only at this layer — the create door runs
        // the real `sessionCriteriaSchema`, and duplicating that here would be
        // a second copy of one rule.
        if (op.criteria !== undefined && !Array.isArray(op.criteria)) {
          push(i, "criteria must be an array");
        }
        return;
      }
      case "create_document":
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a document step needs a `ref`");
        if (typeof op.title !== "string" || !op.title.trim())
          push(i, "a document step needs a `title`");
        if (typeof op.content !== "string")
          push(i, "a document step needs `content` (markdown)");
        notBoth(i, "entityRef", op.entityRef, "entityId", op.entityId);
        notBoth(i, "sessionRef", op.sessionRef, "sessionId", op.sessionId);
        if (op.entityRef) expectRef(i, "entityRef", op.entityRef, "entity");
        if (op.entityId) expectId(i, "entityId", op.entityId);
        if (op.sessionRef) expectRef(i, "sessionRef", op.sessionRef, "session");
        if (op.sessionId) expectId(i, "sessionId", op.sessionId);
        return;
      case "create_project":
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a project step needs a `ref`");
        if (typeof op.name !== "string" || !op.name.trim()) {
          push(i, "a project step needs a `name`");
        } else if (op.name.length > PLAN_PROJECT_NAME_MAX) {
          push(
            i,
            `project name must be at most ${PLAN_PROJECT_NAME_MAX} characters`
          );
        }
        notBoth(
          i,
          "subjectRef",
          op.subjectRef,
          "subjectEntityId",
          op.subjectEntityId
        );
        if (op.subjectRef) expectRef(i, "subjectRef", op.subjectRef, "entity");
        if (op.subjectEntityId)
          expectId(i, "subjectEntityId", op.subjectEntityId);
        for (const ref of op.evidenceRefs ?? [])
          expectRef(i, "evidenceRefs", ref, "entity");
        for (const id of op.evidenceEntityIds ?? [])
          expectId(i, "evidenceEntityIds", id);
        return;
      case "create_track": {
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a goal step needs a `ref`");
        if (typeof op.name !== "string" || !op.name.trim())
          push(i, "a goal step needs a `name`");
        notBoth(i, "projectRef", op.projectRef, "projectId", op.projectId);
        if (!op.projectRef && !op.projectId)
          push(
            i,
            "a goal lives in a project: give it `projectRef` (a project step) or `projectId`"
          );
        if (op.projectRef) expectRef(i, "projectRef", op.projectRef, "project");
        if (op.projectId) expectId(i, "projectId", op.projectId);
        notBoth(i, "parentRef", op.parentRef, "parentGoalId", op.parentGoalId);
        if (op.parentRef) {
          if (op.parentRef === op.ref) push(i, "a goal cannot serve itself");
          else expectRef(i, "parentRef", op.parentRef, "track");
        }
        if (op.parentGoalId) expectId(i, "parentGoalId", op.parentGoalId);
        for (const blocker of op.blockedByRefs ?? []) {
          if (blocker === op.ref) push(i, "a goal cannot wait on itself");
          else expectRef(i, "blockedByRefs", blocker, "track");
        }
        for (const id of op.blockedByTrackIds ?? [])
          expectId(i, "blockedByTrackIds", id);
        if (op.criteria !== undefined && !Array.isArray(op.criteria))
          push(i, "criteria must be an array");
        if (
          op.kpi !== undefined &&
          (op.kpi === null ||
            typeof op.kpi !== "object" ||
            Array.isArray(op.kpi))
        )
          push(i, "kpi must be an object ({ label, target, unit? })");
        return;
      }
      case "update_session": {
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a step update needs a `ref`");
        expectId(i, "sessionId", op.sessionId);
        const patch = op.patch as Record<string, unknown> | null | undefined;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
          push(i, "a step update needs a `patch` object");
          return;
        }
        const allowed = ["title", "goal", "status"];
        const keys = Object.keys(patch);
        if (keys.length === 0)
          push(i, "a step update needs at least one of title, goal, status");
        for (const key of keys) {
          if (!allowed.includes(key))
            push(
              i,
              `a step update changes title, goal or status only — not "${key}" (blockers: create_link / remove_link)`
            );
        }
        if (
          patch.goal !== undefined &&
          (typeof patch.goal !== "string" ||
            !patch.goal.trim() ||
            patch.goal.length > PLAN_SESSION_GOAL_MAX)
        ) {
          push(
            i,
            `goal must be a non-empty string of at most ${PLAN_SESSION_GOAL_MAX} characters`
          );
        }
        if (patch.title !== undefined && patch.title !== null) {
          const title = normalizeSessionTitle(
            typeof patch.title === "string" ? patch.title : null
          );
          if (typeof patch.title !== "string")
            push(i, "title must be a string (or null to clear it)");
          else if (title && title.length > SESSION_TITLE_MAX)
            push(i, `title must be at most ${SESSION_TITLE_MAX} characters`);
        }
        if (
          patch.status !== undefined &&
          patch.status !== "active" &&
          patch.status !== "paused"
        ) {
          push(i, 'a step update moves status to "active" or "paused" only');
        }
        return;
      }
      case "remove_link": {
        if (op.type !== "blocked_by")
          push(i, "a plan removes blocked_by edges only");
        expectId(i, "fromSessionId", op.fromSessionId);
        const targets = [
          ["toSessionId", op.toSessionId],
          ["toEntityId", op.toEntityId],
          ["toTrackId", op.toTrackId],
        ] as const;
        const given = targets.filter(([, value]) => !!value);
        if (given.length !== 1)
          push(
            i,
            "a removed link names exactly one of toSessionId, toEntityId, toTrackId"
          );
        for (const [field, value] of given) expectId(i, field, value as string);
        return;
      }
      case "create_link": {
        if (!(PLAN_LINK_TYPES as readonly string[]).includes(op.type)) {
          push(
            i,
            `link type "${String(op.type)}" is not a plan edge — use one of ${PLAN_LINK_TYPES.join(", ")}`
          );
        }
        if (!op.fromRef && !op.fromSessionId)
          push(i, "a link needs fromRef or fromSessionId");
        notBoth(i, "fromRef", op.fromRef, "fromSessionId", op.fromSessionId);
        if (op.fromRef) expectRef(i, "fromRef", op.fromRef, "session");
        if (op.fromSessionId) expectId(i, "fromSessionId", op.fromSessionId);
        // Exactly ONE target: a session, a decision (entity) or a goal.
        const targets = [
          ["toRef", op.toRef, "session", true],
          ["toSessionId", op.toSessionId, "session", false],
          ["toEntityRef", op.toEntityRef, "entity", true],
          ["toEntityId", op.toEntityId, "entity", false],
          ["toTrackRef", op.toTrackRef, "track", true],
          ["toTrackId", op.toTrackId, "track", false],
        ] as const;
        const given = targets.filter(([, value]) => !!value);
        if (given.length !== 1) {
          push(
            i,
            "a link needs exactly one target: toRef / toSessionId (a session), toEntityRef / toEntityId (a decision), or toTrackRef / toTrackId (a goal)"
          );
        }
        for (const [field, value, kind, isRef] of given) {
          if (isRef) expectRef(i, field, value as string, kind);
          else expectId(i, field, value as string);
        }
        if (isCrossKindLink(op) && op.type !== "blocked_by") {
          push(
            i,
            "only a blocked_by link may point at a decision or a goal (a session's parent is a session)"
          );
        }
        // An ARM: an option names one of a DECISION's options.
        if (op.option !== undefined) {
          const decisionRef = op.toEntityRef;
          if (typeof op.option !== "string" || !op.option.trim()) {
            push(i, "option must be a non-empty string");
          } else if (!op.toEntityRef && !op.toEntityId) {
            push(
              i,
              "only a wait on a decision (toEntityRef / toEntityId) can name an option"
            );
          } else if (decisionRef) {
            // A decision this plan creates: its options are in the plan, so the
            // refusal is raised now (the door judges an existing one at apply).
            const made = operations.find(
              (o) => o.op === "create_entity" && o.ref === decisionRef
            );
            if (made && made.op === "create_entity") {
              const keys = decisionRecordView(made.properties).options.map(
                (o) => o.key
              );
              if (!keys.includes(op.option)) {
                push(
                  i,
                  keys.length === 0
                    ? `decision "${decisionRef}" lists no options (decisionOptions): give it its options, then name one`
                    : `"${op.option}" is not an option of decision "${decisionRef}". Its options: ${keys.map((k) => `"${k}"`).join(", ")}`
                );
              }
            }
          }
        }
        // The CHILD of a `spawned_from` edge must be a session this plan
        // creates: the spawn producer floors the parent only, because its
        // child is always the session just created — re-parenting an existing
        // session is not a plan step.
        if (op.type === "spawned_from" && !op.fromRef) {
          push(
            i,
            "a spawned_from link's `from` (the child) must be a session this plan creates — use fromRef"
          );
        }
        // An edge between two EXISTING things is not part of building a plan
        // — that is `POST /links`, governed on its own — UNLESS the plan
        // re-plans that existing step (`update_session` on it): a step's
        // blockers change with it.
        if (
          op.fromSessionId &&
          !op.fromRef &&
          !op.toRef &&
          !op.toEntityRef &&
          !op.toTrackRef &&
          !replannedSessionIds.has(op.fromSessionId)
        ) {
          push(
            i,
            "a plan link must touch a step this plan creates — or re-plan that step (`update_session` on it) — otherwise link two existing things through the links door"
          );
        }
        if (
          (op.fromRef && op.fromRef === op.toRef) ||
          (op.fromSessionId && op.fromSessionId === op.toSessionId)
        ) {
          push(i, "a link cannot connect a session to itself");
        }
        return;
      }
      // ── Rule Loop config steps (NS1) ─────────────────────────────────
      // Checked HERE, before anything is queued, because the materializer's
      // per-op resilience is the wrong place for a ref error: a `factRef`
      // that resolves to nothing makes `resolveCompositeRef` THROW inside
      // pass 3, which is caught, logged and SKIPPED — leaving the skill and
      // the automation created and the rule that was meant to join them
      // silently absent, reported as success.
      case "create_skill":
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a skill step needs a `ref`");
        if (typeof op.name !== "string" || !op.name.trim())
          push(i, "a skill step needs a `name`");
        if (typeof op.body !== "string" || !op.body.trim())
          push(i, "a skill step needs a `body` (the instruction, markdown)");
        // The slug's SHAPE, for every producer. Whether one is REQUIRED is the
        // caller-facing doors' contract (`captureSkillStepProblems`).
        if (op.slug !== undefined && op.slug !== null) {
          const slugProblem =
            typeof op.slug === "string"
              ? skillSlugProblem(op.slug.trim())
              : "a skill step's `slug` must be a string";
          if (slugProblem) push(i, slugProblem);
        }
        if (!(SKILL_SCOPES as readonly string[]).includes(op.scope)) {
          push(
            i,
            `skill scope "${String(op.scope)}" is not valid — use one of ${SKILL_SCOPES.join(", ")}`
          );
        }
        if (
          op.agentTypes !== undefined &&
          op.agentTypes !== null &&
          !Array.isArray(op.agentTypes)
        ) {
          push(i, "agentTypes must be an array (or null for every agent type)");
        }
        return;
      case "create_automation": {
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "an automation step needs a `ref`");
        if (typeof op.name !== "string" || !op.name.trim())
          push(i, "an automation step needs a `name`");
        if (
          !(AUTOMATION_TRIGGER_TYPES as readonly string[]).includes(
            op.triggerType
          )
        ) {
          push(
            i,
            `automation triggerType "${String(op.triggerType)}" is not valid — use one of ${AUTOMATION_TRIGGER_TYPES.join(", ")}`
          );
        }
        // SHAPE ONLY. The flow's SEMANTICS (node contracts, unknown verbs,
        // dangling edges, cycles) belong to the one flow validator, which runs
        // against the live catalog inside the automation door — and must run
        // THERE, not here, so a node naming a skill this same batch creates
        // resolves against the row pass 0a just wrote.
        const flow = op.flowDefinition as
          { nodes?: unknown; edges?: unknown } | null | undefined;
        if (!flow || typeof flow !== "object" || Array.isArray(flow)) {
          push(
            i,
            "an automation step needs a `flowDefinition` object with `nodes` and `edges`"
          );
        } else {
          if (!Array.isArray(flow.nodes))
            push(i, "flowDefinition.nodes must be an array");
          if (!Array.isArray(flow.edges))
            push(i, "flowDefinition.edges must be an array");
          // An EVENT rule matches on `triggerConfig.eventPattern`, which the
          // automation door reads off the flow (the op has no field of its
          // own). Without it the automation lands, but can never fire — a
          // rule that silently does nothing. Refused here, by name.
          if (op.triggerType === "event") {
            const triggerConfig = (flow as { triggerConfig?: unknown })
              .triggerConfig as { eventPattern?: unknown } | null | undefined;
            if (
              !triggerConfig ||
              typeof triggerConfig !== "object" ||
              Array.isArray(triggerConfig) ||
              typeof triggerConfig.eventPattern !== "string" ||
              !triggerConfig.eventPattern.trim()
            ) {
              push(
                i,
                'an event automation needs `flowDefinition.triggerConfig.eventPattern` (e.g. "entity.create.completed") — without it the rule can never fire'
              );
            }
          }
        }
        expectSpace(i, op);
        return;
      }
      case "create_rule":
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a rule step needs a `ref`");
        if (typeof op.intent !== "string" || !op.intent.trim())
          push(
            i,
            "a rule step needs an `intent` (the rule in the user's words)"
          );
        if (
          !op.scope ||
          typeof op.scope !== "object" ||
          !(RULE_SCOPE_KINDS as readonly string[]).includes(op.scope.kind)
        ) {
          push(
            i,
            `rule scope.kind "${String(op.scope?.kind)}" is not valid — use one of ${RULE_SCOPE_KINDS.join(", ")}`
          );
        }
        if (op.scope?.workspaceId)
          expectId(i, "scope.workspaceId", op.scope.workspaceId);
        if (op.factRef) expectRefOrId(i, "factRef", op.factRef, "skill");
        for (const behaviourRef of op.behaviourRefs ?? [])
          expectRefOrId(i, "behaviourRefs", behaviourRef, "automation");
        if (!op.factRef && (op.behaviourRefs?.length ?? 0) === 0) {
          push(
            i,
            "a rule needs a `factRef` (what the agent should KNOW) and/or `behaviourRefs` (what RUNS) — a rule joined to nothing remembers nothing"
          );
        }
        return;
      // ── Process draft (capture → process) ─────────────────────────────
      // Shape only: the kind's existence and the playbook's full contract
      // are the playbook door's to judge at apply time (`playbooks.create`
      // refuses a dangling subjectProfile slug).
      case "create_playbook":
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a process draft needs a `ref`");
        if (typeof op.name !== "string" || !op.name.trim())
          push(i, "a process draft needs a `name`");
        if (typeof op.goalTemplate !== "string" || !op.goalTemplate.trim())
          push(
            i,
            "a process draft needs a `goalTemplate` (one line is enough)"
          );
        if (op.subjectProfileRef) {
          expectRef(i, "subjectProfileRef", op.subjectProfileRef, "kind");
        } else if (
          !op.subjectProfile ||
          typeof op.subjectProfile !== "object" ||
          typeof op.subjectProfile.profileSlug !== "string" ||
          !op.subjectProfile.profileSlug.trim()
        ) {
          push(
            i,
            "a process needs `subjectProfile.profileSlug`, or `subjectProfileRef` naming a kind this plan defines — the kind it runs on"
          );
        }
        if (
          op.status !== undefined &&
          op.status !== "draft" &&
          op.status !== "active"
        ) {
          push(i, 'a process\'s `status` is "draft" or "active"');
        }
        expectSpace(i, op);
        // A process lives in a space: the playbook door refuses a pod-wide
        // one at apply time, after the things beside it have landed. Refused
        // HERE instead, so the bundle is never filed with a step that cannot
        // apply.
        if (
          placement &&
          !placement.workspaceId &&
          !op.workspaceRef &&
          !op.workspaceId
        ) {
          push(
            i,
            "a process draft needs a space — file this bundle into a space (workspaceId), name one (workspaceRef), or drop the process step"
          );
        }
        return;
      // ── List (import Build) ───────────────────────────────────────────
      // Shape and refs only: the kinds' existence and the view config are
      // the views door's to judge at apply time.
      case "create_view":
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a list step needs a `ref`");
        if (typeof op.name !== "string" || !op.name.trim())
          push(i, "a list step needs a `name`");
        if (
          !(COMPOSITE_VIEW_TYPES as readonly string[]).includes(op.viewType)
        ) {
          push(
            i,
            `list viewType "${String(op.viewType)}" is not valid — use one of ${COMPOSITE_VIEW_TYPES.join(", ")}`
          );
        }
        expectSpace(i, op);
        if (
          op.scopeProfileSlugs !== undefined &&
          (!Array.isArray(op.scopeProfileSlugs) ||
            op.scopeProfileSlugs.some(
              (slug) => typeof slug !== "string" || !slug.trim()
            ))
        ) {
          push(i, "scopeProfileSlugs must be an array of kind slugs");
        }
        if (op.entityRefs !== undefined && !Array.isArray(op.entityRefs)) {
          push(i, "entityRefs must be an array of entity refs or ids");
        }
        for (const ref of Array.isArray(op.entityRefs) ? op.entityRefs : [])
          expectRefOrId(i, "entityRefs", ref, "entity");
        if (op.containerRef)
          expectRefOrId(i, "containerRef", op.containerRef, "entity");
        // A list must know WHAT it lists: its kinds, or its members (whose
        // kinds the materializer reads).
        if (
          (op.scopeProfileSlugs?.length ?? 0) === 0 &&
          (Array.isArray(op.entityRefs) ? op.entityRefs.length : 0) === 0
        ) {
          push(
            i,
            "a list needs `scopeProfileSlugs` (the kinds it shows) or `entityRefs` (the things it holds)"
          );
        }
        if (
          op.config !== undefined &&
          (op.config === null ||
            typeof op.config !== "object" ||
            Array.isArray(op.config))
        ) {
          push(i, "config must be an object");
        }
        // A playbook's UI views carry their own config: the views door judges
        // its content at apply time, the shape is refused here.
        if (
          op.viewType === "pipeline" &&
          typeof op.config?.profileSlug !== "string"
        ) {
          push(
            i,
            "a pipeline needs `config.profileSlug` — the kind whose declared lifecycle its columns are"
          );
        }
        if (op.viewType === "bento" && !Array.isArray(op.config?.blocks)) {
          push(i, "a bento needs `config.blocks` — the widgets it places");
        }
        return;
      // ── A playbook's UI (cell + where it shows) ───────────────────────
      // Shape and refs only: the source's mount and sandbox checks are the
      // cell door's (`defineCell`), run again at apply time.
      case "create_cell":
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a cell step needs a `ref`");
        if (typeof op.name !== "string" || !op.name.trim())
          push(i, "a cell step needs a `name`");
        if (typeof op.rendererSource !== "string" || !op.rendererSource.trim())
          push(i, "a cell step needs its `rendererSource`");
        expectSpace(i, op);
        return;
      case "bind_renderer": {
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a binding step needs a `ref`");
        const target = op.target as
          { kind?: unknown; id?: unknown; ref?: unknown } | null | undefined;
        if (
          !target ||
          !(BIND_RENDERER_TARGET_KINDS as readonly unknown[]).includes(
            target.kind
          )
        ) {
          push(
            i,
            `a binding's target.kind must be one of ${BIND_RENDERER_TARGET_KINDS.join(", ")} — one object's own page`
          );
        } else if (
          (typeof target.id === "string") ===
          (typeof target.ref === "string")
        ) {
          push(
            i,
            "a binding's target names its object once: `id` (an existing one) OR `ref` (a step of this plan)"
          );
        } else if (typeof target.ref === "string") {
          expectRef(
            i,
            "target.ref",
            target.ref,
            target.kind as "playbook" | "view"
          );
        } else {
          expectId(i, "target.id", target.id as string);
        }
        if (op.slot !== "detail")
          push(i, 'one object\'s page has one slot: `slot: "detail"`');
        if (op.scope !== "pod" && op.scope !== "workspace")
          push(i, 'a binding\'s scope is "pod" or "workspace"');
        if (op.scope === "workspace" && !op.workspaceId && !op.workspaceRef)
          push(
            i,
            "a workspace binding needs its `workspaceId` or `workspaceRef`"
          );
        expectSpace(i, op);
        if (!op.cellRef === !op.cellKey) {
          push(
            i,
            "a binding names its cell once: `cellRef` (a cell step in this bundle) OR `cellKey` (an existing cell)"
          );
        }
        if (op.cellRef) expectRef(i, "cellRef", op.cellRef, "cell");
        return;
      }
      // ── A domain: its space, kinds and lifecycles ─────────────────────
      // Shape and refs only: the one-space-per-domain rule, the kind's slug
      // and fields and the lifecycle's options are their doors' to judge at
      // apply time.
      case "create_workspace":
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a space step needs a `ref`");
        if (typeof op.name !== "string" || !op.name.trim())
          push(i, "a space step needs a `name`");
        return;
      case "define_kind":
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a kind step needs a `ref`");
        if (typeof op.slug !== "string" || !op.slug.trim())
          push(i, "a kind step needs a `slug`");
        if (typeof op.displayName !== "string" || !op.displayName.trim())
          push(i, "a kind step needs a `displayName`");
        if (
          op.entityScope !== undefined &&
          op.entityScope !== "pod" &&
          op.entityScope !== "workspace"
        ) {
          push(i, 'a kind\'s `entityScope` is "pod" or "workspace"');
        }
        if (
          op.fields !== undefined &&
          (!Array.isArray(op.fields) ||
            op.fields.some(
              (f) => !f || typeof f !== "object" || Array.isArray(f)
            ))
        ) {
          push(i, "a kind's `fields` must be an array of field objects");
        }
        expectSpace(i, op);
        return;
      case "declare_lifecycle":
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "a lifecycle step needs a `ref`");
        if (!op.kindRef === !op.profileId) {
          push(
            i,
            "a lifecycle names its kind once: `kindRef` (a kind this plan defines) OR `profileId` (an existing kind)"
          );
        }
        if (op.kindRef) expectRef(i, "kindRef", op.kindRef, "kind");
        if (op.profileId) expectId(i, "profileId", op.profileId);
        if (!Array.isArray(op.options) || op.options.length === 0)
          push(
            i,
            "a lifecycle step needs its `options` (each { key, category })"
          );
        return;
      // ── Updates (Library rebuild) ─────────────────────────────────────
      // Shape only: the row's existence, ownership and the field contracts
      // are the update door's to judge at apply time.
      case "update_skill":
      case "update_automation":
      case "update_rule":
      case "update_playbook":
      case "update_view":
      case "update_entity": {
        if (typeof op.ref !== "string" || !op.ref)
          push(i, "an update step needs a `ref`");
        expectId(i, "target id", updateOperationTargetId(op));
        const patch = op.patch as Record<string, unknown> | null | undefined;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
          push(i, "an update step needs a `patch` object");
          return;
        }
        if (op.op === "update_rule") {
          if (typeof op.patch.intent !== "string" || !op.patch.intent.trim())
            push(i, "a rule update needs `patch.intent` (the rule in words)");
          return;
        }
        if (op.op === "update_entity") {
          // An empty entity patch is allowed: it registers the ref (a reused
          // container) so relations in this batch can target it.
          if (
            patch.properties !== undefined &&
            (patch.properties === null ||
              typeof patch.properties !== "object" ||
              Array.isArray(patch.properties))
          ) {
            push(i, "patch.properties must be an object");
          }
          return;
        }
        if (
          "name" in patch &&
          (typeof patch.name !== "string" || !patch.name.trim())
        ) {
          push(i, "patch.name must be a non-empty string");
        }
        if (
          op.op === "update_view" &&
          patch.config !== undefined &&
          (patch.config === null ||
            typeof patch.config !== "object" ||
            Array.isArray(patch.config))
        ) {
          push(i, "patch.config must be an object");
        }
        if (Object.keys(patch).length === 0)
          push(i, "an update step needs at least one field in `patch`");
        return;
      }
      default:
        return;
    }
  });

  // ONE body per entity (ticket 9fd9c3d5): a document step's `entityRef` /
  // `entityId` makes it the entity's BODY, and an entity's long `content`
  // becomes its body too. Two bodies for one entity failed at approval
  // (`body-replace-guard`) and rolled the whole plan back; refused here,
  // before anything is filed, naming which one to keep.
  const bodyFrom = new Map<string, string>();
  operations.forEach((op) => {
    const ref = (op as { ref?: unknown }).ref;
    if (
      op.op === "create_entity" &&
      typeof ref === "string" &&
      !op.existingEntityId &&
      typeof op.content === "string" &&
      shouldMaterializeAsDocument(op.content)
    ) {
      bodyFrom.set(`ref:${ref}`, "its long `content`");
    }
  });
  operations.forEach((op, i) => {
    if (op.op !== "create_document") return;
    const target = op.entityRef
      ? `ref:${op.entityRef}`
      : op.entityId
        ? `id:${op.entityId}`
        : null;
    if (!target) return;
    const name = op.entityRef ?? op.entityId;
    const first = bodyFrom.get(target);
    if (first) {
      push(
        i,
        `entity ${name} already gets its body from ${first}; an entity has ONE body. Keep one: drop the entity's \`content\` (this document becomes its body), or file this document on a session (\`sessionRef\`/\`sessionId\`) instead of \`entityRef\`/\`entityId\`.`
      );
      return;
    }
    bodyFrom.set(target, `document "${op.ref}"`);
  });

  // One parent per session: a `parentRef` and a `spawned_from` link from the
  // same session is two parents.
  const edges = planSessionEdges(operations);
  const parentCount = new Map<string, number[]>();
  for (const e of edges) {
    if (e.type !== "spawned_from") continue;
    const key = edgeKey(e.from);
    parentCount.set(key, [...(parentCount.get(key) ?? []), e.opIndex]);
  }
  for (const [key, opIndexes] of parentCount) {
    if (opIndexes.length > 1) {
      push(
        opIndexes[opIndexes.length - 1],
        `session ${key.replace(/^ref:/, "")} is given ${opIndexes.length} parents — a session has one parent`
      );
    }
  }

  // Cycles among IN-PLAN sessions, per edge type.
  for (const type of PLAN_LINK_TYPES) {
    const inPlan = edges
      .filter((e) => e.type === type && "ref" in e.from && "ref" in e.to)
      .map((e) => ({
        from: (e.from as { ref: string }).ref,
        to: (e.to as { ref: string }).ref,
      }));
    const cycle = findCycle(inPlan);
    if (cycle) {
      const firstOp = edges.find(
        (e) => e.type === type && "ref" in e.from && e.from.ref === cycle[0]
      );
      push(
        firstOp?.opIndex ?? 0,
        `${type} cycle: ${cycle.join(" → ")} — ${type === "blocked_by" ? "sessions that wait on each other can never start" : "a session cannot descend from itself"}`
      );
    }
  }

  // Goals: no cycle among in-plan goals, per edge (serves / waits on).
  for (const [label, edgesOf] of [
    [
      "serves",
      (op: Extract<CompositeProposalOperation, { op: "create_track" }>) =>
        op.parentRef ? [op.parentRef] : [],
    ],
    [
      "blocked_by",
      (op: Extract<CompositeProposalOperation, { op: "create_track" }>) =>
        op.blockedByRefs ?? [],
    ],
  ] as const) {
    const goalEdges = operations.flatMap((op) =>
      op.op === "create_track"
        ? edgesOf(op).map((to) => ({ from: op.ref, to }))
        : []
    );
    const cycle = findCycle(goalEdges);
    if (cycle) {
      const at = operations.findIndex(
        (op) => op.op === "create_track" && op.ref === cycle[0]
      );
      push(Math.max(at, 0), `goal ${label} cycle: ${cycle.join(" → ")}`);
    }
  }

  return problems;
}

/**
 * `create_track` op indexes, parents before children (in-plan `parentRef`),
 * so a goal's parent exists when the start door places it. Assumes
 * `validatePlanOperations` passed (no cycle).
 */
export function trackOpsRootFirst(
  operations: CompositeProposalOperation[]
): number[] {
  const indexByRef = new Map<string, number>();
  operations.forEach((op, i) => {
    if (op.op === "create_track") indexByRef.set(op.ref, i);
  });
  const ordered: number[] = [];
  const placed = new Set<number>();
  const place = (index: number, depth: number) => {
    if (placed.has(index) || depth > operations.length) return;
    const op = operations[index];
    if (op.op !== "create_track") return;
    const parent = op.parentRef ? indexByRef.get(op.parentRef) : undefined;
    if (parent !== undefined) place(parent, depth + 1);
    if (!placed.has(index)) {
      placed.add(index);
      ordered.push(index);
    }
  };
  for (const index of indexByRef.values()) place(index, 0);
  return ordered;
}

/**
 * `create_session` op indexes, parents before children (in-plan parents
 * only). Assumes `validatePlanOperations` passed — a cycle would never
 * terminate, so the fallback appends whatever is left in declaration order.
 */
export function sessionOpsRootFirst(
  operations: CompositeProposalOperation[]
): number[] {
  const sessionIndexByRef = new Map<string, number>();
  operations.forEach((op, i) => {
    if (op.op === "create_session") sessionIndexByRef.set(op.ref, i);
  });
  const ordered: number[] = [];
  const placed = new Set<number>();
  const place = (index: number, depth: number) => {
    if (placed.has(index) || depth > operations.length) return;
    const op = operations[index];
    if (op.op !== "create_session") return;
    const parentIndex = op.parentRef
      ? sessionIndexByRef.get(op.parentRef)
      : undefined;
    if (parentIndex !== undefined) place(parentIndex, depth + 1);
    if (!placed.has(index)) {
      placed.add(index);
      ordered.push(index);
    }
  };
  for (const index of sessionIndexByRef.values()) place(index, 0);
  return ordered;
}

/** A reviewer/agent-facing line for one plan step. */
export interface PlanStepSummary {
  ref: string | null;
  opIndex: number;
  kind:
    | "entity"
    | "relation"
    | "session"
    | "document"
    | "project"
    | "link"
    | "skill"
    | "automation"
    | "rule"
    | "playbook"
    | "view"
    | "cell"
    | "binding"
    | "workspace"
    | "track"
    | "kind"
    | "lifecycle";
  label: string;
  /** Set on a step that CHANGES an existing row (a Library rebuild). */
  update?: { targetId: string };
  /** A skill step's slug — the ref `synap_load_skill` resolves. */
  slug?: string;
}

/** Self-describing step list — what a plan receipt and the review UI name. */
export function planStepSummaries(
  operations: CompositeProposalOperation[]
): PlanStepSummary[] {
  return operations.map((op, opIndex): PlanStepSummary => {
    const ref = (op as { ref?: unknown }).ref;
    const base = { ref: typeof ref === "string" && ref ? ref : null, opIndex };
    switch (op.op) {
      case "create_entity":
        return { ...base, kind: "entity", label: op.title || op.profileSlug };
      case "create_relation":
        return {
          ...base,
          kind: "relation",
          label: `${op.sourceRef} --${op.type}--> ${op.targetRef}`,
        };
      case "create_session":
        return {
          ...base,
          kind: "session",
          label: normalizeSessionTitle(op.title ?? null) ?? op.goal,
        };
      case "create_document":
        return { ...base, kind: "document", label: op.title };
      case "create_project":
        return { ...base, kind: "project", label: op.name };
      case "create_track":
        return { ...base, kind: "track", label: op.name };
      case "update_session":
        return {
          ...base,
          kind: "session",
          label:
            (typeof op.patch?.title === "string" && op.patch.title) ||
            (typeof op.patch?.goal === "string" && op.patch.goal) ||
            base.ref ||
            "session",
          update: { targetId: op.sessionId },
        };
      case "remove_link":
        return {
          ...base,
          kind: "link",
          label: `${op.fromSessionId} -/-${op.type}-/-> ${op.toSessionId ?? op.toEntityId ?? op.toTrackId}`,
        };
      case "create_link":
        return {
          ...base,
          kind: "link",
          label: `${op.fromRef ?? op.fromSessionId} --${op.type}--> ${op.toRef ?? op.toSessionId ?? op.toEntityRef ?? op.toEntityId ?? op.toTrackRef ?? op.toTrackId}`,
        };
      case "create_skill":
        return {
          ...base,
          kind: "skill",
          label: op.name,
          ...(op.slug?.trim() ? { slug: op.slug.trim() } : {}),
        };
      case "create_automation":
        return { ...base, kind: "automation", label: op.name };
      case "create_rule":
        return { ...base, kind: "rule", label: op.intent };
      case "create_playbook":
        return { ...base, kind: "playbook", label: op.name };
      case "create_view":
        return { ...base, kind: "view", label: op.name };
      case "create_cell":
        return { ...base, kind: "cell", label: op.name };
      case "bind_renderer":
        return {
          ...base,
          kind: "binding",
          label: `${op.cellRef ?? op.cellKey} on ${op.target.kind} ${op.target.ref ?? op.target.id}`,
        };
      case "create_workspace":
        return { ...base, kind: "workspace", label: op.name };
      case "define_kind":
        return { ...base, kind: "kind", label: op.displayName || op.slug };
      case "declare_lifecycle":
        return {
          ...base,
          kind: "lifecycle",
          label: `${op.kindRef ?? op.profileId} ${op.property ?? "status"}`,
        };
      case "update_skill":
      case "update_automation":
      case "update_rule":
      case "update_playbook":
      case "update_view":
      case "update_entity": {
        const kind = UPDATE_STEP_KIND[op.op];
        const patch = op.patch as Record<string, unknown>;
        const named =
          (typeof patch.name === "string" && patch.name) ||
          (typeof patch.title === "string" && patch.title) ||
          (typeof patch.intent === "string" && patch.intent) ||
          base.ref ||
          kind;
        return {
          ...base,
          kind,
          label: named,
          update: { targetId: updateOperationTargetId(op) },
        };
      }
    }
  });
}

const UPDATE_STEP_KIND = {
  update_skill: "skill",
  update_automation: "automation",
  update_rule: "rule",
  update_playbook: "playbook",
  update_view: "view",
  update_entity: "entity",
} as const satisfies Record<
  (typeof UPDATE_OPERATION_KINDS)[number],
  PlanStepSummary["kind"]
>;

/**
 * The `skills[]` contract of the CALLER-FACING capture doors (MCP
 * `synap_capture`, Hub REST `POST /capture/graph`): the authoring rule
 * `synap_create_skill` applies, so a teaching skill without a `slug` is refused
 * before anything is filed. It used to be created unreachable — nothing could
 * load it — and reported `applied` (feedback d23a3888).
 *
 * Not in `validatePlanOperations`: the Library Build (`imports/build.ts`) files
 * its "tool" skill step with no slug and would be refused there. That is the
 * same unreachable-skill defect, left as a named follow-up.
 */
export function captureSkillStepProblems(skills: readonly unknown[]): string[] {
  return skills.flatMap((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const step = item as { name?: unknown; body?: unknown; slug?: unknown };
    const problem = skillAuthoringProblem({
      body: typeof step.body === "string" ? step.body : null,
      slug: typeof step.slug === "string" ? step.slug : null,
    });
    if (!problem) return [];
    const named = typeof step.name === "string" ? ` "${step.name}"` : "";
    return [`skills[${i}]${named}: ${problem}`];
  });
}
