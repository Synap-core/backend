/**
 * Runnable action projection.
 *
 * The capability registry is intentionally broad: it includes teaching docs,
 * drafts, disconnected providers, and IS-native catalog entries. External AI
 * clients need the narrower truth: actions the shared execute door can launch
 * now, with the data needed to render and govern that launch. This module is
 * the single projection used by MCP and Hub REST clients.
 */
import type { Capability } from "@synap/playbooks";

export interface RunnableActionConnection {
  required: boolean;
  state: "connected" | "missing";
  provider: string;
}

export interface RunnableCapabilityAction {
  /** Backing skill UUID (standalone skills) or verb id (tool-owned verbs). */
  skillId?: string;
  verbId?: string;
  label: string;
  description?: string | null;
  tool: string | null;
  /** This projection never emits a disconnected action; included for UI truth. */
  connection?: RunnableActionConnection;
  /** Capability approval state as reflected by the registry. */
  governance: "auto" | "propose";
  /** The active grant's execution mode where a tool verb has one. */
  executionMode?: string;
  /**
   * Direction axis of a tool verb — `read` = pull (data IN), `write`/`action` =
   * push (mutation OUT). Straight off `ToolVerb.kind`; lets the client bucket a
   * verb by direction. Undefined for a skill-only action (no tool verb) — the
   * client renders honest-unknown, NEVER a defaulted "read".
   */
  kind?: "read" | "write" | "action";
  /**
   * Vendor-independent routing intent (`ABSTRACT_VERBS`) — off `ToolVerb.intent`.
   * OPTIONAL by nature: a verb that fits none of the 13 closed values, and every
   * skill-only action, leave it undefined (honest-unknown, never invented).
   */
  intent?: string;
  /** Actual parameter schema; never a fabricated form shape. */
  parameters: Record<string, unknown>;
}

function inputSchema(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Return only actions which are executable through `executeCapability` now.
 *
 * Draft/unapproved capabilities, disconnected providers, teaching documents,
 * and IS-native catalog-only entries are deliberately absent. A proposal is a
 * valid governed execution outcome, but an unapproved draft is not runnable at
 * all, so it must not be advertised as one.
 */
export function projectRunnableActions(
  capabilities: Capability[]
): RunnableCapabilityAction[] {
  return projectWithSource(capabilities).map((row) => row.action);
}

/**
 * The projection, with each action paired to the registry row that produced it
 * — so a caller can attribute a runnable verb to its container without a second
 * rule. `projectRunnableActions` is exactly this, minus the source.
 */
function projectWithSource(
  capabilities: Capability[]
): Array<{ action: RunnableCapabilityAction; source: Capability }> {
  const actions: Array<{
    action: RunnableCapabilityAction;
    source: Capability;
  }> = [];

  // A skill whose NAME is a tool verb id is that verb's BACKING skill (registry
  // contract: a verb's catalog id mirrors its requiring skill's name). The tool
  // verb row governs it — including the connection gate — so it must never also
  // surface as a standalone skill row. Live (2026-09-14) it did: 15 duplicate
  // rows, 5 of them Gmail/Calendar/Drive advertised runnable with the Google
  // connection missing. Same rule `sectionCapabilities` applies.
  const toolVerbIds = new Set<string>();
  for (const capability of capabilities) {
    if (capability.kind === "skill") continue;
    for (const verb of capability.verbs ?? []) toolVerbIds.add(verb.id);
  }

  for (const capability of capabilities) {
    if (
      capability.catalogOnly ||
      capability.governance !== "auto" ||
      (capability as Capability & { runnable?: boolean }).runnable === false
    ) {
      continue;
    }

    const connection = capability.connection;
    if (connection?.required && !connection.connected) continue;
    const projectedConnection = connection?.required
      ? {
          required: true,
          state: "connected" as const,
          provider: connection.provider,
        }
      : undefined;

    for (const verb of capability.verbs ?? []) {
      // The execute door launches the backing skill, not the tool row. Do not
      // surface a catalog verb when that skill is missing, inactive, or draft.
      if (
        (verb as typeof verb & { backingSkillExecutable?: boolean })
          .backingSkillExecutable !== true
      ) {
        continue;
      }
      actions.push({
        source: capability,
        action: {
          verbId: verb.id,
          label: verb.label ?? verb.id,
          description: capability.description,
          tool: capability.name,
          ...(projectedConnection ? { connection: projectedConnection } : {}),
          governance: capability.governance,
          ...(verb.effectiveExecMode
            ? { executionMode: verb.effectiveExecMode }
            : {}),
          // Per-verb direction — projected straight off the catalog entry, never
          // defaulted. `kind` is required on ToolVerb; `intent` is optional and
          // stays undefined for a verb outside the closed vocabulary.
          ...(verb.kind ? { kind: verb.kind } : {}),
          ...(verb.intent ? { intent: verb.intent } : {}),
          parameters: inputSchema(verb.paramsSchema),
        },
      });
    }

    // Code/declarative/builtin skills with no tool verb remain executable. They
    // carry BOTH ids: `skillId`, and `verbId` = the skill NAME — the same key the
    // catalog card's verb and the execute door's `verbId` resolve by (live, all
    // 33 Synap Core verbs were projected with no `verbId`, so nothing could match
    // them by name). Teaching docs intentionally have governance "none" and are
    // already excluded above.
    if (
      capability.kind === "skill" &&
      (capability.verbs?.length ?? 0) === 0 &&
      !toolVerbIds.has(capability.name)
    ) {
      actions.push({
        source: capability,
        action: {
          skillId: capability.id,
          verbId: capability.name,
          label: capability.name,
          description: capability.description,
          tool: null,
          governance: capability.governance,
          parameters: inputSchema(capability.inputSchema),
        },
      });
    }
  }

  return actions;
}

/**
 * The verb ids the execute door can launch, per capability CONTAINER — judged by
 * the projection itself over the WHOLE registry list (so a backing skill is
 * governed by its tool verb exactly as `GET /capabilities/actions` governs it),
 * then attributed through the producing row's derived `containerId`. The catalog
 * card reads this for each verb's `runnable` and for whether a `ready` pack may
 * say `run`. A brick in no container belongs to no card.
 */
export function runnableVerbIdsByContainer(
  capabilities: Array<Capability & { containerId?: string | null }>
): Map<string, Set<string>> {
  const byContainer = new Map<string, Set<string>>();
  for (const { action, source } of projectWithSource(capabilities)) {
    const containerId = (source as { containerId?: string | null }).containerId;
    if (!containerId || !action.verbId) continue;
    const ids = byContainer.get(containerId) ?? new Set<string>();
    ids.add(action.verbId);
    byContainer.set(containerId, ids);
  }
  return byContainer;
}
