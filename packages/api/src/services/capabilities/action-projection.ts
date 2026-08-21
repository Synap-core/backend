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
  const actions: RunnableCapabilityAction[] = [];

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
      });
    }

    // Code/declarative/builtin skills with no tool verb remain executable by
    // skillId. Teaching docs intentionally have governance "none" and are
    // already excluded above.
    if (capability.kind === "skill" && (capability.verbs?.length ?? 0) === 0) {
      actions.push({
        skillId: capability.id,
        label: capability.name,
        description: capability.description,
        tool: null,
        governance: capability.governance,
        parameters: inputSchema(capability.inputSchema),
      });
    }
  }

  return actions;
}
