/**
 * `renderText` — render a stored text (a snippet) once, filling its variables.
 *
 * The grammar is the command-template grammar (`./references.ts`), not a new
 * one, restricted to what a snippet needs:
 *
 *   {name}            filled ONLY when `name` is a declared variable; any other
 *                     identifier in braces stays exactly as written (and is
 *                     recorded), so prose braces and typos stay visible
 *   @{arg:name}       the same variable, canonical spelling
 *   {today} {now} {me} {clipboard} {selection}
 *                     the closed set of built-ins, filled from `builtins`
 *                     unless a variable of the same name is declared (the
 *                     declaration wins)
 *   @{context:text}   the context text: `builtins.selection`, else `clipboard`
 *                     (other `@{context:…}` kinds render "" and are recorded)
 *   {{anything}}      NOT ours: automation grammar, left byte for byte
 *
 * `@{entity:…}`, the legacy `{argument …}` / `{selection type=…}` forms and any
 * other braces are not part of a snippet and are left untouched.
 *
 * There is no logic here: no conditions, loops, expressions or evaluation, and
 * there never will be (an agent writes these).
 *
 * ONE PASS. The template is scanned once, left to right, and every replacement
 * is written to the output, never re-scanned. A value that itself contains
 * `{x}` (or `{{x}}`, or `@{arg:x}`) therefore reaches the output literally.
 * (`substituteTemplate` is multi-pass, as shipped; it is not used here for that
 * reason.)
 *
 * MISS POLICY. A required variable with no value and no default BLOCKS the
 * render: the result is `{ ok: false, missing }` naming every such variable,
 * and no text is produced. An optional variable with no value and no default
 * renders "" and is recorded as a miss, as is a built-in with nothing to fill
 * it and an undeclared `{name}`.
 */

import {
  REF_ARG,
  REF_BARE_ARG,
  REF_CONTEXT,
  findUnresolvedReferences,
  type UnresolvedReference,
} from "./references.js";
import type { TemplateMissKind } from "./substitute.js";

/** The closed set of built-in names. */
export const TEXT_TEMPLATE_BUILTINS = [
  "today",
  "now",
  "me",
  "clipboard",
  "selection",
] as const;

export type TextTemplateBuiltin = (typeof TEXT_TEMPLATE_BUILTINS)[number];

/** A declared variable (the part of a `PlaybookParam` rendering needs). */
export interface TextVariable {
  name: string;
  required?: boolean;
  /** Used when no value is supplied (or the value is blank). */
  default?: string;
}

export interface RenderTextInput {
  variables: readonly TextVariable[];
  /** Supplied values, by variable name. Only own keys are read. */
  values?: Readonly<Record<string, string>>;
  /** Fill for the built-ins; an absent one renders "" and is recorded. */
  builtins?: Readonly<Partial<Record<TextTemplateBuiltin, string>>>;
}

export interface TextTemplateMiss {
  name: string;
  kind: TemplateMissKind;
  /** How many times this reference missed. */
  count: number;
}

export type RenderTextResult =
  | { ok: true; text: string; misses: TextTemplateMiss[] }
  | { ok: false; missing: string[] };

/**
 * Groups: 1 = `@{arg:NAME}` name, 2 = its type token, 3 = `@{context:TYPE}`,
 * 4 = bare `{NAME}`. Built from the grammar's own patterns so the two cannot
 * drift. A `{{…}}` span needs no branch of its own: `REF_BARE_ARG`'s
 * `(?<!\{)` / `(?!\})` guards already leave `{{name}}` alone, and no other
 * form matches inside one (checked over every string of up to 6 pieces drawn
 * from `{ } @ {{ }} @{arg:x} @{context:text} x a.b` and a space: the matches
 * outside a `{{…}}` span are the same with or without such a branch).
 */
const SNIPPET_REF = new RegExp(
  `${REF_ARG.source}|${REF_CONTEXT.source}|${REF_BARE_ARG.source}`,
  "g"
);

/**
 * Blank means empty or whitespace-only: the string case of the param
 * validator's rule (`isAbsentParamValue`, `@synap/playbooks`), which this
 * package cannot import. `snippet.render` pins the two to agree.
 */
const isBlank = (v: string | undefined): boolean =>
  v === undefined || v.trim() === "";

const own = <T>(
  bag: Readonly<Record<string, T>> | undefined,
  key: string
): T | undefined =>
  bag && Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : undefined;

export function renderText(
  template: string,
  input: RenderTextInput
): RenderTextResult {
  const declared = new Map<string, TextVariable>();
  for (const v of input.variables) declared.set(v.name, v);

  // 1. Resolve each declared variable: supplied value, else default, else none.
  const resolved = new Map<string, string>();
  const missing: string[] = [];
  for (const v of declared.values()) {
    const supplied = own(input.values, v.name);
    if (!isBlank(supplied)) resolved.set(v.name, supplied!);
    else if (!isBlank(v.default)) resolved.set(v.name, v.default!);
    else if (v.required) missing.push(v.name);
  }
  if (missing.length > 0) return { ok: false, missing };

  // 2. One pass over the template; replacements are never re-scanned.
  const misses = new Map<string, TextTemplateMiss>();
  const miss = (name: string, kind: TemplateMissKind): void => {
    const key = `${kind}:${name}`;
    const hit = misses.get(key);
    if (hit) hit.count += 1;
    else misses.set(key, { name, kind, count: 1 });
  };

  const contextText = (): string =>
    own(input.builtins, "selection") ?? own(input.builtins, "clipboard") ?? "";

  const variable = (name: string): string => {
    const value = resolved.get(name);
    if (value === undefined) {
      miss(name, "unknown-arg");
      return "";
    }
    return value;
  };

  let text = "";
  let last = 0;
  for (const m of template.matchAll(SNIPPET_REF)) {
    const at = m.index ?? 0;
    text += template.slice(last, at);
    last = at + m[0].length;

    if (m[1] !== undefined) {
      // @{arg:name}: only a declared variable is a variable.
      text += declared.has(m[1])
        ? variable(m[1])
        : (miss(m[1], "unknown-arg"), "");
    } else if (m[3] !== undefined) {
      const value = m[3] === "text" ? contextText() : "";
      if (value === "") miss(`context:${m[3]}`, "unresolved-context");
      text += value;
    } else {
      const name = m[4]!;
      if (declared.has(name)) {
        text += variable(name);
      } else if ((TEXT_TEMPLATE_BUILTINS as readonly string[]).includes(name)) {
        const value = own(input.builtins, name as TextTemplateBuiltin) ?? "";
        if (value === "") miss(name, "unresolved-context");
        text += value;
      } else {
        miss(name, "literal-brace");
        text += m[0];
      }
    }
  }
  text += template.slice(last);

  return { ok: true, text, misses: [...misses.values()] };
}

/**
 * The author-time check for a snippet body: every reference `renderText` would
 * not resolve, given the declared variable names (built-ins count as declared).
 */
export function findUnresolvedTextReferences(
  template: string,
  declaredVariableNames: readonly string[]
): UnresolvedReference[] {
  return findUnresolvedReferences(template, [
    ...declaredVariableNames,
    ...TEXT_TEMPLATE_BUILTINS,
  ]);
}
