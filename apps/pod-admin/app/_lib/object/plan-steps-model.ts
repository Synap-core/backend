/**
 * THE STEPS OF A PLAN, AS MARKS — the pure model behind the session page's
 * "Steps" section (`views/plan-steps-section.tsx`).
 *
 * Pod admin shows the SAME truth the flow canvas draws and hands off to it
 * (decision acec8eb9: pod admin stays at shared marks plus doors): it reads
 * the work graph (`focusSessions.graph`, the canvas's own read) and asks THE
 * shared rule for each step's readiness (`stepReadinessOf`,
 * `@synap-core/types/units`, over `deriveStepReadiness`). Nothing here
 * re-derives a blocker, a date or a close: this only decides which nodes are
 * the plan's steps and how a state is drawn.
 *
 *   - a step is a session the root spawned (`spawned_from`, the node's
 *     `parentSessionId`) and the graph holds in its window; the root itself
 *     and far ends are never steps;
 *   - a mark is a glyph AND a word AND a ring, never colour alone: the word
 *     is one of the rule's seven (`STEP_READINESS_STATES`), the glyph and
 *     tone come from the exhaustive table below, so a state added to the rule
 *     fails the typecheck here;
 *   - a read that could not answer its blocker sections is said: the marks
 *     then read "planned" for what waits, never "ready" on a guess;
 *   - a plan with no step is OMITTED.
 */
import {
  STEP_READINESS_STATES,
  stepBlockersReadable,
  stepReadinessOf,
  type StepGraphNode,
  type StepReadiness,
  type StepReadinessGraph,
} from "@synap-core/types/units";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { objectViewsT } from "./views/copy";

/** A graph node, as far as the section reads it. */
export interface PlanGraphNode extends StepGraphNode {
  title?: string | null;
  goal?: string | null;
  parentSessionId?: string | null;
}

/** The graph, as far as the section reads it (a `focusSessions.graph` answer fits). */
export interface PlanGraph extends StepReadinessGraph {
  nodes: readonly PlanGraphNode[];
  window?: { truncated?: boolean };
}

/** How a state is drawn: the glyph, and the tone of `StatusPill`. */
export interface ReadinessMark {
  state: StepReadiness;
  /** The catalog key of its word. */
  wordKey: `readiness.${StepReadiness}`;
  glyph:
    "planned" | "ready" | "blocked" | "active" | "done" | "skipped" | "dropped";
  tone: "healthy" | "stale" | "down" | "unknown";
}

const MARKS: Record<StepReadiness, Omit<ReadinessMark, "state" | "wordKey">> = {
  planned: { glyph: "planned", tone: "unknown" },
  ready: { glyph: "ready", tone: "healthy" },
  blocked: { glyph: "blocked", tone: "stale" },
  active: { glyph: "active", tone: "healthy" },
  done: { glyph: "done", tone: "healthy" },
  skipped: { glyph: "skipped", tone: "unknown" },
  dropped: { glyph: "dropped", tone: "down" },
};

/** The mark of a readiness state. */
export function readinessMark(state: StepReadiness): ReadinessMark {
  return { state, wordKey: `readiness.${state}`, ...MARKS[state] };
}

/** Every state's mark, in the rule's order (the legend of a test, never a UI list). */
export const READINESS_MARKS: readonly ReadinessMark[] =
  STEP_READINESS_STATES.map(readinessMark);

/** The word of a state, in the ambient locale. */
export function readinessWord(state: StepReadiness): string {
  return objectViewsT()(`readiness.${state}`);
}

export interface PlanStepRow {
  id: string;
  title: string;
  mark: ReadinessMark;
}

export type PlanSteps =
  | { state: "none" }
  | {
      state: "ok";
      rows: PlanStepRow[];
      /** A blocker section could not be read: what waits may be held by more. */
      waitsUnread: boolean;
      /** The window cut the read: there may be more steps than drawn. */
      truncated: boolean;
    };

/**
 * The steps of the plan rooted at `rootId`, each with its readiness mark, in
 * the graph's order (the pod's: open first).
 */
export function planSteps(
  graph: PlanGraph | null | undefined,
  rootId: string,
  now?: number
): PlanSteps {
  if (!graph) return { state: "none" };
  const steps = graph.nodes.filter(
    (n) => n.inWindow !== false && n.parentSessionId === rootId
  );
  if (steps.length === 0) return { state: "none" };
  const readiness = stepReadinessOf(graph, now);
  const untitled = objectViewsT()("plan.untitled");
  return {
    state: "ok",
    rows: steps.map((n) => ({
      id: n.id,
      title: resolveSessionTitle({ title: n.title, goal: n.goal }) || untitled,
      // Every in-window node has a readiness; `planned` is the safe floor.
      mark: readinessMark(readiness.get(n.id) ?? "planned"),
    })),
    waitsUnread: !stepBlockersReadable(graph),
    truncated: graph.window?.truncated === true,
  };
}
