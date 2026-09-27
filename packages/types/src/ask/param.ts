/**
 * A PLAYBOOK PARAM as an ASK — the pure mapping from a declared param
 * (`PlaybookParam`, `@synap/playbooks`) to the {@link Ask} a person answers it
 * through, when a headless door started a run without it and the pod filed an
 * owed `playbook_param` slot instead (`PARAM_SLOT_KIND`).
 *
 * WHY HERE. The same declaration is rendered by the web "run this playbook"
 * form (`playbookParamsToFormSpec`, synap-app property-renderer), which maps
 * each param TYPE to a DynamicForm field kind. The owed slot must ask the SAME
 * question with the SAME control, so the type map lives in this dependency-free
 * leaf ({@link PLAYBOOK_PARAM_FIELD_TYPE}) — the web mapper holds a verbatim
 * copy today and should import this one (owed: that package is a synap-app
 * consumer of `@synap-core/types`).
 *
 * The param is taken STRUCTURALLY (`name` / `type` / `options` …) because this
 * leaf cannot depend on `@synap/playbooks` — the same arrangement the web
 * mapper uses for the same reason.
 */

import { humanizeToken } from "../vocabulary/index.js";
import { ASK_LIMITS, type Ask, type DynamicFormField } from "./index.js";

/** Mirrors `PlaybookParamType` (`@synap/playbooks`). */
export const PLAYBOOK_PARAM_TYPES = [
  "text",
  "number",
  "entity",
  "choice",
  "boolean",
] as const;
export type PlaybookParamTypeName = (typeof PLAYBOOK_PARAM_TYPES)[number];

/**
 * Param type → DynamicForm field kind. IDENTICAL to the web mapper's table
 * (`PLAYBOOK_PARAM_FIELD_TYPE` in `playbookParamsToFormSpec.ts`), and a
 * compile-time coverage floor in both directions (`satisfies Record<…>`).
 */
export const PLAYBOOK_PARAM_FIELD_TYPE = {
  text: "text",
  number: "number",
  boolean: "boolean",
  entity: "entity-link",
  choice: "enum",
} as const satisfies Record<PlaybookParamTypeName, string>;

/** The declaration, structurally — what `readPlaybookParams` produces. */
export interface PlaybookParamLike {
  name: string;
  label?: string;
  type?: string;
  options?: string[];
  description?: string;
}

/** An unknown / missing type degrades to text, like both readers do. */
export function playbookParamFieldType(type: string | undefined): string {
  return (
    PLAYBOOK_PARAM_FIELD_TYPE[type as PlaybookParamTypeName] ??
    PLAYBOOK_PARAM_FIELD_TYPE.text
  );
}

/**
 * THE ask a missing required param is owed through.
 *
 *   choice + 1..8 options → `choose` (each option is its own value; no
 *                           "Other…" — the run would refuse any other string)
 *   boolean               → `confirm` (yes / no IS the whole answer space)
 *   anything else         → `form` with ONE required field, keyed by the
 *                           param's NAME, of the mapped field kind (a choice
 *                           with > 8 options becomes an enum field; a choice
 *                           with none accepts any text, as the run does)
 */
export function playbookParamAsk(param: PlaybookParamLike): Ask {
  const label = param.label?.trim() || humanizeToken(param.name);
  const options = (param.options ?? []).filter(
    (o) => typeof o === "string" && o.length > 0
  );
  if (
    param.type === "choice" &&
    options.length > 0 &&
    options.length <= ASK_LIMITS.optionsMax &&
    options.every((o) => o.length <= ASK_LIMITS.optionValueMaxChars)
  ) {
    return {
      mode: "choose",
      options: options.map((o) => ({
        label:
          o.length > ASK_LIMITS.optionLabelMaxChars
            ? `${o.slice(0, ASK_LIMITS.optionLabelMaxChars - 1)}…`
            : o,
        value: o,
      })),
    };
  }
  if (param.type === "boolean") return { mode: "confirm" };

  const type =
    param.type === "choice" && options.length === 0
      ? PLAYBOOK_PARAM_FIELD_TYPE.text
      : playbookParamFieldType(param.type);
  const field: DynamicFormField = {
    key: param.name,
    label,
    type,
    required: true,
    ...(type === PLAYBOOK_PARAM_FIELD_TYPE.choice
      ? { constraints: { enum: options } }
      : {}),
    ...(param.description ? { help: param.description } : {}),
  };
  return { mode: "form", form: { fields: [field] } };
}
