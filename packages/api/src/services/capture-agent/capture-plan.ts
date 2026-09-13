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
  isLikelyUUID,
  PLAN_LINK_TYPES,
  type CompositeProposalOperation,
  type PlanLinkType,
} from "@synap-core/types/proposals";
import {
  normalizeSessionTitle,
  SESSION_TITLE_MAX,
} from "@synap-core/types/focus-sessions";

/** The session door's goal bound (`rest/focus-sessions.ts` `goal.max(2000)`). */
export const PLAN_SESSION_GOAL_MAX = 2000;
/** The project door's name bound (`projects.create` `name.max(255)`). */
export const PLAN_PROJECT_NAME_MAX = 255;

export type PlanRefKind =
  | "entity"
  | "session"
  | "document"
  | "project"
  | "skill"
  | "automation"
  | "rule";

export interface CapturePlanProblem {
  /** Index in `operations[]`. */
  opIndex: number;
  /** The op's own ref, when it has one. */
  ref?: string;
  op: CompositeProposalOperation["op"];
  message: string;
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
    } else if (op.op === "create_link") {
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
  operations: CompositeProposalOperation[]
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
        if (op.subjectRef) expectRef(i, "subjectRef", op.subjectRef, "entity");
        if (op.subjectEntityId)
          expectId(i, "subjectEntityId", op.subjectEntityId);
        if (op.projectRef) expectRef(i, "projectRef", op.projectRef, "project");
        if (op.projectId) expectId(i, "projectId", op.projectId);
        if (
          op.expectedOutputs !== undefined &&
          !Array.isArray(op.expectedOutputs)
        ) {
          push(i, "expectedOutputs must be an array");
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
      case "create_link": {
        if (!(PLAN_LINK_TYPES as readonly string[]).includes(op.type)) {
          push(
            i,
            `link type "${String(op.type)}" is not a plan edge — use one of ${PLAN_LINK_TYPES.join(", ")}`
          );
        }
        for (const [side, ref, id] of [
          ["from", op.fromRef, op.fromSessionId],
          ["to", op.toRef, op.toSessionId],
        ] as const) {
          if (!ref && !id)
            push(i, `a link needs ${side}Ref or ${side}SessionId`);
          notBoth(i, `${side}Ref`, ref, `${side}SessionId`, id);
          if (ref) expectRef(i, `${side}Ref`, ref, "session");
          if (id) expectId(i, `${side}SessionId`, id);
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
        // An edge between two EXISTING sessions is not part of building a
        // plan — that is `POST /links`, governed on its own.
        if (!op.fromRef && !op.toRef && op.fromSessionId && op.toSessionId) {
          push(
            i,
            "a plan link must touch a session this plan creates — link two existing sessions through the links door instead"
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
      default:
        return;
    }
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

  return problems;
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
    | "rule";
  label: string;
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
      case "create_link":
        return {
          ...base,
          kind: "link",
          label: `${op.fromRef ?? op.fromSessionId} --${op.type}--> ${op.toRef ?? op.toSessionId}`,
        };
      case "create_skill":
        return { ...base, kind: "skill", label: op.name };
      case "create_automation":
        return { ...base, kind: "automation", label: op.name };
      case "create_rule":
        return { ...base, kind: "rule", label: op.intent };
    }
  });
}
