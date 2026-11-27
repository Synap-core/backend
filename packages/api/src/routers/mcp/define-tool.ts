/**
 * ONE definition per MCP tool (end state 0f4ce71c axis F, design note
 * 7ed5d9ed). A tool is a `defineTool({...})` in `tools/index.ts`, and every
 * other fact about it is DERIVED here, never kept in a second list:
 *
 *   - the wire entry `tools/list` returns (name, description, inputSchema,
 *     annotations), and the manifest the control plane mirrors;
 *   - where it is listed: the entry surface or one group (`tool-profiles.ts`
 *     keeps the group VOCABULARY, not the members);
 *   - its old names (`aliases`), which answer with the same parameters and are
 *     never listed, and `hidden` doors kept callable for a frozen name;
 *   - its teaching keys (`teaches`), for the brief composer and skill render;
 *   - whether the claude.ai connector exposes it (`cpOmit` says why not),
 *     published in the manifest's `exposure` for the control plane;
 *   - the input check: unknown keys refused (`undeclared-args.ts`), then the
 *     arguments PARSED against the declared schema, and the handler receives
 *     the parsed value.
 *
 * The input stays JSON Schema, the format MCP advertises, the token budget
 * measures and the control plane copies verbatim; the validator is compiled
 * from it (`z.fromJSONSchema`), so the two cannot disagree.
 *
 * Every derivation is lazy: `tools/index.ts` imports helpers from modules that
 * read this registry, so nothing here may run at import time.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolGroupName } from "@synap-core/types/agents";
import { z } from "zod";
import { toolDefinitions } from "./tools/index.js";
import { toolError } from "./tool-errors.js";
import { refuseUndeclaredArgs } from "./undeclared-args.js";
import { SUPERSEDES_TOOLS } from "./supersedes-tools.js";
import type { SkillDoor } from "./door-tool-names.build.js";
import { DOOR_TOOL_NAMES } from "./door-tool-names.generated.js";

/** Where a tool is listed: the entry surface, or the group that unlocks it. */
export type ToolPlacement = McpToolGroupName | "entry";

/** An old name that answers as the tool, with the same parameters. */
export interface ToolAlias {
  name: string;
  /** Why it still answers (a rename, a control-plane frozen name). */
  reason: string;
}

export interface ToolDefinition extends Tool {
  group: ToolPlacement;
  /** Callable, never listed: why it is kept (e.g. a frozen connector name). */
  hidden?: string;
  aliases?: readonly ToolAlias[];
  /** Teaching keys beyond its own name: builtin verb ids, IS tool names. */
  teaches?: readonly string[];
  /** Only when it is NOT on the claude.ai connector: why. */
  cpOmit?: string;
  /**
   * Inputs it does not take that callers reach for, each with the sentence
   * that says where that change goes (refused before the generic refusal).
   */
  refusedArgs?: Readonly<Record<string, string>>;
}

const DEFINED = Symbol("defineTool");

/** Declare one MCP tool. The only way a tool enters the list (tripwire). */
export function defineTool(def: ToolDefinition): ToolDefinition {
  return Object.defineProperty(def, DEFINED, { value: true });
}

export function isDefinedTool(tool: object): boolean {
  return (tool as Record<symbol, unknown>)[DEFINED] === true;
}

/**
 * The `sessionId` every ATTRIBUTED (non-read) tool declares, derived from
 * `readOnlyHint`, never hand-added to each schema (W-C1). The adapter reads
 * `sessionId` on every write (`resolveSessionHandle`). The handle is
 * server-minted (MCP SEP-2567): a session it started, or the one a reply
 * names in `attribution.filed` when the call named none. The idle window is
 * `RECEIPT_IDLE_WINDOW_HOURS` (pinned by `attributed-tools-declare-session`).
 */
const ATTRIBUTED_SESSION_ID_PARAM = {
  type: "string",
  description:
    "Optional: the session these writes belong to — one you started, or the one a previous write reply named in `attribution.filed` (`handle` when your call named no conversation). Omit it and your writes are grouped for you. A grouped session closes after 2 h idle; a closed or foreign id is reported in `attribution.ignoredSession`, never an error.",
} as const;

/** `supersedes`, declared on {@link SUPERSEDES_TOOLS} only (see there). */
const SUPERSEDES_PARAM = {
  type: "string",
  description: "Failed proposal id",
} as const;

/** A definition with the inputs every write tool takes added to its schema. */
function withDerivedInputs(def: ToolDefinition): ToolDefinition {
  if (def.annotations?.readOnlyHint === true) return def;
  const properties = def.inputSchema.properties ?? {};
  def.inputSchema = {
    ...def.inputSchema,
    properties: {
      ...properties,
      // A tool that declares its own (`synap_update_session`'s target) keeps it.
      ...("sessionId" in properties
        ? {}
        : { sessionId: ATTRIBUTED_SESSION_ID_PARAM }),
      ...(SUPERSEDES_TOOLS.includes(def.name)
        ? { supersedes: SUPERSEDES_PARAM }
        : {}),
    },
  };
  return def;
}

/** Every tool's definition, complete, freshly built (callers may mutate it). */
export function definedTools(): ToolDefinition[] {
  return toolDefinitions().map(withDerivedInputs);
}

/** The entry `tools/list` returns: the definition minus its registry fields. */
export function wireTool(def: ToolDefinition): Tool {
  const {
    group: _group,
    hidden: _hidden,
    aliases: _aliases,
    teaches: _teaches,
    cpOmit: _cpOmit,
    refusedArgs: _refusedArgs,
    ...wire
  } = def;
  return wire;
}

/** An alias's wire entry: its tool's entry under the old name. */
function aliasWireTool(def: ToolDefinition, alias: ToolAlias): Tool {
  const title = def.annotations?.title;
  return {
    ...wireTool(def),
    name: alias.name,
    ...(def.annotations
      ? {
          annotations: {
            ...def.annotations,
            ...(title ? { title: `${title} (old name)` } : {}),
          },
        }
      : {}),
    description: `Old name of ${def.name}, kept so existing clients keep working: same parameters, same answer. Call ${def.name}.`,
  };
}

/** Every name that answers: each tool, then each alias. */
export function wireTools(defs: readonly ToolDefinition[]): Tool[] {
  return [
    ...defs.map(wireTool),
    ...defs.flatMap((d) => (d.aliases ?? []).map((a) => aliasWireTool(d, a))),
  ];
}

interface Registry {
  byName: ReadonlyMap<string, ToolDefinition>;
  aliasOf: ReadonlyMap<string, string>;
}

let registry: Registry | undefined;

function reg(): Registry {
  if (registry) return registry;
  const byName = new Map<string, ToolDefinition>();
  const aliasOf = new Map<string, string>();
  for (const def of definedTools()) {
    if (byName.has(def.name) || aliasOf.has(def.name)) {
      throw new Error(`MCP tool ${def.name} is defined twice`);
    }
    byName.set(def.name, def);
    for (const alias of def.aliases ?? []) {
      if (byName.has(alias.name) || aliasOf.has(alias.name)) {
        throw new Error(`MCP tool alias ${alias.name} is taken`);
      }
      aliasOf.set(alias.name, def.name);
    }
  }
  registry = { byName, aliasOf };
  return registry;
}

/** The tool a name answers as: itself, or the tool an alias names. */
export function canonicalToolName(name: string): string {
  return reg().aliasOf.get(name) ?? name;
}

/** The definition a name answers with (an alias gives its tool's). */
export function toolDefinition(name: string): ToolDefinition | undefined {
  return reg().byName.get(canonicalToolName(name));
}

/** Every defined tool name (aliases excluded). */
export function definedToolNames(): string[] {
  return [...reg().byName.keys()];
}

/** The listed entry tools. */
export function entryToolNames(): string[] {
  return [...reg().byName.values()]
    .filter((d) => d.group === "entry" && !d.hidden)
    .map((d) => d.name);
}

/**
 * Each group's tools. Listed only by default; `callable` adds every other
 * name that answers in the group (hidden doors, old names), which
 * `synap_call_tool` may run once the group is unlocked.
 */
export function toolGroupMembers(
  callable = false
): Record<McpToolGroupName, string[]> {
  const out = {} as Record<McpToolGroupName, string[]>;
  for (const def of reg().byName.values()) {
    if (def.group === "entry") continue;
    const names = callable
      ? [def.name, ...(def.aliases ?? []).map((a) => a.name)]
      : def.hidden
        ? []
        : [def.name];
    (out[def.group] ??= []).push(...names);
  }
  return out;
}

/** Names that answer but are never listed: hidden doors and aliases. */
export function unlistedToolNames(): Set<string> {
  return new Set([
    ...[...reg().byName.values()].filter((d) => d.hidden).map((d) => d.name),
    ...reg().aliasOf.keys(),
  ]);
}

/** Each tool's teaching keys: what it `teaches`, then its own name. */
export function toolTeachingKeys(): Readonly<Record<string, string[]>> {
  return Object.fromEntries(
    [...reg().byName.values()].map((d) => [
      d.name,
      [...new Set([...(d.teaches ?? []), d.name])],
    ])
  );
}

export type { SkillDoor };

/**
 * A pod tool's name on a door, `null` when that door does not have it. The
 * connector's set is still curated in the control plane and mirrored here
 * (`door-tool-names.generated.ts`) until its generator derives the set from
 * each definition's `cpOmit` (the manifest's `exposure`); then this reads the
 * definition and the mirror goes.
 */
export function toolNameOnDoor(
  podName: string,
  door: SkillDoor
): string | null {
  return DOOR_TOOL_NAMES[podName]?.[door] ?? null;
}

/**
 * Where each name answering the pod is listed and whether the claude.ai
 * connector exposes it: the manifest's `exposure`, which the control plane
 * derives its surface from instead of curating it by hand.
 */
export function toolExposure(): Record<string, Record<string, string>> {
  return Object.fromEntries(
    definedTools().flatMap((d) => [
      [
        d.name,
        {
          group: d.group,
          ...(d.hidden ? { hidden: d.hidden } : {}),
          ...(d.cpOmit ? { cpOmit: d.cpOmit } : {}),
        },
      ],
      ...(d.aliases ?? []).map((a) => [
        a.name,
        { group: d.group, aliasOf: d.name, reason: a.reason },
      ]),
    ])
  );
}

/** Every name (aliases too) whose definition declares `hint: true`. */
function namesWithHint(hint: "readOnlyHint" | "openWorldHint"): Set<string> {
  return new Set(
    [...reg().byName.values()]
      .filter((d) => d.annotations?.[hint] === true)
      .flatMap((d) => [d.name, ...(d.aliases ?? []).map((a) => a.name)])
  );
}

/**
 * The read-only tools: what the pod edge counts against an agent's READ
 * budget (`crud_read`, apps/api middleware/security.ts), and the calls that
 * group no write under a session (`isReadOnlyTool`).
 */
export async function readOnlyToolNames(): Promise<Set<string>> {
  return namesWithHint("readOnlyHint");
}

/**
 * The tools that reach outside the pod (a capability, an automation, a
 * playbook run): the Hub request guard never times them out.
 */
export async function openWorldToolNames(): Promise<Set<string>> {
  return namesWithHint("openWorldHint");
}

/** Is this a pod tool name (a tool or an alias)? */
export function isPodToolName(name: string): boolean {
  return toolDefinition(name) !== undefined;
}

// ── The input check ─────────────────────────────────────────────────────────

/**
 * The schema the validator is compiled from: the advertised one minus what a
 * check must not do. `default` is dropped (a handler keeps its own defaults
 * and tells absent from given); `format` is dropped (the handlers and the
 * uuid door already check ids and urls with their own wording). Nested
 * objects stay open: their keys are data (an entity's `properties`), and an
 * unknown top-level key is refused by `refuseUndeclaredArgs` with a better
 * sentence than a schema error.
 */
function validationSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(validationSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "default" || key === "format" || key === "description") {
      continue;
    }
    out[key] =
      key === "properties" && value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, validationSchema(v)])
          )
        : validationSchema(value);
  }
  const isObject =
    out.type === "object" ||
    (Array.isArray(out.type) && out.type.includes("object"));
  if (isObject && out.additionalProperties === undefined) {
    out.additionalProperties = true;
  }
  return out;
}

const validators = new Map<string, z.ZodType>();

/** The tool's validator, compiled once from its declared input schema. */
export function inputValidator(def: ToolDefinition): z.ZodType {
  let v = validators.get(def.name);
  if (!v) {
    v = z.fromJSONSchema(
      validationSchema(def.inputSchema) as Parameters<
        typeof z.fromJSONSchema
      >[0]
    );
    validators.set(def.name, v);
  }
  return v;
}

/**
 * A top-level `null` for an optional input that does not take null reads as
 * "not given": models send it for a field they mean to leave out, and every
 * handler already treated it so.
 */
function withoutNullOptionals(
  args: Record<string, unknown>,
  schema: Tool["inputSchema"]
): Record<string, unknown> {
  const required = new Set(schema.required ?? []);
  const props = (schema.properties ?? {}) as Record<
    string,
    { type?: unknown }
  >;
  return Object.fromEntries(
    Object.entries(args).filter(([key, value]) => {
      if (value !== null || required.has(key)) return true;
      const type = props[key]?.type;
      return type === "null" || (Array.isArray(type) && type.includes("null"));
    })
  );
}

export type ParsedToolArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; result: CallToolResult };

/**
 * THE input check of a tool call: unknown keys refused, then the arguments
 * parsed against the tool's schema. An unknown tool passes through untouched
 * (the dispatch says it is unknown).
 */
export async function parseToolArgs(
  name: string,
  args: Record<string, unknown>
): Promise<ParsedToolArgs> {
  const def = toolDefinition(name);
  if (!def) return { ok: true, args };
  const refused = Object.keys(args).find((k) =>
    Object.hasOwn(def.refusedArgs ?? {}, k)
  );
  if (refused) {
    return { ok: false, result: toolError(def.refusedArgs![refused]!) };
  }
  const undeclared = await refuseUndeclaredArgs(name, args);
  if (undeclared) return { ok: false, result: undeclared };
  const parsed = inputValidator(def).safeParse(
    withoutNullOptionals(args, def.inputSchema)
  );
  if (parsed.success) {
    return { ok: true, args: parsed.data as Record<string, unknown> };
  }
  return {
    ok: false,
    result: toolError(
      `${name}: invalid input — NOTHING WAS CHANGED.\n${z.prettifyError(parsed.error)}\nResend it matching the tool's input schema.`
    ),
  };
}
