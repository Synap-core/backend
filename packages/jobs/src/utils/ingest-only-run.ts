/**
 * Does this automation only STORE data? (founder decisions 90897bca + ce5fb987,
 * 2026-11-27). An ingest-only run records itself in `automation_runs` (status,
 * steps, error) and mints NO focus session: there is nothing to react to,
 * nobody to ask and nothing to review, so a session (and its close event) was
 * pure weight. The GitHub dev-loop ingest alone minted ~12,000 run sessions a
 * week, 95% of every new session on the pod.
 *
 * Decided ONLY from what the automation already declares, never its name:
 *   1. its data contract (`metadata.dataContract`, the one shape
 *      `automationDataContractSchema` validates) says `mode: "ingest"` with an
 *      EMPTY `reacts` list; AND
 *   2. every node of its flow is one that cannot ask a person, block on one,
 *      post, hand off, call out or file a proposal: a pure control or read
 *      node, or an `output` node whose type writes without review (an
 *      observation, the automation's own state).
 *
 * Both must hold: a contract can be stale, and a flow node is what actually
 * runs. Anything not on the allow-lists below (a capability, a command, a
 * playbook run, a fetch, a delay, a loop, an entity or facet write that may be
 * PROPOSED, a notification, a channel message, a session update) keeps its run
 * session. A new node or output type is therefore NOT ingest-only until it is
 * added here on purpose.
 *
 * What still records a failed ingest-only run, with no session: the run row
 * (`automation_runs.status = 'failed'`, `error_message`, step rows), which the
 * runs ledger, diagnose's failed flows, Happening's rule-run row (it reads
 * exactly the runs that opened no session), the run narration and the
 * automation-health warden already read. Pure: no DB.
 */

/** Node types that neither write nor wait: control flow and reads. */
export const INGEST_ONLY_NODE_TYPES: ReadonlySet<string> = new Set([
  "trigger",
  "condition",
  "guard",
  "switch",
  "select",
  "transform",
  "compute",
  "query",
  "entity_read",
  "related_entities",
  "messages_query",
  "runs_query",
  "proposals_query",
]);

/**
 * `output` node types that store without review: an observation reports what
 * already happened and never files a proposal (`record_observation`); a
 * `set_state` merges the automation's own watermark.
 */
export const INGEST_ONLY_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "record_observation",
  "set_state",
]);

function declaresIngestOnly(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const contract = (metadata as { dataContract?: unknown }).dataContract;
  if (!contract || typeof contract !== "object") return false;
  const { mode, reacts } = contract as { mode?: unknown; reacts?: unknown };
  return mode === "ingest" && Array.isArray(reacts) && reacts.length === 0;
}

function nodeOnlyStores(node: { type?: string; data?: unknown }): boolean {
  if (node.type === "output") {
    const outputType = (node.data as { outputType?: unknown } | null)
      ?.outputType;
    return (
      typeof outputType === "string" && INGEST_ONLY_OUTPUT_TYPES.has(outputType)
    );
  }
  return typeof node.type === "string" && INGEST_ONLY_NODE_TYPES.has(node.type);
}

/** THE predicate: true → the run records itself on its run row only. */
export function isIngestOnlyAutomation(automation: {
  metadata: unknown;
  flowDefinition: {
    nodes?: ReadonlyArray<{ type?: string; data?: unknown }>;
  } | null;
}): boolean {
  if (!declaresIngestOnly(automation.metadata)) return false;
  const nodes = automation.flowDefinition?.nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.every(nodeOnlyStores);
}
