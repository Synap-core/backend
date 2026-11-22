/**
 * How one action of a tool runs for every AI — the choice a tool's page
 * offers under each action that is on (`capability-object.tsx`), and on top
 * of its actions for the whole tool: runs on its own, asks first, never, and
 * for an action whose tool has its own row, "as the tool". The value is read
 * from the approval rows (`tool-approvals-model.ts`) and written through the
 * governed doors; the mode words are the vocabulary's
 * (`resolveActionRunModeLabel`). Only the sentence under each choice is this
 * page's own.
 *
 * Framework-free so the choices are testable without React.
 */

import {
  ACTION_RUN_MODES,
  type ActionRunMode,
} from "@synap-core/types/governance-rules";
import { resolveActionRunModeLabel } from "@synap-core/types/vocabulary";
import type { EveryoneValue } from "../../../lib/governance-rules/tool-approvals-model";

export interface ActionModeChoice {
  mode: EveryoneValue;
  label: string;
  /** What it means for this action, in one sentence. */
  line: string;
  /** The pod refuses it for this action (a public post never runs on its own). */
  disabled: boolean;
}

export function isActionRunMode(v: unknown): v is ActionRunMode {
  return (ACTION_RUN_MODES as readonly unknown[]).includes(v);
}

/** A run mode, or "tool" (an action that follows its tool's row). */
export function isEveryoneValue(v: unknown): v is EveryoneValue {
  return v === "tool" || isActionRunMode(v);
}

/**
 * The choices for one action, or for the whole tool. `type` is the action's
 * own (`read` only reads; `write` and `action` change or send something), so
 * "runs on its own" says plainly when that means sending without asking. With
 * `toolMode` (an action whose tool has its own row), the first choice is "as
 * the tool", named with the tool's mode.
 */
export function actionModeChoices(input: {
  type: "read" | "write" | "action";
  mayRunOnItsOwn: boolean;
  /** For an action: its tool's own everyone mode, when the tool has a row. */
  toolMode?: ActionRunMode | null;
  /** The whole tool, not one action. */
  wholeTool?: boolean;
}): ActionModeChoice[] {
  const reads = input.type === "read";
  const it = input.wholeTool ? "its actions" : "it";
  const line: Record<ActionRunMode, string> = {
    auto: !input.mayRunOnItsOwn
      ? "It publishes in public or cannot be undone, so it always asks you first."
      : input.wholeTool
        ? "Your AIs use its actions without asking you. An action that publishes in public still asks."
        : reads
          ? "Your AIs use it without asking you. It only reads."
          : "Your AIs use it without asking you, even when it sends or changes something outside your pod.",
    ask: `Each time an AI wants to use ${it}, it asks you first.`,
    never: `Your AIs can’t use ${it}. Nothing is asked.`,
  };
  const modes: ActionModeChoice[] = ACTION_RUN_MODES.map((mode) => ({
    mode,
    label: resolveActionRunModeLabel(mode),
    line: line[mode],
    disabled: mode === "auto" && !input.mayRunOnItsOwn,
  }));
  if (!input.toolMode) return modes;
  const inherited = resolveActionRunModeLabel(input.toolMode);
  return [
    {
      mode: "tool",
      label: "Same as the tool",
      line: `It follows the whole tool: ${inherited.charAt(0).toLowerCase()}${inherited.slice(1)}.`,
      disabled: false,
    },
    ...modes,
  ];
}
