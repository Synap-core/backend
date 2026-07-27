/**
 * Command-template REFERENCE GRAMMAR — the shapes `substitute()` recognises,
 * and the author-time check for the ones it will not resolve.
 *
 * ⚠️ TWO COPIES ON PURPOSE, BOUND BYTE-FOR-BYTE BY A TEST.
 * This file exists twice and the two copies are IDENTICAL:
 *   - synap-backend/packages/api/src/utils/template-references.ts  (runtime)
 *   - synap-app/packages/core/command-template/src/unresolved.ts   (authoring)
 * The authoring surfaces (PromptTemplateEditor, the playbooks app) run in the
 * browser and cannot import across the repo boundary — synap-backend is not a
 * dependency of synap-app and vice versa — so a shared module is not reachable
 * today. `template-references.drift.test.ts` in the backend api package reads
 * both files and asserts they are byte-identical, in the style of
 * `validate-flow.ts` ↔ `validate-flow.drift.test.ts`. Edit one, and the test
 * tells you to edit the other. Do not "improve" one copy in place.
 *
 * Keeping this file DEPENDENCY-FREE (no imports, no DB types, no comment that
 * names one side) is what makes a byte comparison — the strongest available
 * binding — possible.
 */

// ── The forms the substituter resolves ────────────────────────────────────

/**
 * `@{arg:NAME}` / `@{arg:NAME:type}` / `@{arg:NAME:choice=a,b}`. Group 1 = name.
 *
 * The name and type classes exclude `{` and `@` as well as `:}` and whitespace.
 * WHY: without `{`, a MALFORMED `@{arg:tone` scans forward to the next `}`
 * anywhere in the template — so `"@{arg:tone{{trigger.payload.prompt}} rest"`
 * matched across the `{{…}}` and substituted to `"} rest"`, silently deleting a
 * grammar-#3 DAG binding. Excluding `{` makes a malformed opener fail to match
 * and stay literal, which is the honest outcome.
 */
export const REF_ARG = /@\{arg:([^:}{@\s]+)(?::([^}{]*))?\}/;

/** `@{context:entity|view|url|text}`. Group 1 = context type. */
export const REF_CONTEXT = /@\{context:(entity|view|url|text)\}/;

/**
 * `@{entity:ENTITY_ID:DISPLAY_NAME}`. Groups: 1 = id, 2 = display name.
 * Classes exclude `{` for the same reason as `REF_ARG` — a malformed opener
 * must not scan across a `{{…}}` binding.
 */
export const REF_ENTITY = /@\{entity:([^:}{]+):([^}{]*)\}/;

/** Legacy `{argument name="X" [options="a,b"] [default="a"]}`. Group 1 = name. */
export const REF_LEGACY_ARG =
  /\{argument\s+name\s*=\s*["']([^"']+)["'](?:\s+options\s*=\s*["']([^"']*)["'])?(?:\s+default\s*=\s*["']([^"']*)["'])?\}/i;

/** Legacy `{selection}` / `{selection type="entities"}`. Group 1 = type. */
export const REF_LEGACY_SELECTION =
  /\{selection(?:\s+type\s*=\s*["'](entities|viewRows|documents|text)["'])?\}/i;

/**
 * Matches a BARE `{name}` placeholder. Group 1 = name.
 *
 * WHY — every playbook goal in the live pod writes `{competitor}` / `{focus}`,
 * which no rule above matches, so the literal placeholder reached the model.
 * This rule makes those work with no data migration.
 *
 * It is deliberately the narrowest rule in the grammar. Three guards, each of
 * which a test pins:
 *
 *  1. `[A-Za-z_][A-Za-z0-9_]*` — a bare identifier only. No spaces, quotes,
 *     dots, colons or braces, so `{argument name="x"}`, `{"json": 1}`,
 *     `{a.b}` and prose like `{see below}` can never match.
 *  2. `(?<!\{)` / `(?!\})` — never eat one side of a grammar-#3 `{{path}}`.
 *     `{{focus}}` is an automation-DAG binding and belongs to a different
 *     resolver; it must survive this pass untouched.
 *  3. The name must be a DECLARED argument. At run time that means an own key
 *     of `argValues`; at author time it means a member of `declaredParamNames`
 *     below. An identifier that was not declared is left exactly as written,
 *     which is the behaviour that shipped before this rule existed.
 *
 * NOTE this pattern is deliberately NOT used to derive `derived_inputs`:
 * that column is persisted and gates `validateArgumentValues`, so minting
 * inputs from prose braces would start REJECTING runs that work today. Bare
 * names are a substitution-time compatibility shim, not a declaration form.
 */
export const REF_BARE_ARG = /(?<!\{)\{([A-Za-z_][A-Za-z0-9_]*)\}(?!\})/;

// ── findUnresolvedReferences ──────────────────────────────────────────────

/**
 * Why the substituter will not resolve a reference.
 *  - `unknown-arg`  — it IS an argument reference, but the name is not
 *    declared. Renders as `""` (canonical/legacy forms) or as literal text
 *    (bare form). Nearly always a typo or a rename.
 *  - `unsupported`  — braced text no rule in the grammar matches at all
 *    (`{a.b}`, `{see below}`). Reaches the model verbatim.
 */
export type UnresolvedReferenceKind = "unknown-arg" | "unsupported";

export interface UnresolvedReference {
  /** The reference exactly as written, braces included. */
  text: string;
  kind: UnresolvedReferenceKind;
}

/**
 * The author-time / CI half of the miss policy: every reference in `template`
 * that `substitute()` would NOT resolve, given `declaredParamNames`.
 *
 * Method (proven by the prototype in the playbooks app): mask each supported
 * form in turn, checking declared-ness as we go; whatever is still inside
 * braces afterwards is unsupported. Masking with spaces of equal length keeps
 * every subsequent pattern's offsets valid.
 *
 * `{{path}}` is grammar #3 (the automation DAG) and is masked and IGNORED — it
 * is resolved by a different engine and is not this grammar's business.
 *
 * Pure, dependency-free, ordering-stable: safe in a Zod `.refine()`, in a live
 * editor keystroke handler, and in a CI sweep over checked-in templates.
 */
export function findUnresolvedReferences(
  template: string,
  declaredParamNames: string[]
): UnresolvedReference[] {
  const declared = new Set(declaredParamNames);
  const found: UnresolvedReference[] = [];
  const seen = new Set<string>();

  const push = (text: string, kind: UnresolvedReferenceKind): void => {
    const key = `${kind}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ text, kind });
  };

  const blank = (m: string): string => " ".repeat(m.length);

  let masked = template;

  // Grammar #3 `{{path}}` — not ours. Mask first so no later rule sees it.
  masked = masked.replace(/\{\{[^{}]*\}\}/g, blank);

  // Context and static-entity forms resolve from runtime state, never from
  // declared params — nothing to check, just take them out of the way. FIRST,
  // because `{selection}` is a bare identifier and the bare rule below would
  // otherwise claim it as an undeclared argument.
  for (const pat of [REF_CONTEXT, REF_ENTITY, REF_LEGACY_SELECTION]) {
    masked = masked.replace(
      new RegExp(pat.source, pat.flags.includes("i") ? "gi" : "g"),
      blank
    );
  }

  // Argument-bearing forms: unresolved when the name is not declared.
  for (const pat of [REF_ARG, REF_LEGACY_ARG, REF_BARE_ARG]) {
    masked = masked.replace(
      new RegExp(pat.source, pat.flags.includes("i") ? "gi" : "g"),
      (whole: string, name: string) => {
        if (!declared.has(name)) push(whole, "unknown-arg");
        return blank(whole);
      }
    );
  }

  // Anything still braced matches no rule at all.
  for (const m of masked.matchAll(/\{([^{}]*)\}/g)) {
    const inner = m[1]!.trim();
    if (inner === "") continue;
    push(`{${inner}}`, "unsupported");
  }

  return found;
}
