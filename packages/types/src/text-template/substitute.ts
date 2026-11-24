/**
 * The pure core of command-template parsing and substitution.
 *
 * MOVED here from `packages/api/src/utils/command-template.ts` so the grammar
 * has ONE implementation every runtime can import. Behaviour is byte-identical
 * to what shipped there: the same passes in the same order, the same miss
 * policy. The ONE change is that a miss is handed to an `onMiss` callback
 * instead of the api's AsyncLocalStorage collector (`node:async_hooks` is not
 * available in the browser or on Hermes). The api door
 * (`command-template.ts`) passes `recordTemplateMiss` as that callback.
 *
 * NOTE this is a MULTI-PASS substituter: a value inserted by an earlier pass is
 * seen by the later passes. That is the shipped behaviour of `resolveGoal` and
 * `intelligence.runCommand` and is kept as is. Code that must keep a value
 * literal (a snippet) uses `renderText` (./render.ts), which is single-pass.
 */

import {
  REF_ARG,
  REF_BARE_ARG,
  REF_CONTEXT,
  REF_ENTITY,
  REF_LEGACY_ARG,
  REF_LEGACY_SELECTION,
} from "./references.js";

/** Why a reference produced nothing (see api `template-diagnostics.ts`). */
export type TemplateMissKind =
  "unknown-arg" | "unresolved-context" | "unresolved-entity" | "literal-brace";

/** Receives every unresolved reference; must never throw. */
export type TemplateMissSink = (name: string, kind: TemplateMissKind) => void;

/** A user-provided argument collected at run time. */
export interface TemplateDerivedInput {
  name: string;
  label?: string | null;
  type?: "text" | "number" | "entity" | "view" | "choice" | null;
  options?: string[] | null;
  default?: string | null;
}

/** A context reference extracted from `@{context:...}` placeholders. */
export interface TemplateContextRef {
  kind: "context";
  contextType: "entity" | "view" | "url" | "text";
}

/** A static entity reference pinned at authoring time via `@{entity:ID:name}`. */
export interface TemplateStaticEntityRef {
  kind: "entity";
  entityId: string;
  displayName: string;
}

/** Formal selection context for the `{selection}` placeholder. */
export interface SelectionContext {
  type: "entities" | "viewRows" | "documents" | "text";
  entityIds?: string[];
  viewId?: string;
  rowEntityIds?: string[];
  documentIds?: string[];
  text?: string;
}

export interface TemplateMetadata {
  derivedInputs: TemplateDerivedInput[];
  contextRefs: TemplateContextRef[];
  staticRefs: TemplateStaticEntityRef[];
}

const NEW_ARG_REGEX_FULL = new RegExp(REF_ARG.source, "g");
const NEW_CONTEXT_REGEX = new RegExp(REF_CONTEXT.source, "g");
const NEW_STATIC_REGEX = new RegExp(REF_ENTITY.source, "g");
const OLD_ARG_REGEX = new RegExp(REF_LEGACY_ARG.source, "gi");
const OLD_SELECTION_REGEX = new RegExp(REF_LEGACY_SELECTION.source, "gi");
const BARE_ARG_REGEX = REF_BARE_ARG;

function parseArgTypeToken(raw: string | undefined): {
  type: TemplateDerivedInput["type"];
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

/** Parse a template into its derived inputs and context / static refs. */
export function parseTemplateMetadata(
  promptTemplate: string
): TemplateMetadata {
  const derivedInputs: TemplateDerivedInput[] = [];
  const contextRefs: TemplateContextRef[] = [];
  const staticRefs: TemplateStaticEntityRef[] = [];

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
      const ctxType = m[1] as TemplateContextRef["contextType"];
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
      // Map the legacy type onto TemplateContextRef.contextType
      const rawType = (m[1] ?? "text") as string;
      let ctxType: TemplateContextRef["contextType"];
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

  return { derivedInputs, contextRefs, staticRefs };
}

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

/**
 * Substitute every placeholder in `promptTemplate`. Every unresolved reference
 * keeps its value (`""`, or the author-time display name for a static entity)
 * and is reported to `onMiss`.
 */
export function substituteTemplate(
  promptTemplate: string,
  argValues: Record<string, string>,
  selectionContext: SelectionContext | null | undefined,
  resolvedEntities: Record<string, string> | undefined,
  resolvedUrl: string | undefined,
  onMiss: TemplateMissSink
): string {
  let out = promptTemplate;

  /** Own-key lookup: `constructor`/`toString` must never resolve. */
  const declared = (name: string): boolean =>
    Object.prototype.hasOwnProperty.call(argValues, name);

  // New: @{arg:NAME[:type]}
  out = out.replace(
    new RegExp(NEW_ARG_REGEX_FULL.source, "g"),
    (_, name: string) => {
      // Return BEFORE reading: `argValues[name]` walks the prototype chain, so
      // an undeclared `constructor` / `toString` / `__proto__` would resolve to
      // V8 source text (never nullish, so `??` never fires) and inject it into
      // the prompt. The own-key guard has to gate the read, not just the miss.
      if (!declared(name)) {
        onMiss(name, "unknown-arg");
        return "";
      }
      return argValues[name] ?? "";
    }
  );

  // New: @{context:entity}
  out = out.replace(
    new RegExp(NEW_CONTEXT_REGEX.source, "g"),
    (_, ctxType: string) => {
      const resolved = ((): string => {
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
      })();
      if (resolved === "") onMiss(`context:${ctxType}`, "unresolved-context");
      return resolved;
    }
  );

  // New: @{entity:ID:NAME}
  out = out.replace(
    new RegExp(NEW_STATIC_REGEX.source, "g"),
    (_, entityId: string, displayName: string) => {
      const resolved = resolvedEntities?.[entityId];
      // Falling back to the author-time label is not nothing, but it IS stale.
      if (resolved === undefined) onMiss(entityId, "unresolved-entity");
      return resolved ?? displayName;
    }
  );

  // Legacy: {argument name="X"}
  out = out.replace(
    new RegExp(OLD_ARG_REGEX.source, "gi"),
    (_, name: string) => {
      // Same own-key guard as the canonical form above.
      if (!declared(name)) {
        onMiss(name, "unknown-arg");
        return "";
      }
      return argValues[name] ?? "";
    }
  );

  // Legacy: {selection [type="..."]}
  out = out.replace(
    new RegExp(OLD_SELECTION_REGEX.source, "gi"),
    (_, rawType?: string) => {
      if (!selectionContext) {
        onMiss("selection", "unresolved-context");
        return "";
      }
      // If a specific type was requested in the legacy tag, honour it
      if (rawType === "text") return selectionContext.text ?? "";
      return formatSelectionContext(selectionContext);
    }
  );

  // Legacy-compat: bare {NAME} — LAST, so canonical syntax always wins.
  // An undeclared name is returned byte-for-byte, so nothing that works
  // today can change meaning; it is only recorded.
  out = out.replace(
    new RegExp(BARE_ARG_REGEX.source, "g"),
    (whole: string, name: string) => {
      if (!declared(name)) {
        onMiss(name, "literal-brace");
        return whole;
      }
      return argValues[name] ?? "";
    }
  );

  return out;
}
