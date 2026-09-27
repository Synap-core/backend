/**
 * The OWED SLOT a missing required param becomes on a session — ONE shape for
 * every door that mints it: `createFocusSession` (a template's params, or a
 * TRACK's method params passed by `startStageSession`), the
 * `focus_session/create` approval executor (the same track params, re-read at
 * approval), the run funnel (`instantiateSessionRow`) and `followPlaybook`.
 * Each passes its own `circumstance` sentence; the shape is shared.
 *
 * The slot carries the param's typed ASK (`playbookParamAsk`,
 * `@synap-core/types/ask` — the same type map the web run form uses) and its
 * machine name (`paramName`), so answering it through the ONE answer door
 * writes the value into `metadata.params` ({@link paramValueFromAnswer}).
 */

import type {
  ExpectedOutput,
  PlaybookParam,
  PlaybookParamType,
  SlotAnswerValue,
} from "@synap/playbooks";
import {
  validatePlaybookParams,
  describeParamTypeError,
} from "@synap/playbooks";
import { PARAM_SLOT_KIND } from "@synap-core/types/focus-sessions";
import { isCredentialFieldName, playbookParamAsk } from "@synap-core/types/ask";

/** How the run came to be without the value — the `why`'s last sentence. */
export const PARAM_SLOT_CIRCUMSTANCE = {
  started: "Nobody supplied it when this session was started.",
  run: "Nobody supplied it, so the run started without it.",
  followed: "Nobody supplied it when this session began following it.",
} as const;

export function paramOwedSlots(
  missing: readonly PlaybookParam[],
  /** What needs the value — the playbook's or the track's name. */
  sourceName: string,
  owedAt: string,
  circumstance: string = PARAM_SLOT_CIRCUMSTANCE.started
): ExpectedOutput[] {
  return missing.map((p) => {
    const ask = playbookParamAsk(p);
    return {
      kind: PARAM_SLOT_KIND,
      label: `Answer: ${p.label?.trim() || p.name}`,
      owner: "human" as const,
      // `decision` is the honest blocker: there is nothing to BUILD to remove
      // it (no credential to mint, no rule to write, no tool to install) — a
      // person has to choose a value. See BLOCKED_REASONS.
      blockedReason: "decision" as const,
      why: `"${sourceName}" needs a value for "${p.label?.trim() || p.name}"${
        p.options?.length
          ? ` (one of ${p.options.map((o) => `"${o}"`).join(", ")})`
          : ` (${p.type})`
      }. ${circumstance}`,
      owedSince: owedAt,
      paramName: p.name,
      ...(ask ? { ask } : {}),
    };
  });
}

/**
 * The param type a param slot's ASK was minted from — the inverse of
 * `playbookParamAsk`, so the answer is coerced by the SAME rule the run
 * funnel applies (`validatePlaybookParams`) without re-reading the playbook
 * (a track's params live on its pinned snapshot, a follow's on the playbook).
 */
function paramTypeOfAsk(ask: ExpectedOutput["ask"]): {
  type: PlaybookParamType;
  options?: string[];
} {
  if (ask?.mode === "confirm") return { type: "boolean" };
  if (ask?.mode === "choose") {
    return {
      type: "choice",
      options: ask.options.map((o) => o.value ?? o.label),
    };
  }
  const field = ask?.mode === "form" ? ask.form.fields[0] : undefined;
  switch (field?.type) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "entity-link":
      return { type: "entity" };
    case "enum":
      return { type: "choice", options: field.constraints?.enum ?? [] };
    default:
      return { type: "text" };
  }
}

export type ParamAnswer =
  | { status: "none" }
  | { status: "value"; name: string; value: unknown }
  | { status: "invalid"; message: string };

/**
 * The value an answer writes into `metadata.params`, for a param slot. Pure.
 *
 * `none` — not a param slot, or one filed before `paramName` existed: the
 * answer is recorded as words and writes no param. `invalid` — the answer
 * cannot be read as the param's type (the answer door refuses it before
 * anything is posted).
 */
export function paramValueFromAnswer(
  slot: ExpectedOutput,
  value: SlotAnswerValue | undefined,
  text: string
): ParamAnswer {
  if (slot.kind !== PARAM_SLOT_KIND || !slot.paramName)
    return { status: "none" };
  const name = slot.paramName;
  // A credential param has no ask (`playbookParamAsk` → null): typing the
  // secret here would store it as words in the slot, the room and the params.
  if (isCredentialFieldName(name)) {
    return {
      status: "invalid",
      message: `"${name}" is a secret. Set it on the run, not in an answer.`,
    };
  }
  let raw: unknown;
  if (!value || value.type === "text") raw = text;
  else if (value.type === "confirm") raw = value.confirmed;
  else if (value.type === "chip") raw = value.chip.value ?? value.chip.label;
  else if (value.type === "form") raw = value.values[name];
  else return { status: "none" };

  const resolution = validatePlaybookParams(
    [{ name, required: true, ...paramTypeOfAsk(slot.ask) }],
    { [name]: raw }
  );
  if (resolution.typeErrors.length > 0) {
    return {
      status: "invalid",
      message: resolution.typeErrors.map(describeParamTypeError).join(" "),
    };
  }
  if (!(name in resolution.declaredValues)) {
    return { status: "invalid", message: `"${name}" needs a value.` };
  }
  return { status: "value", name, value: resolution.declaredValues[name] };
}
