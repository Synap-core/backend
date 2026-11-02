/**
 * How one agent's writes land — the pure half of the control on its page and
 * of its row on Agents & work. Framework-free (no React / HeroUI / trpc), so
 * the decisions worth testing live here and the components only draw.
 *
 * Read: `agentUsers.governance` (`writeMode`, its one sentence `line`, the
 * pod-wide posture `postures.pod`, `podDefaultEnabled`). Write:
 * `agentUsers.setPosture` (`null` = follow the pod default).
 *
 * Words: the mode's name from the vocabulary (`resolveAgentWriteModeLabel`),
 * its sentence from `AGENT_WRITE_MODE_LINE` — never a local map.
 */

import {
  AGENT_WRITE_MODE_LINE,
  resolveAgentWriteMode,
  type AgentWriteMode,
} from "@synap-core/types/agents";
import { resolveAgentWriteModeLabel } from "@synap-core/types/vocabulary";

/** What a person chooses: no posture of its own (the pod decides), or a preset. */
export type AgentPostureChoice = null | "create-with-undo" | "ask-first";

/** The three choices, loosest first. */
export const AGENT_POSTURE_CHOICES: readonly AgentPostureChoice[] = [
  null,
  "create-with-undo",
  "ask-first",
];

/** The slice of `agentUsers.governance` this reads. */
export interface AgentWritesRead {
  writeMode: AgentWriteMode;
  line: string;
  postures: { pod: string | null };
  podDefaultEnabled: boolean;
}

/** The mode that names a choice (`null` is "follows the pod default"). */
export function choiceMode(choice: AgentPostureChoice): AgentWriteMode {
  return choice ?? "pod-default";
}

/** The choice in force pod-wide. A posture the pod does not name reads as none. */
export function currentChoice(read: AgentWritesRead): AgentPostureChoice {
  const pod = read.postures.pod;
  return pod === "create-with-undo" || pod === "ask-first" ? pod : null;
}

export interface PostureChoiceView {
  /** What `setPosture` receives. */
  value: AgentPostureChoice;
  /** A stable key for the radio (`pod-default`, `create-with-undo`, `ask-first`). */
  key: AgentWriteMode;
  label: string;
  /** Its consequence, in one line, for THIS pod. */
  line: string;
  selected: boolean;
}

/**
 * The three choices with their consequence. The chosen one says what the pod
 * answers today (`read.line`, exact even for an older agent's flag). Another
 * says what choosing it would do: a posture is applied STRICT
 * (`applyAgentPosture` pins `writesRequireProposal`), so "follow the pod
 * default" with the pod default switched off means every change asks.
 */
export function postureChoices(read: AgentWritesRead): PostureChoiceView[] {
  const current = currentChoice(read);
  return AGENT_POSTURE_CHOICES.map((choice) => {
    const selected = choice === current;
    const mode = resolveAgentWriteMode({
      posture: choice,
      podDefaultEnabled: read.podDefaultEnabled,
      writesRequireProposal: true,
    });
    return {
      value: choice,
      key: choiceMode(choice),
      label: resolveAgentWriteModeLabel(choiceMode(choice)),
      line: selected ? read.line : AGENT_WRITE_MODE_LINE[mode],
      selected,
    };
  });
}

/** A row's mark and sentence: the choice in force, and what it does today. */
export function writesSummary(read: AgentWritesRead): {
  label: string;
  line: string;
} {
  return {
    label: resolveAgentWriteModeLabel(choiceMode(currentChoice(read))),
    line: read.line,
  };
}

/** A radio's value (`choiceMode`) back to the choice `setPosture` takes. */
export function choiceFromKey(key: string): AgentPostureChoice {
  return key === "create-with-undo" || key === "ask-first" ? key : null;
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
