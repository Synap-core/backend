/**
 * Command Template Parser & Substitution
 *
 * Single source of truth: prompt_template is parsed to produce derived_inputs.
 *
 * NEW syntax (@{...}):
 *   @{arg:NAME}               → text argument named NAME
 *   @{arg:NAME:number}        → number argument
 *   @{arg:NAME:entity}        → entity picker argument
 *   @{arg:NAME:view}          → view picker argument
 *   @{arg:NAME:choice=a,b,c}  → segmented choice with options a, b, c
 *   @{context:entity}         → auto-inject current entity from workspace state
 *   @{context:view}           → auto-inject current view
 *   @{context:url}            → auto-inject current browser URL
 *   @{context:text}           → auto-inject selected/clipboard text
 *   @{entity:ENTITY_ID:NAME}  → static entity reference (pinned at authoring time)
 *
 * LEGACY syntax (kept for full backward compatibility):
 *   {argument name="X"}
 *   {argument name="X" options="a,b" default="a"}
 *   {selection} / {selection type="entities"}
 *
 * LEGACY-COMPAT bare form:
 *   {NAME}  → substituted ONLY when NAME is a declared argument of THIS run
 *             (i.e. an own key of the `argValues` passed to substitute()).
 *             Anything else inside braces is left byte-for-byte as written.
 *             See BARE_ARG_REGEX for the exact rule and its guards.
 *
 * MISS POLICY — every unresolved reference keeps its value (`""`, or the
 * author-time display name for a static entity) but is RECORDED via
 * `recordTemplateMiss`, so a caller that opened a diagnostics scope can see it.
 * See `template-diagnostics.ts` for why silence was the bug worth fixing.
 */

import type {
  DerivedInput,
  DerivedContextRef,
  DerivedStaticEntityRef,
} from "@synap/database/schema";
import {
  formatSelectionContext,
  parseTemplateMetadata,
  substituteTemplate,
  type SelectionContext,
} from "@synap-core/types/text-template";
import {
  TemplateMissCollector,
  recordTemplateMiss,
  withTemplateDiagnostics,
  type TemplateMiss,
} from "./template-diagnostics.js";

export {
  findUnresolvedReferences,
  type UnresolvedReference,
  type UnresolvedReferenceKind,
} from "./template-references.js";

// The grammar, the parser and the substitution live in
// `@synap-core/types/text-template`; this file is the api's door onto them
// (miss diagnostics via AsyncLocalStorage, the `ParsedTemplate` shape).
export { formatSelectionContext, type SelectionContext };

// ── ParsedTemplate ────────────────────────────────────────────────────────

export interface ParsedTemplate {
  /** Arg definitions (for DB storage in derived_inputs). */
  derivedInputs: DerivedInput[];
  /** Context refs extracted from @{context:...} placeholders. */
  contextRefs: DerivedContextRef[];
  /** Static entity refs extracted from @{entity:ID:name} placeholders. */
  staticRefs: DerivedStaticEntityRef[];

  /**
   * Substitute all placeholders in the template.
   *
   * @param argValues         – values for @{arg:NAME} / {argument name="X"}
   * @param selectionContext  – context for @{context:...} / {selection}
   * @param resolvedEntities  – entityId → formatted string for @{entity:ID:name};
   *                           also accepts "__context_entity" key for @{context:entity}
   * @param resolvedUrl       – value for @{context:url}
   */
  substitute(
    argValues: Record<string, string>,
    selectionContext?: SelectionContext | null,
    resolvedEntities?: Record<string, string>,
    resolvedUrl?: string
  ): string;

  /**
   * `substitute()` with its misses handed back instead of dropped on the floor.
   *
   * Same arguments, same resulting text — the only difference is that the
   * substitution runs inside a diagnostics scope, so a caller that wants to
   * surface "this prompt had 3 references that resolved to nothing" can,
   * without every existing caller having to change.
   */
  substituteWithMisses(
    argValues: Record<string, string>,
    selectionContext?: SelectionContext | null,
    resolvedEntities?: Record<string, string>,
    resolvedUrl?: string
  ): { text: string; misses: TemplateMiss[] };
}

/**
 * Parse prompt_template and return derived_inputs + substitute function.
 * Called on command create/update to store derived_inputs in DB.
 * Context/static refs are re-parsed at run time from the template.
 */
export function parseCommandTemplate(promptTemplate: string): ParsedTemplate {
  const { derivedInputs, contextRefs, staticRefs } =
    parseTemplateMetadata(promptTemplate);

  function substitute(
    argValues: Record<string, string>,
    selectionContext?: SelectionContext | null,
    resolvedEntities?: Record<string, string>,
    resolvedUrl?: string
  ): string {
    return substituteTemplate(
      promptTemplate,
      argValues,
      selectionContext,
      resolvedEntities,
      resolvedUrl,
      recordTemplateMiss
    );
  }

  function substituteWithMisses(
    argValues: Record<string, string>,
    selectionContext?: SelectionContext | null,
    resolvedEntities?: Record<string, string>,
    resolvedUrl?: string
  ): { text: string; misses: TemplateMiss[] } {
    const collector = new TemplateMissCollector();
    const text = withTemplateDiagnostics(collector, () =>
      substitute(argValues, selectionContext, resolvedEntities, resolvedUrl)
    );
    return { text, misses: collector.list() };
  }

  return {
    derivedInputs,
    contextRefs,
    staticRefs,
    substitute,
    substituteWithMisses,
  };
}

// ── validateArgumentValues ────────────────────────────────────────────────

/**
 * Validate that all required derived inputs have a value in argumentValues.
 * Returns missing names or null if valid.
 */
export function validateArgumentValues(
  derivedInputs: DerivedInput[],
  argumentValues: Record<string, string>
): string[] | null {
  const missing: string[] = [];
  for (const input of derivedInputs) {
    const val = argumentValues[input.name];
    if (val === undefined || val === null || String(val).trim() === "") {
      if (
        input.default !== undefined &&
        input.default !== null &&
        input.default !== ""
      )
        continue;
      missing.push(input.name);
    }
  }
  return missing.length > 0 ? missing : null;
}
