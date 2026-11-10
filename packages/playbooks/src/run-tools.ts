/**
 * THE TOOLS A PLAYBOOK RUN IS GIVEN — the one source (plan 08e4fba7, founder
 * decisions 3 and 4, 9 Nov 2026).
 *
 * A run gets a FLOOR fixed by its class, plus its playbook's ONE `tools` list,
 * which means "only these": nothing else is offered. The class is derived from
 * the playbook (`runClassOf`), never stored and never guessed by a model.
 *
 *   one-shot  `executor: generate`: one model call, NO tools.
 *   short     an IS run with at most 2 stages and no gate: reads only.
 *   long      an IS run with 3+ stages or a gate: the pod's 19 core tools.
 *
 * The pod sends the IS the FINAL tool list of a turn (`run.tools`); the IS
 * keeps tool definitions, never a list. Copies, each pinned to this file:
 *   - the catalog's `packages/workspace-templates/schema/run-tools.ts`
 *     (app-bases), by its `run-tools.mirror.tripwire.test.ts`;
 *   - the IS checks every name in {@link RUN_TOOL_NAMES} is a tool it can
 *     build (synap-intelligence-service `run-tools-vocabulary.tripwire`).
 *
 * WHAT A `tools` ENTRY NAMES, in this order (the first that matches wins):
 *   1. a run tool of {@link RUN_TOOL_NAMES} (an IS tool, by its name);
 *   2. an intent slug of the `capability_intents` vocabulary: the verbs that
 *      serve it on this pod are offered;
 *   3. anything else: a capability (by name or id) or a verb id, resolved in
 *      the pod's registry under the run's lens. A name nothing serves is a
 *      FACT (the run is told), never a rejection, like `requiredIntents` was.
 *
 * ROUTING, NEVER AUTHORIZATION: a tool listed here is only OFFERED. Every
 * write still meets the grant gate and `decideAgentPolicy` at the pod.
 */

/** The run class of a playbook — see the file header. */
export type RunClass = "one-shot" | "short" | "long";

/** Executors whose runs are IS turns with a tool list (`is-agent`, `hybrid`). */
export const IS_RUN_EXECUTORS: readonly string[] = ["is-agent", "hybrid"];

/** At this many stages or more a run is `long`. */
export const LONG_RUN_MIN_STAGES = 3;

/**
 * The class of a playbook, from its executor and its stages. PURE and
 * tolerant: a stages bag that is not a list counts as no stages.
 * `external-agent` (the person's own agent, with its own tools) is `long`:
 * the pod sends it no tool list, and a floor never narrows it.
 */
export function runClassOf(playbook: {
  executor?: string | null;
  stages?: unknown;
}): RunClass {
  if (playbook.executor === "generate") return "one-shot";
  const stages = Array.isArray(playbook.stages) ? playbook.stages : [];
  if (stages.length >= LONG_RUN_MIN_STAGES) return "long";
  const gated = stages.some(
    (s) =>
      !!s && typeof s === "object" && (s as { gate?: unknown }).gate != null
  );
  if (gated) return "long";
  return IS_RUN_EXECUTORS.includes(playbook.executor ?? "is-agent")
    ? "short"
    : "long";
}

/** The read floor of a short run: find, read, recall, load a skill. */
export const SHORT_RUN_FLOOR = [
  "search_unified",
  "get_entity",
  "list_entities",
  "get_document",
  "memory_search",
  "load_skill",
] as const;

/**
 * The floor of a long run: the pod's core tools (read and search the pod,
 * orient in its kinds, create and update entities and documents, link them,
 * the one graph proposal, identity and facets, memory recall, a skill).
 * Nothing that builds spaces, manages connections, starts sessions or reaches
 * outside the pod: a run that needs that declares it.
 */
export const LONG_RUN_FLOOR = [
  "search_unified",
  "get_entity",
  "list_entities",
  "list_profiles",
  "get_profile",
  "create_entity",
  "update_entity",
  "update_entities",
  "get_document",
  "create_document",
  "update_document",
  "create_relation",
  "propose_entity_graph",
  "resolve_identity",
  "attach_facet",
  "update_facet",
  "detach_facet",
  "memory_search",
  "load_skill",
] as const;

/** The floor of each class. */
export const RUN_TOOL_FLOORS: Readonly<Record<RunClass, readonly string[]>> = {
  "one-shot": [],
  short: SHORT_RUN_FLOOR,
  long: LONG_RUN_FLOOR,
};

/**
 * Every IS tool a playbook may name in `tools`: the long floor, plus tools a
 * run may be given on top. A name here is a run tool, never an intent or a
 * capability. Never a session, ask or room tool: the pod closes a run's
 * session at turn end and raises a stage's ask (founder, 9 Nov 2026), so a run
 * never needs one.
 */
export const RUN_TOOL_NAMES = [
  ...LONG_RUN_FLOOR,
  "web_search",
  "web_fetch",
  "batch_web_fetch",
  "graph_traverse",
  "get_knowledge",
  "list_knowledge",
  "save_research",
  "remember_fact",
  "record_observation",
  "get_logs",
  "get_session",
  "list_sessions",
  "list_views",
  "inbox_list_threads",
  "inbox_get_thread",
] as const;

const RUN_TOOL_NAME_SET: ReadonlySet<string> = new Set(RUN_TOOL_NAMES);

/** Is this `tools` entry a run tool (an IS tool name)? */
export function isRunToolName(entry: string): boolean {
  return RUN_TOOL_NAME_SET.has(entry);
}

/** The door a declared verb runs through, and where its inputs are read. */
export const RUN_CAPABILITY_TOOL = "run_capability";
export const RUN_LIST_CAPABILITIES_TOOL = "list_capabilities";

/**
 * The cap of the DEPRECATED `requiredIntents` input (0291), folded into
 * `tools` at the write door since 0419. Kept exported while a package may
 * still send it: the catalog's playbook mirror tripwire reads it here.
 */
export const MAX_REQUIRED_INTENTS = 24;

/** At most this many entries in one `tools` list (playbook or stage). */
export const PLAYBOOK_TOOLS_MAX = 64;
/** At most this many characters in one `tools` entry. */
export const PLAYBOOK_TOOL_MAX_CHARS = 200;

/**
 * Read a loose `tools` value (a row's jsonb, a stage's field): the non-empty
 * strings, each once, in order. Anything else reads as no list.
 */
export function readToolsList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The entries of a stage's `tools` that its playbook's `tools` does not list.
 * A stage narrows its playbook, never widens it: the write door refuses a
 * stage whose list is not a subset. PURE.
 */
export function stageToolsOutsidePlaybook(
  playbookTools: readonly string[],
  stageTools: readonly string[]
): string[] {
  const allowed = new Set(playbookTools);
  return stageTools.filter((t) => !allowed.has(t));
}

/**
 * The declared list a turn works from: the ACTIVE stage's list when that stage
 * declares one (a subset of the playbook's), else the playbook's. PURE.
 */
export function activeToolsList(
  playbookTools: readonly string[],
  stages: unknown,
  currentStage: string | null
): string[] {
  if (currentStage && Array.isArray(stages)) {
    const stage = stages.find(
      (s): s is { key: string; tools?: unknown } =>
        !!s &&
        typeof s === "object" &&
        (s as { key?: unknown }).key === currentStage
    );
    if (stage && Array.isArray(stage.tools)) {
      // Enforced at run time too: an entry the playbook does not list (a row
      // written before the write door checked it) is never offered.
      const allowed = new Set(playbookTools);
      return readToolsList(stage.tools).filter((t) => allowed.has(t));
    }
  }
  return [...playbookTools];
}

/**
 * The IS tool names of one turn: the class floor, then the declared run tools,
 * each once. Declared entries that are not run tools (intents, capabilities)
 * are not here: they become `verbs`, offered through {@link RUN_CAPABILITY_TOOL}.
 * PURE.
 */
export function runTurnToolNames(
  runClass: RunClass,
  declared: readonly string[]
): string[] {
  const out: string[] = [...RUN_TOOL_FLOORS[runClass]];
  for (const t of declared) {
    if (isRunToolName(t) && !out.includes(t)) out.push(t);
  }
  return out;
}
