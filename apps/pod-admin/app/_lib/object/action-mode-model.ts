/**
 * How one action of a tool runs — the choice a tool's page offers under each
 * action that is on (`capability-object.tsx`): runs on its own, asks first,
 * never. The value is the pod's (`governanceRules.actionModes`), written
 * through ONE person door (`governanceRules.setActionMode`); the mode words
 * are the vocabulary's (`resolveActionRunModeLabel`). Only the sentence under
 * each choice is this page's own.
 *
 * Framework-free so the choices are testable without React.
 */

import {
  ACTION_RUN_MODES,
  type ActionRunMode,
} from "@synap-core/types/governance-rules";
import { resolveActionRunModeLabel } from "@synap-core/types/vocabulary";

export interface ActionModeChoice {
  mode: ActionRunMode;
  label: string;
  /** What it means for this action, in one sentence. */
  line: string;
  /** The pod refuses it for this action (a public post never runs on its own). */
  disabled: boolean;
}

export function isActionRunMode(v: unknown): v is ActionRunMode {
  return (ACTION_RUN_MODES as readonly unknown[]).includes(v);
}

/**
 * The three choices for one action. `type` is the action's own (`read` only
 * reads; `write` and `action` change or send something), so "runs on its own"
 * says plainly when that means sending without asking.
 */
export function actionModeChoices(input: {
  type: "read" | "write" | "action";
  mayRunOnItsOwn: boolean;
}): ActionModeChoice[] {
  const reads = input.type === "read";
  const line: Record<ActionRunMode, string> = {
    auto: !input.mayRunOnItsOwn
      ? "It publishes in public, so it always asks you first."
      : reads
        ? "Your AIs use it without asking you. It only reads."
        : "Your AIs use it without asking you, even when it sends or changes something outside your pod.",
    ask: "Each time an AI wants to use it, it asks you first.",
    never: "Your AIs can’t use it. Nothing is asked.",
  };
  return ACTION_RUN_MODES.map((mode) => ({
    mode,
    label: resolveActionRunModeLabel(mode),
    line: line[mode],
    disabled: mode === "auto" && !input.mayRunOnItsOwn,
  }));
}
