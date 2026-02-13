/**
 * Command Template Parser & Substitution
 *
 * Single source of truth: prompt_template is parsed to produce derived_inputs.
 * Supports Raycast-style placeholders: {argument name="X"}, {argument name="Y" options="a,b" default="a"}, {selection}.
 */

import type { DerivedInput } from "@synap/database/schema";

/** Formal selection context for {selection} placeholder (entities | viewRows | documents | text). */
export interface SelectionContext {
  type: "entities" | "viewRows" | "documents" | "text";
  entityIds?: string[];
  viewId?: string;
  rowEntityIds?: string[];
  documentIds?: string[];
  text?: string;
}

const ARGUMENT_REGEX =
  /\{argument\s+name\s*=\s*["']([^"']+)["'](?:\s+options\s*=\s*["']([^"']*)["'])?(?:\s+default\s*=\s*["']([^"']*)["'])?\}/gi;
const SELECTION_PLACEHOLDER = /\{selection\}/g;

export interface ParsedTemplate {
  /** Derived argument definitions from the template (parser-owned base set). */
  derivedInputs: DerivedInput[];
  /** Substitute argument values and optional selection into the template. */
  substitute(
    argumentValues: Record<string, string>,
    selectionContext?: SelectionContext | null
  ): string;
}

/**
 * Parse prompt_template and return derived_inputs + substitute function.
 * Called on command create/update to store compiled_template_ast + derived_inputs.
 */
export function parseCommandTemplate(promptTemplate: string): ParsedTemplate {
  const derivedInputs: DerivedInput[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  const re = new RegExp(ARGUMENT_REGEX.source, "gi");
  while ((m = re.exec(promptTemplate)) !== null) {
    const name = m[1];
    const optionsStr = m[2];
    const defaultVal = m[3];
    if (seen.has(name)) continue;
    seen.add(name);
    derivedInputs.push({
      name,
      label: name,
      type: "string",
      options: optionsStr
        ? optionsStr.split(",").map((s) => s.trim())
        : undefined,
      default: defaultVal ?? undefined,
    });
  }

  function substitute(
    argumentValues: Record<string, string>,
    selectionContext?: SelectionContext | null
  ): string {
    let out = promptTemplate;

    // Replace {argument name="X"} with value
    out = out.replace(ARGUMENT_REGEX, (_, name: string) => {
      return argumentValues[name] ?? "";
    });

    // Replace {selection} with serialized selection context
    if (SELECTION_PLACEHOLDER.test(out)) {
      const selectionText = formatSelectionContext(selectionContext);
      out = out.replace(SELECTION_PLACEHOLDER, selectionText);
    }

    return out;
  }

  return { derivedInputs, substitute };
}

function formatSelectionContext(ctx?: SelectionContext | null): string {
  if (!ctx) return "";
  switch (ctx.type) {
    case "text":
      return ctx.text ?? "";
    case "entities":
      return `[Entities: ${(ctx.entityIds ?? []).join(", ")}]`;
    case "viewRows":
      return `[View ${ctx.viewId ?? ""} rows: ${(ctx.rowEntityIds ?? []).join(", ")}]`;
    case "documents":
      return `[Documents: ${(ctx.documentIds ?? []).join(", ")}]`;
    default:
      return "";
  }
}

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
      if (input.default !== undefined && input.default !== "") continue;
      missing.push(input.name);
    }
  }
  return missing.length > 0 ? missing : null;
}
