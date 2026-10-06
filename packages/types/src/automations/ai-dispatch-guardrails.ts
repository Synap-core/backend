/**
 * AI DISPATCH GUARDRAILS — how much paid agent/IS work one automation may start.
 *
 * THE ONE PLACE these limits live. The engine (`@synap/jobs` executor), the
 * doors (`@synap/api` create/update, the playbook fan-out, the subject
 * cooldown) and the diagnose surface all read them from here, so changing a
 * number below changes it everywhere. Nothing else may restate one of them.
 *
 * Why they exist (incident 2026-10): a cron rule queried every `company`
 * (limit 100, empty filter), looped, and started a playbook run plus an IS
 * command per item. About 200 AI calls a day ran for weeks while the parent run
 * reported success, because a child that later failed never reached it.
 *
 *   1. PER RUN — {@link AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerRun}. Counted
 *      across loop iterations. Also bounds a playbook's own input fan-out (one
 *      run per item), which means the same thing: AI work started by ONE trigger.
 *   2. PER DAY — `triggerConfig.maxAiDispatchesPerDay` per automation, default
 *      {@link AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerDayDefault}. Enforced by
 *      the EXECUTOR, so every trigger origin (cron included) is covered.
 *   3. REQUIRED FILTER — a `query` feeding a loop whose body dispatches AI work
 *      needs a non-empty `filter` or an explicit `scope: "all"`.
 *   4. COOLDOWN — a subject whose latest run of a playbook FAILED within
 *      {@link AI_DISPATCH_GUARDRAILS.failedSubjectCooldownHours} is skipped by
 *      the subject-idempotent path with reason `cooling_down`.
 *
 * Pure + zero-dep — safe in browser, Electron, React Native, Node and CLI.
 */

import type { AutomationNodeBase } from "@synap/database";
import { readPlaybookRunMode } from "./rule-run-policy.js";

// ── The numbers ─────────────────────────────────────────────────────────────

export const AI_DISPATCH_GUARDRAILS = {
  /** AI dispatches one automation run may start, across every loop iteration. */
  maxAiDispatchesPerRun: 25,
  /** Default rolling-24h AI dispatches per automation (`triggerConfig` overrides). */
  maxAiDispatchesPerDayDefault: 50,
  /** Hours a subject waits after its latest run of a playbook FAILED. */
  failedSubjectCooldownHours: 24,
  /** Iterations one `loop` node walks, AI or not (a width bound, not a cost one). */
  maxLoopIterations: 100,
} as const;

// ── Which nodes are AI dispatches ───────────────────────────────────────────

type FlowNodeType = AutomationNodeBase["type"];

/**
 * Node types that start agent/IS work. `playbook_run` counts only in `run`
 * mode: `appointment` waits for a person and `propose` files a proposal, and
 * neither kicks off an agent.
 */
export const AI_DISPATCH_NODE_TYPES = [
  "command", // an IS task (`requestTaskExecute`)
  "playbook_run", // a session + agent kickoff (run mode only)
] as const satisfies ReadonlyArray<FlowNodeType>;

/**
 * Every other node type, each classified on purpose. `skill` and `capability`
 * route through the capability router, whose tier (builtin, declarative, code
 * sandbox) is only known at dispatch time, and none of them is an agent turn.
 * `sub_automation` starts its own automation run, which carries its own caps.
 */
export const NON_AI_DISPATCH_NODE_TYPES = [
  "trigger",
  "condition",
  "delay",
  "output",
  "loop",
  "transform",
  "fetch",
  "query",
  "entity_read",
  "related_entities",
  "compute",
  "select",
  "claim",
  "guard",
  "messages_query",
  "runs_query",
  "proposals_query",
  "switch",
  "skill",
  "capability",
  "sub_automation",
] as const satisfies ReadonlyArray<FlowNodeType>;

// Compile-time coverage floor: a new node type that is in neither list makes
// this `never` and stops the build, so nobody can add an agent-dispatching node
// that the caps silently do not count.
type _Classified =
  Exclude<
    FlowNodeType,
    (typeof AI_DISPATCH_NODE_TYPES)[number]
  > extends (typeof NON_AI_DISPATCH_NODE_TYPES)[number]
    ? true
    : never;
const _classified: _Classified = true;
void _classified;

const AI_TYPE_SET = new Set<string>(AI_DISPATCH_NODE_TYPES);

/** Does this (stored, loosely typed) node start agent/IS work? */
export function isAiDispatchNode(node: unknown): boolean {
  const n = node as { type?: unknown; data?: { mode?: unknown } } | null;
  if (!n || typeof n.type !== "string" || !AI_TYPE_SET.has(n.type)) {
    return false;
  }
  if (n.type === "playbook_run") {
    return readPlaybookRunMode(n.data?.mode) === "run";
  }
  return true;
}

// ── Per-automation daily cap ────────────────────────────────────────────────

export const MAX_AI_DISPATCHES_PER_DAY_KEY = "maxAiDispatchesPerDay" as const;
/** Upper bound accepted at the door. */
export const MAX_AI_DISPATCHES_PER_DAY_CEILING = 10_000;

export type MaxAiDispatchesPerDayRead =
  { ok: true; value: number } | { ok: false; error: string };

/**
 * Read + validate `triggerConfig.maxAiDispatchesPerDay`. Absent / null ⇒ the
 * default. Present ⇒ a positive whole number ≤ the ceiling, or an error the
 * create/update doors return verbatim.
 */
export function readMaxAiDispatchesPerDay(
  triggerConfig: unknown
): MaxAiDispatchesPerDayRead {
  const raw = (triggerConfig as Record<string, unknown> | null | undefined)?.[
    MAX_AI_DISPATCHES_PER_DAY_KEY
  ];
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      value: AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerDayDefault,
    };
  }
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > MAX_AI_DISPATCHES_PER_DAY_CEILING
  ) {
    return {
      ok: false,
      error: `triggerConfig.${MAX_AI_DISPATCHES_PER_DAY_KEY} must be a whole number from 1 to ${MAX_AI_DISPATCHES_PER_DAY_CEILING} (got ${JSON.stringify(raw)}).`,
    };
  }
  return { ok: true, value: raw };
}

// ── Required filter on an AI fan-out ────────────────────────────────────────

/** The explicit "yes, every row" acknowledgement on a `query` node. */
export const QUERY_SCOPE_ALL = "all" as const;

/**
 * Node types a `loop` dispatches PER ITEM. The executor's loop-ownership rule
 * (`computeLoopBodyNodeIds`, @synap/jobs) reads this list, so the filter rule
 * below and the engine agree on what a loop's body is.
 */
export const LOOP_BODY_NODE_TYPES = [
  "command",
  "output",
  "playbook_run",
  "messages_query",
  "runs_query",
  "proposals_query",
  "query",
  "fetch",
  "transform",
  "condition",
  "skill",
  "capability",
] as const satisfies ReadonlyArray<FlowNodeType>;
const LOOP_BODY_TYPES = new Set<string>(LOOP_BODY_NODE_TYPES);

interface LooseNode {
  id?: unknown;
  type?: unknown;
  data?: unknown;
}
interface LooseEdge {
  source?: unknown;
  target?: unknown;
}

function hasFilter(filter: unknown): boolean {
  if (typeof filter === "string") return filter.trim().length > 0;
  if (Array.isArray(filter)) return filter.length > 0;
  if (filter && typeof filter === "object") {
    return Object.keys(filter).length > 0;
  }
  return false;
}

/**
 * THE required-filter rule. Returns one actionable message per unfiltered
 * `query` that feeds a loop whose body dispatches AI work, or `[]`.
 *
 * "Feeds" = the loop's `iteratorExpression` reads `steps.<queryId>` (the data
 * dependency the executor resolves), or an edge runs query → loop. The loop's
 * body is the contiguous chain of loop-dispatchable nodes reachable from it —
 * the executor's own ownership rule.
 *
 * Pure. Called on untyped JSON at every create/update door; a stored flow is
 * never rewritten by it.
 */
export function findUnfilteredAiFanouts(flow: unknown): string[] {
  const f = flow as { nodes?: unknown; edges?: unknown } | null | undefined;
  if (!f || !Array.isArray(f.nodes) || !Array.isArray(f.edges)) return [];
  const nodes = f.nodes as LooseNode[];
  const edges = f.edges as LooseEdge[];
  const byId = new Map<string, LooseNode>();
  for (const n of nodes) if (typeof n?.id === "string") byId.set(n.id, n);

  const loopBody = (loopId: string): LooseNode[] => {
    const seen = new Set<string>();
    const out: LooseNode[] = [];
    const stack = edges
      .filter((e) => e?.source === loopId && typeof e.target === "string")
      .map((e) => e.target as string);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = byId.get(id);
      if (!n || typeof n.type !== "string" || !LOOP_BODY_TYPES.has(n.type)) {
        continue;
      }
      out.push(n);
      for (const e of edges) {
        if (e?.source === id && typeof e.target === "string") {
          stack.push(e.target);
        }
      }
    }
    return out;
  };

  const errors: string[] = [];
  for (const loop of nodes) {
    if (loop?.type !== "loop" || typeof loop.id !== "string") continue;
    if (!loopBody(loop.id).some(isAiDispatchNode)) continue;
    const iterator = String(
      (loop.data as { iteratorExpression?: unknown } | undefined)
        ?.iteratorExpression ?? ""
    );
    for (const query of nodes) {
      if (query?.type !== "query" || typeof query.id !== "string") continue;
      const feeds =
        iterator.includes(`steps.${query.id}.`) ||
        iterator.includes(`steps.${query.id}}`) ||
        iterator.trim() === `steps.${query.id}` ||
        edges.some((e) => e?.source === query.id && e.target === loop.id);
      if (!feeds) continue;
      const data = (query.data ?? {}) as { filter?: unknown; scope?: unknown };
      if (hasFilter(data.filter) || data.scope === QUERY_SCOPE_ALL) continue;
      errors.push(
        `[${query.id}] This query feeds loop "${loop.id}", which starts AI work for every row, but it has no filter — so it would run on every record. Add a filter, or set scope: "${QUERY_SCOPE_ALL}" to confirm you mean every record (each run is still capped at ${AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerRun} AI dispatches).`
      );
    }
  }
  return errors;
}

/** Door helper: the joined message, or null when the flow passes. */
export function unfilteredAiFanoutError(flow: unknown): string | null {
  const errors = findUnfilteredAiFanouts(flow);
  return errors.length > 0
    ? `Invalid automation flow: ${errors.join(" ")}`
    : null;
}
