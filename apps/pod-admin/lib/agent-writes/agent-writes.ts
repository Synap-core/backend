/**
 * How one agent's writes land — the pure half of the control on its page and
 * of its row on Agents & work. Framework-free (no React / HeroUI / trpc), so
 * the decisions worth testing live here and the components only draw.
 *
 * Read: `agentUsers.governance` (`writeMode`, its one sentence `line`, the
 * pod-wide posture `postures.pod`, `podDefaultEnabled`, and `effective`: the
 * mode its writes REALLY follow once the computer it runs on is counted, the
 * stricter of the two, with `decidedBy`). Write:
 * `agentUsers.setPosture` with `agentPostureOfWriteMode(mode)` (`null` =
 * follow the pod default).
 *
 * Words: THE list a person chooses from, `AGENT_WRITE_MODE_CHOICES`
 * (@synap-core/types/agents, also drawn by `/device`), and its sentences
 * `AGENT_WRITE_MODE_LINE` — never a local map.
 */

import {
  AGENT_WRITE_MODE_CHOICES,
  AGENT_WRITE_MODE_LINE,
  agentPostureOfWriteMode,
  isAgentWriteMode,
  resolveAgentWriteMode,
  type AgentEffectiveWriteMode,
  type AgentWriteMode,
} from "@synap-core/types/agents";
import { humanizeToken } from "@synap-core/types/vocabulary";

/** The slice of `agentUsers.governance` this reads. */
export interface AgentWritesRead {
  writeMode: AgentWriteMode;
  line: string;
  postures: { pod: string | null };
  podDefaultEnabled: boolean;
  /** Absent on a pod older than the effective read: the agent's own then. */
  effective?: AgentEffectiveWriteMode | null;
}

/**
 * The computer that sets how its writes land — only when it is STRICTER than
 * the agent's own choice (`effective.decidedBy === "computer"`), so the page
 * can say the choice is not what applies, and link to the computer. Null
 * otherwise, and when the computer has no name to show.
 */
export function decidingComputer(
  read: AgentWritesRead
): { id: string; name: string; mode: AgentWriteMode } | null {
  const e = read.effective;
  if (e?.decidedBy !== "computer" || !e.computer?.name) return null;
  return { id: e.computer.id, name: e.computer.name, mode: e.writeMode };
}

/**
 * The choice in force pod-wide, read from the stored posture: no posture is
 * `pod-default` (the pod's rule decides); a posture the pod does not name
 * reads as none, never as a preset.
 */
export function currentWriteMode(read: AgentWritesRead): AgentWriteMode {
  const pod = read.postures.pod;
  return isAgentWriteMode(pod) ? pod : "pod-default";
}

/** A choice's name from THE list; no posture is `pod-default`, an unknown one humanizes. */
export function writeModeLabel(mode: string | null | undefined): string {
  const key = mode ?? "pod-default";
  return (
    AGENT_WRITE_MODE_CHOICES.find((c) => c.mode === key)?.label ??
    humanizeToken(key)
  );
}

/**
 * What each choice does on THIS pod. The chosen one says what the pod answers
 * today (`read.line`, exact even for an older agent's flag). Another says
 * what choosing it would do: a posture is applied STRICT (`applyAgentPosture`
 * pins `writesRequireProposal`), so following the pod default while it is
 * switched off means every change asks.
 */
export function writeModeLines(
  read: AgentWritesRead
): Record<AgentWriteMode, string> {
  const current = currentWriteMode(read);
  const lines = {} as Record<AgentWriteMode, string>;
  for (const { mode } of AGENT_WRITE_MODE_CHOICES) {
    lines[mode] =
      mode === current
        ? read.line
        : AGENT_WRITE_MODE_LINE[
            resolveAgentWriteMode({
              posture: agentPostureOfWriteMode(mode),
              podDefaultEnabled: read.podDefaultEnabled,
              writesRequireProposal: true,
            })
          ];
  }
  return lines;
}

/**
 * A row's mark and sentence: the mode its writes REALLY follow, and what it
 * does today — the agent's own choice, or its computer's when that one is
 * stricter (then `computer` names it). A pod with no effective read falls
 * back to the agent's own.
 */
export function writesSummary(read: AgentWritesRead): {
  label: string;
  line: string;
  computer: { id: string; name: string } | null;
} {
  const e = read.effective;
  const computer = decidingComputer(read);
  return e
    ? {
        label: writeModeLabel(e.writeMode),
        line: e.line,
        computer: computer ? { id: computer.id, name: computer.name } : null,
      }
    : {
        label: writeModeLabel(currentWriteMode(read)),
        line: read.line,
        computer: null,
      };
}

/**
 * Who may change it — the server's gate (`agentUsers.setPosture`, the Hub
 * `PATCH …/governance` door): the person who connected the agent, or a pod
 * admin. Anyone else reads the sentence and is told who can.
 */
export function mayChangeWrites(input: {
  viewerId: string | null;
  creatorId: string | null | undefined;
  viewerIsPodAdmin: boolean;
}): boolean {
  if (input.viewerIsPodAdmin) return true;
  return !!input.viewerId && !!input.creatorId
    ? input.viewerId === input.creatorId
    : false;
}
