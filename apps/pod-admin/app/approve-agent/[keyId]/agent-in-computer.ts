/**
 * `/approve-agent` — the agent being added to (or reconnected on) a computer
 * (0395, plan "Computer once, agents inside" §4 flow 2a, D6/D7): which
 * computer, which engine and job, which OS user, and how its changes will
 * land. Pure: the page draws it, the test reads it.
 *
 * A NEW agent is offered the permission choice, at the recommended one. An
 * agent that already worked keeps its own unless the person changes it (D6):
 * the approval then sends no write mode.
 */
import {
  AGENT_WRITE_MODE_CHOICES,
  RECOMMENDED_AGENT_WRITE_MODE,
  agentInComputerName,
  isAgentWriteMode,
  seatLine,
  type AgentWriteMode,
} from "@synap-core/types/agents";

/** What `/setup/agent/pending/:keyId/details` adds for this (0395). */
export interface AgentInComputerFacts {
  agentType?: string | null;
  agentName?: string | null;
  agentRole?: string | null;
  hostSeat?: string | null;
  computerName?: string | null;
  isNewAgent?: boolean;
  writeMode?: string | null;
}

export interface AgentInComputerView {
  /** "CRM worker · Claude Code on devbox". */
  name: string;
  computerName: string;
  /** `OS user "antoine"`, when the agent has one. */
  seat: string | null;
  isNew: boolean;
  /** How its changes land today (an existing agent). */
  currentMode: AgentWriteMode | null;
  currentModeLabel: string | null;
  /** "Nothing else on devbox changes." */
  nothingElse: string;
}

/** Null when the agent runs on no computer (or the pod is older than 0395). */
export function viewAgentInComputer(
  f: AgentInComputerFacts
): AgentInComputerView | null {
  if (!f.computerName || !f.agentType) return null;
  const currentMode = isAgentWriteMode(f.writeMode) ? f.writeMode : null;
  return {
    name: agentInComputerName({
      agentType: f.agentType,
      role: f.agentRole ?? null,
      name: f.agentName ?? null,
      hostName: f.computerName,
    }),
    computerName: f.computerName,
    seat: seatLine(f.hostSeat ?? null),
    isNew: f.isNewAgent === true,
    currentMode,
    currentModeLabel:
      AGENT_WRITE_MODE_CHOICES.find((c) => c.mode === currentMode)?.label ??
      null,
    nothingElse: `Nothing else on ${f.computerName} changes.`,
  };
}

/** The mode the page shows selected: the person's, else new → recommended. */
export function shownWriteMode(
  view: AgentInComputerView,
  chosen: AgentWriteMode | null
): AgentWriteMode | null {
  if (chosen) return chosen;
  return view.isNew ? RECOMMENDED_AGENT_WRITE_MODE : null;
}

/** What the approval sends: a new agent's mode; an existing one's only if changed. */
export function approveWriteMode(
  view: AgentInComputerView | null,
  chosen: AgentWriteMode | null
): AgentWriteMode | undefined {
  if (!view) return undefined;
  return shownWriteMode(view, chosen) ?? undefined;
}
