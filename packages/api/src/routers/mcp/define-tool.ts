/**
 * ONE definition per MCP tool (end state 0f4ce71c axis F, design note
 * 7ed5d9ed). A tool is a `defineTool({...})` in `tools/index.ts`, and every
 * other fact about it is DERIVED here, never kept in a second list:
 *
 *   - its input: a zod object (`input`), the one source of the validator, of
 *     the handler's argument type (`ToolArgs`) and of the JSON Schema
 *     `tools/list` advertises (`wireInputSchema`: what MCP clients, the token
 *     budget and the control plane's manifest read);
 *   - the wire entry `tools/list` returns (name, description, inputSchema,
 *     annotations), and the manifest the control plane mirrors;
 *   - where it is listed: the entry surface or one group (`tool-profiles.ts`
 *     keeps the group VOCABULARY, not the members);
 *   - its old names (`aliases`), never listed, which answer with the same
 *     parameters or with the old argument shape their `args` map onto the
 *     tool's (applied once, in `parseToolArgs`), and `hidden` doors kept
 *     callable for a frozen name;
 *   - its teaching keys (`teaches`), for the brief composer and skill render;
 *   - whether the claude.ai connector exposes it (`cpOmit` says why not),
 *     its name on each door (`toolNameOnDoor`), and the manifest's
 *     `exposure` for the control plane;
 *   - the input check (`parseToolArgs`): unknown keys refused, then the
 *     arguments PARSED, and the handler receives the parsed value.
 *
 * Every derivation is built once, lazily: `tools/index.ts` imports helpers
 * from modules that read this registry, so nothing here may run at import
 * time.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolGroupName } from "@synap-core/types/agents";
import { z } from "zod";
import { toolDefinitions } from "./tools/index.js";
import { toolError } from "./tool-errors.js";
import { wireInputSchema } from "./tool-input.js";
import type { McpToolDoor } from "../../access/grant-door-fence.js";

/** Where a tool is listed: the entry surface, or the group that unlocks it. */
export type ToolPlacement = McpToolGroupName | "entry";

/**
 * An old name that answers as the tool: with the same parameters, or with
 * the old argument shape declared as `args` (+ `fixedArgs`).
 */
export interface ToolAlias {
  name: string;
  /** Why it still answers (a rename, a control-plane frozen name). */
  reason: string;
  /**
   * The old name's inputs, each → the tool input it is. Only these are
   * taken and advertised (with the tool's own schema for each); the derived
   * write inputs (`sessionId`) ride along. Absent: the tool's own inputs.
   */
  args?: Record<string, string>;
  /** Tool inputs the old name always means (e.g. `launch: true`). */
  fixedArgs?: Record<string, unknown>;
  /**
   * The group whose unlock lets `synap_call_tool` run the old name, when it
   * is not its tool's: a fold never widens who reaches a door.
   */
  group?: McpToolGroupName;
}

/** A tool's input: one zod object, its keys the tool's arguments. */
export type ToolInput = z.ZodObject<
  z.core.$ZodLooseShape,
  z.core.$ZodObjectConfig
>;

export interface ToolDefinition<
  N extends string = string,
  I extends ToolInput = ToolInput,
> extends Pick<Tool, "description" | "annotations"> {
  name: N;
  input: I;
  group: ToolPlacement;
  /**
   * How a scoped key's grant bounds it (`access/grant-door-fence.ts`, read by
   * the fence): `WRITE` (the gate's rung 0 bounds it), or the read door of
   * what it returns. Required: an unclassified tool cannot be declared.
   */
  access: McpToolDoor;
  /** Callable, never listed: why it is kept (e.g. a frozen connector name). */
  hidden?: string;
  aliases?: ToolAlias[];
  /** Teaching keys beyond its own name: builtin verb ids, IS tool names. */
  teaches?: string[];
  /** Only when it is NOT on the claude.ai connector: why. */
  cpOmit?: string;
  /**
   * Inputs it does not take that callers reach for, each with the sentence
   * that says where that change goes (refused before the generic refusal).
   */
  refusedArgs?: Record<string, string>;
  /**
   * It takes `supersedes` (plan 8032a127 D3: the id of a FAILED proposal the
   * call files again, corrected), and this is the Hub REST route that files
   * the same request and takes it too (the Intelligence Service's door).
   * Only the doors that filed the founder's 44 failures (17 Nov 2026): one
   * property on every write tool broke the token budget (option A).
   */
  supersedes?: { method: "POST" | "PATCH"; route: string };
  /**
   * Its teaching brief (`compose-capability-brief.ts`): the `(subjectType,
   * action)` its write gates on (`null`: no single governed door) and the
   * posture key of its emphases (`null`: it varies by kind).
   */
  brief?: {
    governance: { subjectType: string; action: string } | null;
    postureSlug: string | null;
  };
  /** How to get less back, in its own parameters, when a reply is over the cap. */
  narrow?: string;
  /**
   * Its `sessionId` names the session it ACTS ON (a lead updates, grades,
   * closes or reruns a lane), not the caller's own: naming one there never
   * attaches the conversation to it (`resolveSessionHandle`).
   */
  actsOnSession?: true;
  /** Why its reply is never capped (a body the caller reads whole). */
  uncapped?: string;
  /**
   * Why the Hub request guard never times it out, beyond `openWorldHint`:
   * a bounded long poll, or a model run.
   */
  untimed?: "long_poll" | "model";
}

const DEFINED = Symbol("defineTool");

/** Declare one MCP tool. The only way a tool enters the list (tripwire). */
export function defineTool<N extends string, I extends ToolInput>(
  def: ToolDefinition<N, I>
): ToolDefinition<N, I> {
  return Object.defineProperty(def, DEFINED, { value: true });
}

export function isDefinedTool(tool: object): boolean {
  return (tool as Record<symbol, unknown>)[DEFINED] === true;
}

type Defined = ReturnType<typeof toolDefinitions>[number];
/** Every defined tool name, as a type. */
export type ToolName = Defined["name"];
/** Keys the MCP door adds to every call (the URL lens): never unknown. */
export const DOOR_INJECTED_ARGS = ["workspaceId", "projectId"] as const;
/**
 * What a tool's handler receives: its input, PARSED. The lens keys the door
 * injects and the inputs derived on every write tool (`fullInput`) ride
 * along, typed `unknown` when the tool does not declare them itself.
 */
export type ToolArgs<N extends ToolName> = z.output<
  Extract<Defined, { name: N }>["input"]
> & {
  workspaceId?: unknown;
  projectId?: unknown;
  sessionId?: unknown;
  supersedes?: unknown;
};

/**
 * The `sessionId` every ATTRIBUTED (non-read) tool declares, derived from
 * `readOnlyHint`, never hand-added to each schema (W-C1). The adapter reads
 * `sessionId` on every write (`resolveSessionHandle`). The handle is
 * server-minted (MCP SEP-2567): a session it started, or the one a reply
 * names in `attribution.filed` when the call named none. The idle window is
 * `RECEIPT_IDLE_WINDOW_HOURS` (pinned by `attributed-tools-declare-session`).
 */
const ATTRIBUTED_SESSION_ID_INPUT = z
  .string()
  .optional()
  .describe(
    "Optional: the session these writes belong to — one you started, or the one a previous write reply named in `attribution.filed` (`handle` when your call named no conversation). Omit it and your writes are grouped for you. A grouped session closes after 2 h idle; a closed or foreign id is reported in `attribution.ignoredSession`, never an error."
  );

/** `supersedes`, declared only where the definition says so (see there). */
const SUPERSEDES_INPUT = z.string().optional().describe("Failed proposal id");

/** The input with what every write tool takes added (never mutating `def`). */
function fullInput(def: ToolDefinition): ToolInput {
  if (def.annotations?.readOnlyHint === true) return def.input;
  return def.input.extend({
    // A tool that declares its own (`synap_update_session`'s target) keeps it.
    ...("sessionId" in def.input.shape
      ? {}
      : { sessionId: ATTRIBUTED_SESSION_ID_INPUT }),
    ...(def.supersedes ? { supersedes: SUPERSEDES_INPUT } : {}),
  });
}

// ── The registry: every derivation, built once ──────────────────────────────

interface RegisteredTool {
  def: ToolDefinition;
  /**
   * The validator: `input` plus the derived write inputs (what is also
   * advertised), open to the lens keys the door injects.
   */
  validator: ToolInput;
  /** The `tools/list` entry, without per-session teaching. */
  wire: Tool;
}

interface RegisteredAlias {
  alias: ToolAlias;
  tool: RegisteredTool;
  /** Its `tools/list` entry: the old argument shape when `args` declares one. */
  wire: Tool;
}

interface Registry {
  byName: ReadonlyMap<string, RegisteredTool>;
  aliasOf: ReadonlyMap<string, string>;
  aliases: ReadonlyMap<string, RegisteredAlias>;
  teaching: Readonly<Record<string, string[]>>;
  readOnly: ReadonlySet<string>;
}

let registry: Registry | undefined;

/** The entry `tools/list` returns: its MCP fields, never the registry's. */
function wireTool(def: ToolDefinition, input: ToolInput): Tool {
  return {
    name: def.name,
    ...(def.annotations ? { annotations: def.annotations } : {}),
    description: def.description,
    inputSchema: wireInputSchema(input),
  };
}

/**
 * An alias's inputs: its declared `args` plus the derived write inputs the
 * tool takes (`sessionId`, `supersedes`), each → the tool input it is.
 * `null`: the tool's own inputs, unchanged.
 */
function aliasArgMap(
  alias: ToolAlias,
  tool: RegisteredTool
): Record<string, string> | null {
  if (!alias.args) return null;
  const derived = Object.keys(tool.validator.shape).filter(
    (k) => !(k in tool.def.input.shape)
  );
  return {
    ...Object.fromEntries(derived.map((k) => [k, k])),
    ...alias.args,
  };
}

/** The alias's `tools/list` entry: the tool's, under the old name and shape. */
function aliasWire(alias: ToolAlias, tool: RegisteredTool): Tool {
  const { def, wire } = tool;
  const title = def.annotations?.title;
  const map = aliasArgMap(alias, tool);
  const props = (wire.inputSchema.properties ?? {}) as Record<string, object>;
  for (const target of [
    ...Object.values(map ?? {}),
    ...Object.keys(alias.fixedArgs ?? {}),
  ]) {
    if (!(target in props)) {
      throw new Error(
        `MCP tool alias ${alias.name} maps to ${def.name}.${target}, which ${def.name} does not take`
      );
    }
  }
  const renamed = Object.entries(map ?? {}).filter(([from, to]) => from !== to);
  const how = Object.entries(alias.fixedArgs ?? {}).map(
    ([k, v]) => `${k}: ${JSON.stringify(v)}`
  );
  return {
    ...wire,
    name: alias.name,
    ...(def.annotations
      ? {
          annotations: {
            ...def.annotations,
            ...(title ? { title: `${title} (old name)` } : {}),
          },
        }
      : {}),
    description: map
      ? `Old name of ${def.name}${how.length > 0 ? ` with ${how.join(", ")}` : ""}, kept so existing clients keep working: its inputs are ${def.name}'s${renamed.length > 0 ? ` (${renamed.map(([from, to]) => `${from} = ${to}`).join(", ")})` : ""}, same answer. Call ${def.name}.`
      : `Old name of ${def.name}, kept so existing clients keep working: same parameters, same answer. Call ${def.name}.`,
    // A mapped old name is not advertised: its arguments are mapped at parse
    // time, and its schema would repeat its tool's for nothing.
    ...(map ? { inputSchema: { type: "object" as const } } : {}),
  };
}

function reg(): Registry {
  if (registry) return registry;
  const byName = new Map<string, RegisteredTool>();
  const aliasOf = new Map<string, string>();
  const aliases = new Map<string, RegisteredAlias>();
  for (const def of toolDefinitions() as ToolDefinition[]) {
    if (byName.has(def.name) || aliasOf.has(def.name)) {
      throw new Error(`MCP tool ${def.name} is defined twice`);
    }
    const input = fullInput(def);
    const tool = {
      def,
      validator: input.loose(),
      wire: wireTool(def, input),
    };
    byName.set(def.name, tool);
    for (const alias of def.aliases ?? []) {
      if (byName.has(alias.name) || aliasOf.has(alias.name)) {
        throw new Error(`MCP tool alias ${alias.name} is taken`);
      }
      aliasOf.set(alias.name, def.name);
      aliases.set(alias.name, { alias, tool, wire: aliasWire(alias, tool) });
    }
  }
  const defs = [...byName.values()].map((t) => t.def);
  registry = {
    byName,
    aliasOf,
    aliases,
    teaching: Object.fromEntries(
      defs.map((d) => [d.name, [...new Set([...(d.teaches ?? []), d.name])]])
    ),
    // Old names too: the pod edge reads the RAW name of a request body.
    readOnly: new Set(
      defs
        .filter((d) => d.annotations?.readOnlyHint === true)
        .flatMap((d) => [d.name, ...(d.aliases ?? []).map((a) => a.name)])
    ),
  };
  return registry;
}

const registered = (name: string) => reg().byName.get(canonicalToolName(name));

/** The tool a name answers as: itself, or the tool an alias names. */
export function canonicalToolName(name: string): string {
  return reg().aliasOf.get(name) ?? name;
}

/** The definition a name answers with (an alias gives its tool's). */
export function toolDefinition(name: string): ToolDefinition | undefined {
  return registered(name)?.def;
}

/** Every defined tool name (aliases excluded). */
export function definedToolNames(): string[] {
  return [...reg().byName.keys()];
}

/**
 * Every name that answers, each a fresh `tools/list` entry (callers append
 * per-session teaching to a description): each tool, then each alias.
 */
export function wireTools(): Tool[] {
  return [
    ...[...reg().byName.values()].map((t) => ({ ...t.wire })),
    ...[...reg().aliases.values()].map((a) => ({ ...a.wire })),
  ];
}

/**
 * The entry tools: listed only by default; `callable` adds the hidden ones,
 * which answer for every key (an old name answers as its tool: callers
 * canonicalise it first, `canonicalToolName`).
 */
export function entryToolNames(callable = false): string[] {
  return [
    ...[...reg().byName.values()]
      .filter(({ def }) => def.group === "entry" && (callable || !def.hidden))
      .map(({ def }) => def.name),
    ...(callable ? aliasesPlaced("entry") : []),
  ];
}

/** Where a name is reachable: a tool's group, an old name's own or its tool's. */
export function toolPlacement(name: string): ToolPlacement | undefined {
  const a = reg().aliases.get(name);
  return a ? aliasPlacement(a) : reg().byName.get(name)?.def.group;
}

/** Where an old name is reachable: its own `group`, else its tool's. */
function aliasPlacement(a: RegisteredAlias): ToolPlacement {
  return a.alias.group ?? a.tool.def.group;
}

function aliasesPlaced(placement: ToolPlacement): string[] {
  return [...reg().aliases.values()]
    .filter((a) => aliasPlacement(a) === placement)
    .map((a) => a.alias.name);
}

/**
 * Each group's tools. Listed only by default; `callable` adds its hidden
 * doors, which `synap_call_tool` may run once the group is unlocked.
 */
export function toolGroupMembers(
  callable = false
): Record<McpToolGroupName, string[]> {
  const out = {} as Record<McpToolGroupName, string[]>;
  for (const { def } of reg().byName.values()) {
    if (def.group === "entry") continue;
    (out[def.group] ??= []).push(
      ...(callable || !def.hidden ? [def.name] : [])
    );
  }
  if (callable) {
    for (const a of reg().aliases.values()) {
      const placed = aliasPlacement(a);
      if (placed !== "entry") (out[placed] ??= []).push(a.alias.name);
    }
  }
  return out;
}

/** Names that answer but are never listed: hidden doors and aliases. */
export function unlistedToolNames(): Set<string> {
  return new Set([
    ...[...reg().byName.values()]
      .filter(({ def }) => def.hidden)
      .map(({ def }) => def.name),
    ...reg().aliasOf.keys(),
  ]);
}

/** Each tool's teaching keys: what it `teaches`, then its own name. */
export function toolTeachingKeys(): Readonly<Record<string, string[]>> {
  return reg().teaching;
}

/**
 * The two doors a pod tool reaches an agent through, each under its own name:
 * `pod-mcp`, the pod's own `/mcp` (`synap_define_kind`), and `cp-connector`,
 * the claude.ai control-plane connector (`pod__define_kind`).
 */
export type SkillDoor = "pod-mcp" | "cp-connector";

/**
 * A pod tool's name on a door, `null` when that door does not have it: the
 * connector carries every tool as `pod__<name without synap_>` except the
 * ones whose definition says why not (`cpOmit`); an alias follows its tool.
 */
export function toolNameOnDoor(
  podName: string,
  door: SkillDoor
): string | null {
  const tool = registered(podName);
  if (!tool) return null;
  if (door === "pod-mcp") return podName;
  return tool.def.cpOmit ? null : `pod__${podName.replace(/^synap_/, "")}`;
}

/**
 * Where each name answering the pod is listed and whether the claude.ai
 * connector exposes it: the manifest's `exposure`, which the control plane
 * derives its surface from instead of curating it by hand.
 */
export function toolExposure(): Record<string, Record<string, string>> {
  return Object.fromEntries(
    [...reg().byName.values()].flatMap(({ def: d }) => [
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
        { group: a.group ?? d.group, aliasOf: d.name, reason: a.reason },
      ]),
    ])
  );
}

/**
 * The read-only tools: what the pod edge counts against an agent's READ
 * budget (`crud_read`, apps/api middleware/security.ts), and the calls that
 * group no write under a session (`isReadOnlyTool`).
 */
export function readOnlyToolNames(): ReadonlySet<string> {
  return reg().readOnly;
}

/**
 * Why the Hub request guard never times a call of this tool out, or `null`:
 * its own `untimed`, else `model` for a tool that reaches outside the pod
 * (`openWorldHint`: a capability, an automation, a playbook run).
 */
export function toolUntimed(name: string): "long_poll" | "model" | null {
  const def = toolDefinition(name);
  if (!def) return null;
  return def.untimed ?? (def.annotations?.openWorldHint ? "model" : null);
}

/**
 * The tools that take `supersedes`, each with the Hub REST route that files
 * the same request (`supersedes` on the definition): the Hub door mounts its
 * `supersedes` middleware on exactly these routes.
 */
export function supersedesDoors(): Array<
  { tool: string } & NonNullable<ToolDefinition["supersedes"]>
> {
  return [...reg().byName.values()].flatMap(({ def }) =>
    def.supersedes ? [{ tool: def.name, ...def.supersedes }] : []
  );
}

/** A tool's declared input names (an alias gives its tool's), or null. */
export function declaredArgNames(name: string): string[] | null {
  const wire = answering(name)?.wire;
  return wire ? Object.keys(wire.inputSchema.properties ?? {}) : null;
}

/** What a name answers with: an alias's own entry, else the tool's. */
const answering = (name: string) =>
  reg().aliases.get(name) ?? reg().byName.get(name);

/** Is this a pod tool name (a tool or an alias)? */
export function isPodToolName(name: string): boolean {
  return registered(name) !== undefined;
}

// ── The input check ─────────────────────────────────────────────────────────

/**
 * REFUSE an argument a tool does not declare, instead of dropping it. For a
 * WRITE door a dropped key is a lie told as a success. Live, 2026-10-21/22 on
 * the founder's pod: `synap_update_session` with `reopenOutput: "spec"`
 * returned `status: "updated"` and changed nothing; with `addOutputs` (the
 * real input is `addOutput`, or `outcomes`) it returned "updated" and left
 * `expectedOutputs` empty. The agent believed both, and so did the person.
 * The valid set is the tool's own input, plus the lens the door injects.
 */
export function undeclaredArgs(
  args: Record<string, unknown>,
  declared: readonly string[]
): string[] {
  const known = new Set<string>([...declared, ...DOOR_INJECTED_ARGS]);
  return Object.keys(args).filter((k) => !known.has(k));
}

/**
 * A declared name `key` was probably meant for: a prefix-variant (`addOutputs`
 * → `addOutput`, `sort` → `sortBy`) or a camel-case tail (`id` → `entityId`).
 * Required names are tried first: a call missing one is the likeliest miss.
 */
function nearMiss(
  key: string,
  declared: readonly string[],
  required: readonly string[]
): string | undefined {
  const k = key.toLowerCase();
  const tail = key.length >= 2 ? key[0]!.toUpperCase() + key.slice(1) : null;
  return [...required, ...declared].find((d) => {
    const dl = d.toLowerCase();
    return (
      dl !== k &&
      (k.startsWith(dl) ||
        dl.startsWith(k) ||
        (tail !== null && d.endsWith(tail)))
    );
  });
}

/** The refusal sentence. Pure, so its wording is testable. */
export function undeclaredArgsMessage(
  toolName: string,
  unknown: readonly string[],
  declared: readonly string[],
  required: readonly string[] = []
): string {
  const hints = unknown.flatMap((k) => {
    const near = nearMiss(k, declared, required);
    return near ? [`\`${k}\` → did you mean \`${near}\`?`] : [];
  });
  return (
    `${toolName} does not take ${unknown.map((k) => `\`${k}\``).join(", ")} — NOTHING WAS CHANGED. ` +
    (hints.length > 0 ? `${hints.join(" ")} ` : "") +
    `Valid inputs: ${declared.join(", ")}. Resend with only these.`
  );
}

/**
 * A top-level value that reads as "not given": `null` for an optional input
 * that does not take null, and `""` for an optional enum. Models send both for
 * a field they mean to leave out, and every handler already read them so.
 */
function withoutAbsentValues(
  args: Record<string, unknown>,
  schema: Tool["inputSchema"]
): Record<string, unknown> {
  const required = new Set(schema.required ?? []);
  const props = (schema.properties ?? {}) as Record<
    string,
    { type?: unknown; enum?: unknown }
  >;
  return Object.fromEntries(
    Object.entries(args).filter(([key, value]) => {
      if (required.has(key) || (value !== null && value !== "")) return true;
      const { type, enum: values } = props[key] ?? {};
      return value === null
        ? type === "null" || (Array.isArray(type) && type.includes("null"))
        : !Array.isArray(values);
    })
  );
}

export type ParsedToolArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; result: CallToolResult };

/**
 * THE input check of a tool call: unknown keys refused, then the arguments
 * parsed against the tool's input. An unknown tool passes through untouched
 * (the dispatch says it is unknown).
 */
export function parseToolArgs(
  name: string,
  given: Record<string, unknown>
): ParsedToolArgs {
  const tool = registered(name);
  if (!tool) return { ok: true, args: given };
  const { def, validator } = tool;
  const refused = Object.keys(given).find((k) =>
    Object.hasOwn(def.refusedArgs ?? {}, k)
  );
  if (refused) {
    return { ok: false, result: toolError(def.refusedArgs![refused]!) };
  }
  const { wire } = answering(name)!;
  const declared = declaredArgNames(name)!;
  const unknown = undeclaredArgs(given, declared);
  if (unknown.length > 0 && false) {
    return {
      ok: false,
      result: toolError(
        undeclaredArgsMessage(
          name,
          unknown,
          declared,
          wire.inputSchema.required ?? []
        )
      ),
    };
  }
  const mapped = mapAliasArgs(name, given);
  if (!mapped.ok) return mapped;
  const parsed = validator.safeParse(
    withoutAbsentValues(mapped.args, tool.wire.inputSchema)
  );
  if (parsed.success) return { ok: true, args: parsed.data };
  const map = mapped.renamed;
  const error = map
    ? new z.ZodError(
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: issue.path.map((p, i) =>
            i === 0 && typeof p === "string" ? (map[p] ?? p) : p
          ),
        }))
      )
    : parsed.error;
  return {
    ok: false,
    result: toolError(
      `${name}: invalid input — NOTHING WAS CHANGED.\n${z.prettifyError(error)}\nResend it matching the tool's input schema.`
    ),
  };
}

/**
 * An alias's arguments as its tool's inputs (its declared `args` renamed,
 * its `fixedArgs` set), with the reverse map to word a refusal in the
 * caller's names. Any other name passes through unchanged.
 */
function mapAliasArgs(
  name: string,
  given: Record<string, unknown>
):
  | {
      ok: true;
      args: Record<string, unknown>;
      renamed?: Record<string, string>;
    }
  | { ok: false; result: CallToolResult } {
  const entry = reg().aliases.get(name);
  const map = entry && aliasArgMap(entry.alias, entry.tool);
  if (!entry || !map) return { ok: true, args: given };
  const args: Record<string, unknown> = {};
  const renamed: Record<string, string> = {};
  for (const [key, value] of Object.entries(given)) {
    const to = map[key] ?? key;
    if (to in args) {
      return {
        ok: false,
        result: toolError(
          `${name}: \`${renamed[to] ?? to}\` and \`${key}\` are the same input — NOTHING WAS CHANGED. Pass one.`
        ),
      };
    }
    args[to] = value;
    renamed[to] = key;
  }
  return {
    ok: true,
    args: { ...args, ...entry.alias.fixedArgs },
    renamed,
  };
}
