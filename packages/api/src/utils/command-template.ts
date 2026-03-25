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
 */

import type {
  DerivedInput,
  DerivedContextRef,
  DerivedStaticEntityRef,
} from "@synap/database/schema";

// ── New @{...} regexes ─────────────────────────────────────────────────────

/**
 * Matches @{arg:NAME} and @{arg:NAME:TYPE} and @{arg:NAME:choice=...}
 * Groups: 1=name, 2=full type/choice string (optional, e.g. "number", "choice=a,b,c")
 */
const NEW_ARG_REGEX_FULL = /@\{arg:([^:}\s]+)(?::([^}]*))?\}/g;

/**
 * Matches @{context:entity|view|url|text}
 * Groups: 1=contextType
 */
const NEW_CONTEXT_REGEX = /@\{context:(entity|view|url|text)\}/g;

/**
 * Matches @{entity:ENTITY_ID:DISPLAY_NAME}
 * Groups: 1=entityId, 2=displayName
 */
const NEW_STATIC_REGEX = /@\{entity:([^:}]+):([^}]*)\}/g;

// ── Legacy backward-compat regexes ────────────────────────────────────────

/**
 * Matches {argument name="X"}, {argument name="Y" options="a,b" default="a"}
 * Groups: 1=name, 2=options csv (optional), 3=default (optional)
 */
const OLD_ARG_REGEX =
  /\{argument\s+name\s*=\s*["']([^"']+)["'](?:\s+options\s*=\s*["']([^"']*)["'])?(?:\s+default\s*=\s*["']([^"']*)["'])?\}/gi;

/**
 * Matches {selection} and {selection type="viewRows"} (optional type).
 * Groups: 1=type (optional)
 */
const OLD_SELECTION_REGEX =
  /\{selection(?:\s+type\s*=\s*["'](entities|viewRows|documents|text)["'])?\}/gi;

// ── SelectionContext ──────────────────────────────────────────────────────

/** Formal selection context for {selection} placeholder. */
export interface SelectionContext {
  type: "entities" | "viewRows" | "documents" | "text";
  entityIds?: string[];
  viewId?: string;
  rowEntityIds?: string[];
  documentIds?: string[];
  text?: string;
}

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
}

// ── Helper: parse a type/options string from @{arg:NAME:...} ─────────────

function parseArgTypeToken(raw: string | undefined): {
  type: DerivedInput["type"];
  options: string[] | null;
} {
  if (!raw) return { type: "text", options: null };
  if (raw.startsWith("choice=")) {
    const csv = raw.slice("choice=".length);
    return {
      type: "choice",
      options: csv ? csv.split(",").map((s) => s.trim()) : [],
    };
  }
  switch (raw) {
    case "number":
      return { type: "number", options: null };
    case "entity":
      return { type: "entity", options: null };
    case "view":
      return { type: "view", options: null };
    case "text":
      return { type: "text", options: null };
    default:
      return { type: "text", options: null };
  }
}

// ── Main parser ───────────────────────────────────────────────────────────

/**
 * Parse prompt_template and return derived_inputs + substitute function.
 * Called on command create/update to store derived_inputs in DB.
 * Context/static refs are re-parsed at run time from the template.
 */
export function parseCommandTemplate(promptTemplate: string): ParsedTemplate {
  const derivedInputs: DerivedInput[] = [];
  const contextRefs: DerivedContextRef[] = [];
  const staticRefs: DerivedStaticEntityRef[] = [];

  const seenArgs = new Set<string>();
  const seenCtx = new Set<string>();
  const seenStatic = new Set<string>();

  // ── 1. New @{arg:NAME:type} ──────────────────────────────────────────
  {
    const re = new RegExp(NEW_ARG_REGEX_FULL.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(promptTemplate)) !== null) {
      const name = m[1]!;
      if (seenArgs.has(name)) continue;
      seenArgs.add(name);
      const { type, options } = parseArgTypeToken(m[2]);
      derivedInputs.push({ name, label: name, type, options, default: null });
    }
  }

  // ── 2. New @{context:TYPE} ───────────────────────────────────────────
  {
    const re = new RegExp(NEW_CONTEXT_REGEX.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(promptTemplate)) !== null) {
      const ctxType = m[1] as DerivedContextRef["contextType"];
      if (seenCtx.has(ctxType)) continue;
      seenCtx.add(ctxType);
      contextRefs.push({ kind: "context", contextType: ctxType });
    }
  }

  // ── 3. New @{entity:ID:NAME} ─────────────────────────────────────────
  {
    const re = new RegExp(NEW_STATIC_REGEX.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(promptTemplate)) !== null) {
      const entityId = m[1]!;
      const displayName = m[2] ?? "";
      if (seenStatic.has(entityId)) continue;
      seenStatic.add(entityId);
      staticRefs.push({ kind: "entity", entityId, displayName });
    }
  }

  // ── 4. Legacy {argument name="X"...} ────────────────────────────────
  {
    const re = new RegExp(OLD_ARG_REGEX.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(promptTemplate)) !== null) {
      const name = m[1]!;
      const optionsStr = m[2];
      const defaultVal = m[3];
      if (seenArgs.has(name)) continue;
      seenArgs.add(name);
      derivedInputs.push({
        name,
        label: name,
        type: optionsStr ? "choice" : "text",
        options: optionsStr ? optionsStr.split(",").map((s) => s.trim()) : null,
        default: defaultVal ?? null,
      });
    }
  }

  // ── 5. Legacy {selection [type="..."]} ───────────────────────────────
  {
    const re = new RegExp(OLD_SELECTION_REGEX.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(promptTemplate)) !== null) {
      // Map the legacy type onto DerivedContextRef.contextType
      const rawType = (m[1] ?? "text") as string;
      let ctxType: DerivedContextRef["contextType"];
      switch (rawType) {
        case "entities":
          ctxType = "entity";
          break;
        case "viewRows":
          ctxType = "view";
          break;
        case "documents":
          ctxType = "text";
          break;
        case "text":
          ctxType = "text";
          break;
        default:
          ctxType = "text";
          break;
      }
      if (!seenCtx.has(ctxType)) {
        seenCtx.add(ctxType);
        contextRefs.push({ kind: "context", contextType: ctxType });
      }
    }
  }

  // ── substitute ────────────────────────────────────────────────────────

  function substitute(
    argValues: Record<string, string>,
    selectionContext?: SelectionContext | null,
    resolvedEntities?: Record<string, string>,
    resolvedUrl?: string
  ): string {
    let out = promptTemplate;

    // New: @{arg:NAME[:type]}
    out = out.replace(
      new RegExp(NEW_ARG_REGEX_FULL.source, "g"),
      (_, name: string) => {
        return argValues[name] ?? "";
      }
    );

    // New: @{context:entity}
    out = out.replace(
      new RegExp(NEW_CONTEXT_REGEX.source, "g"),
      (_, ctxType: string) => {
        switch (ctxType) {
          case "entity":
            return (
              resolvedEntities?.["__context_entity"] ??
              formatSelectionContext(selectionContext)
            );
          case "view":
            return selectionContext?.viewId ?? "";
          case "url":
            return resolvedUrl ?? "";
          case "text":
            return selectionContext?.text ?? "";
          default:
            return "";
        }
      }
    );

    // New: @{entity:ID:NAME}
    out = out.replace(
      new RegExp(NEW_STATIC_REGEX.source, "g"),
      (_, entityId: string, displayName: string) => {
        return resolvedEntities?.[entityId] ?? displayName;
      }
    );

    // Legacy: {argument name="X"}
    out = out.replace(
      new RegExp(OLD_ARG_REGEX.source, "gi"),
      (_, name: string) => {
        return argValues[name] ?? "";
      }
    );

    // Legacy: {selection [type="..."]}
    out = out.replace(
      new RegExp(OLD_SELECTION_REGEX.source, "gi"),
      (_, rawType?: string) => {
        if (!selectionContext) return "";
        // If a specific type was requested in the legacy tag, honour it
        if (rawType === "text") return selectionContext.text ?? "";
        return formatSelectionContext(selectionContext);
      }
    );

    return out;
  }

  return { derivedInputs, contextRefs, staticRefs, substitute };
}

// ── formatSelectionContext ────────────────────────────────────────────────

export function formatSelectionContext(ctx?: SelectionContext | null): string {
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
