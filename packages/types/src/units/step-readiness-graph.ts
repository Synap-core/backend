/**
 * STEP READINESS OF A WORK GRAPH — `deriveStepReadiness` (`./session.ts`) fed
 * from the ONE read every surface draws a plan from: the work graph
 * (`focusSessions.graph`, Hub `GET /focus-sessions/graph`; the pod's
 * `services/focus-sessions/work-graph.ts`).
 *
 * The rule needs, per step, its status, how it ended (`closedAs`), whether it
 * was skipped, its `plannedFor` and the blockers that still hold it AFTER
 * `replaces` following. The graph carries every one of those facts; this file
 * is only the adapter, so the pod admin, the browser and the apps never each
 * re-gather them their own way (that is how a mark forks). The blockers come
 * from THE dependency rule, `deriveOpenBlockers`, fed the graph's own edges.
 *
 * A FAILED OR CUT READ IS NOT A CLEARED ONE. A blocker the graph does not
 * hold (not in `nodes`, `decisions`, `entities` or `goals`) is UNKNOWN: it
 * waits, `deriveOpenBlockers` reads an unknown state as open. When a section
 * that carries blockers could not be read (`blockedBy`, `crossKind`, `farEnds`,
 * `decisions`, `goals`), the step's blockers are `null` (unknown), which the
 * rule reads as "waiting", never "ready" on a guess.
 *
 * Pure; zero I/O. Structural inputs: a `WorkGraph` fits, so does a Hub wire
 * graph.
 */
import {
  DEPENDENCY_LINK_TYPE,
  REPLACES_LINK_TYPE,
  deriveOpenBlockers,
  type DependencyEdge,
  type DependencyNodeRef,
  type DependencyNodeState,
} from "../connections/dependency.js";
import type { LifecycleCategory } from "../lifecycle/option.js";
import { deriveStepReadiness, type StepReadiness } from "./session.js";

/** A graph node, as far as the rule reads it. */
export interface StepGraphNode {
  id: string;
  status: string;
  /** How it ended; absent on a closed step reads done. */
  closedAs?: "done" | "not_done" | null;
  /** Ended as a decision's arm not taken. */
  skipped?: boolean;
  plannedFor?: string | null;
  /** false = only the far end of an edge: it is a blocker, not a step. */
  inWindow?: boolean;
}

export interface StepGraphEdge {
  kind: string;
  from: string;
  to: string;
  fromKind?: string;
  toKind?: string;
  /** `blocked_by` to a decision: the arm this step is. */
  option?: string;
}

export interface StepGraphThing {
  id: string;
  status: string | null;
  category: LifecycleCategory | null;
  /** A decision's chosen option key. */
  chosenOption?: string | null;
}

export interface StepGraphGoal {
  id: string;
  status: string;
}

type Section = { status: "ok" } | { status: "unavailable"; reason?: string };

/** The graph, as far as the rule reads it. */
export interface StepReadinessGraph {
  nodes: readonly StepGraphNode[];
  edges: readonly StepGraphEdge[];
  decisions?: readonly StepGraphThing[];
  entities?: readonly StepGraphThing[];
  goals?: readonly StepGraphGoal[];
  /** Absent on a pod from before the sections: nothing is said unreadable. */
  sections?: Partial<
    Record<
      "blockedBy" | "crossKind" | "farEnds" | "decisions" | "goals",
      Section
    >
  >;
}

/** The sections whose failure leaves a step's blockers unknown. */
const BLOCKER_SECTIONS = [
  "blockedBy",
  "crossKind",
  "farEnds",
  "decisions",
  "goals",
] as const;

const refKey = (kind: string, id: string) => `${kind}:${id}`;

/** The blockers' sections all answered. */
export function stepBlockersReadable(graph: StepReadinessGraph): boolean {
  const s = graph.sections;
  return !s || BLOCKER_SECTIONS.every((k) => s[k]?.status !== "unavailable");
}

/**
 * The readiness of every step the graph holds in its window, keyed by session
 * id: THE rule (`deriveStepReadiness`) over THE dependency rule
 * (`deriveOpenBlockers`), both fed from the graph alone.
 */
export function stepReadinessOf(
  graph: StepReadinessGraph,
  now: number = Date.now()
): Map<string, StepReadiness> {
  const states = new Map<string, DependencyNodeState>();
  for (const n of graph.nodes) {
    states.set(refKey("session", n.id), {
      status: n.status,
      closedAs: n.closedAs ?? null,
      ...(n.skipped ? { skipped: true } : {}),
    });
  }
  for (const t of [...(graph.decisions ?? []), ...(graph.entities ?? [])]) {
    states.set(refKey("entity", t.id), {
      status: t.status,
      category: t.category,
      chosenOption: t.chosenOption ?? null,
    });
  }
  for (const g of graph.goals ?? []) {
    states.set(refKey("track", g.id), { status: g.status });
  }
  const edges: DependencyEdge[] = [];
  for (const e of graph.edges) {
    if (e.kind !== DEPENDENCY_LINK_TYPE && e.kind !== REPLACES_LINK_TYPE) {
      continue;
    }
    edges.push({
      fromType: e.fromKind ?? "session",
      fromId: e.from,
      toType: e.toKind ?? "session",
      toId: e.to,
      linkType: e.kind,
      ...(e.option ? { option: e.option } : {}),
    });
  }
  const stateOf = (ref: DependencyNodeRef) =>
    states.get(refKey(ref.kind, ref.id));
  const readable = stepBlockersReadable(graph);

  const out = new Map<string, StepReadiness>();
  for (const n of graph.nodes) {
    if (n.inWindow === false) continue;
    const openBlockers = readable
      ? deriveOpenBlockers({ kind: "session", id: n.id }, edges, stateOf)
      : null;
    out.set(
      n.id,
      deriveStepReadiness({
        status: n.status,
        closedAs: n.closedAs ?? null,
        skipped: n.skipped === true,
        openBlockers,
        plannedFor: n.plannedFor ?? null,
        now,
      })
    );
  }
  return out;
}
