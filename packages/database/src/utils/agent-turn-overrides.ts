/**
 * Per-agent overrides for ONE AI turn — the pod's `agent_configs` row, as the
 * Intelligence Service receives it.
 *
 * `agent_configs` is the ONE store for per-agent configuration (the IS's own
 * registry was retired, W1c). Every pod path that starts an IS turn forwards
 * the effective row on the turn request as `agentOverrides`, so the IS applies
 * it without a second read:
 *   - `null`      → the pod looked and there is no row (defaults apply);
 *   - absent      → this caller did not look (or the read FAILED); the IS then
 *                   reads `GET /api/hub/agent-configs` itself.
 * A failed read is never forwarded as `null` — that would tell the IS "no
 * overrides" when the truth is "unknown".
 *
 * The key is (userId, workspaceId, agentType): the human the turn runs for,
 * the workspace it runs in, the agent type it runs as. A pod-wide turn (no
 * workspace) has no row — every writer (`agentConfigs.upsert`) keys a workspace.
 */

import { createLogger } from "@synap-core/core";
import { and, eq } from "drizzle-orm";
import { db } from "../client-pg.js";
import { agentConfigs, type AgentConfig } from "../schema/agent-configs.js";

const logger = createLogger({ module: "agent-turn-overrides" });

/** The wire shape of the overrides on an IS turn request. */
export interface AgentTurnOverrides {
  /** Pins the LLM by id (e.g. "openrouter/anthropic/claude-sonnet-4.5"). */
  modelOverride: string | null;
  promptAppend: string | null;
  extraToolIds: string[];
  disabledToolIds: string[];
  maxStepsOverride: number | null;
}

export function toAgentTurnOverrides(
  row: Pick<
    AgentConfig,
    | "modelOverride"
    | "promptAppend"
    | "extraToolIds"
    | "disabledToolIds"
    | "maxStepsOverride"
  >
): AgentTurnOverrides {
  return {
    modelOverride: row.modelOverride ?? null,
    promptAppend: row.promptAppend ?? null,
    extraToolIds: row.extraToolIds ?? [],
    disabledToolIds: row.disabledToolIds ?? [],
    maxStepsOverride: row.maxStepsOverride ?? null,
  };
}

/**
 * Read the effective overrides for a turn. Resolves `null` when there is no
 * row; THROWS when the read fails — the caller then omits `agentOverrides`
 * from the request (see the module doc).
 */
export async function loadAgentTurnOverrides(input: {
  userId: string;
  workspaceId: string | null | undefined;
  agentType: string;
}): Promise<AgentTurnOverrides | null> {
  if (!input.workspaceId) return null;
  const row = await db.query.agentConfigs.findFirst({
    where: and(
      eq(agentConfigs.userId, input.userId),
      eq(agentConfigs.workspaceId, input.workspaceId),
      eq(agentConfigs.agentType, input.agentType)
    ),
  });
  return row ? toAgentTurnOverrides(row) : null;
}

/**
 * The value a turn request carries in `agentOverrides`: the row, `null` when
 * there is none, or `undefined` when the read failed (logged) — the IS then
 * reads it itself instead of running on a false "no overrides".
 */
export async function agentOverridesForTurn(input: {
  userId: string;
  workspaceId: string | null | undefined;
  agentType: string;
}): Promise<AgentTurnOverrides | null | undefined> {
  try {
    return await loadAgentTurnOverrides(input);
  } catch (err) {
    logger.warn(
      { err, agentType: input.agentType, workspaceId: input.workspaceId },
      "agent_configs read failed — the IS will read the overrides itself"
    );
    return undefined;
  }
}
