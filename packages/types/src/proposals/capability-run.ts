/**
 * CAPABILITY-RUN TITLES — what a proposal to run a core ENTITY verb is called.
 *
 * A proposal to run `entity.delete` used to be titled "Run entity.delete": the
 * reviewer saw a tool id and nothing about WHICH object it would delete — the
 * target lived only in `parameters.entityId` (observed 2026-09-28, nine GRP
 * question retirements that all read the same). A run of a core entity verb is
 * not "running a tool" from the reviewer's point of view; it IS the action on
 * the object, so it is titled like one: `Delete Question "GRP #3: Numbers"`.
 *
 * ONE rule, three readers: the pod's write-time summary
 * (`describeCapabilityRun`), the pod's read-time re-derivation for rows filed
 * before this existed (`enrichProposalsForDisplay`), and the review card's
 * title (`useProposalPresentation`, browser + relay). Every word goes through
 * the vocabulary door (`buildObjectActionTitle`) — no label table here.
 *
 * PURE and dependency-free at runtime, published as its own LEAF subpath
 * (`@synap-core/types/proposals/capability-run`) for the same reason as
 * `./intent` and `./attention`: the `./proposals` barrel is not Hermes-safe.
 */

import {
  buildObjectActionTitle,
  isKnownToolName,
  resolveActionLabel,
  resolveObjectNoun,
  resolveToolLabel,
} from "../vocabulary/index.js";
import { formatFieldLabel } from "../property-render/field-label.js";

/**
 * Verbs of the shape `entity.<action>` that act on ONE existing entity named by
 * `parameters.entityId`. `create` (no entity yet) and `query` (a read, never
 * proposed as an action on an object) are not.
 */
const ENTITY_VERB = /^entity\.([a-z][a-z_]*)$/;
const NOT_AN_OBJECT_ACTION = new Set(["create", "query"]);
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EntityVerbRunTarget {
  /** The action token (`delete`, `update`, …) — resolved by the vocabulary. */
  action: string;
  /** The entity the run acts on (`parameters.entityId`). */
  entityId: string;
}

/**
 * The (action, entity) a capability run acts on, or `null` when this run is
 * not a core entity verb on one existing entity.
 */
export function entityVerbRunTarget(
  verbId: string | null | undefined,
  parameters: Record<string, unknown> | null | undefined
): EntityVerbRunTarget | null {
  if (typeof verbId !== "string") return null;
  const m = ENTITY_VERB.exec(verbId);
  if (!m || NOT_AN_OBJECT_ACTION.has(m[1]!)) return null;
  const entityId = parameters?.entityId;
  if (typeof entityId !== "string" || !UUID_SHAPE.test(entityId)) return null;
  return { action: m[1]!, entityId };
}

/** What the reviewer is allowed to know about the target — both optional. */
export interface EntityVerbRunSubject {
  /** The entity's kind (profile slug), e.g. `question`. */
  kind?: string | null;
  /** The entity's display name, ALREADY floored to what the reader may see. */
  name?: string | null;
}

/**
 * `Delete Question "GRP #3: Numbers"`; `Delete Question` when the name is not
 * visible; `Delete entity` when nothing about the target is. Never the raw id.
 */
export function describeEntityVerbRun(
  action: string,
  subject?: EntityVerbRunSubject | null
): string {
  const kind = subject?.kind?.trim() || null;
  const name = subject?.name?.trim() || null;
  if (!kind && !name) {
    return `${resolveActionLabel(action, "imperative")} ${resolveObjectNoun(
      "entity"
    ).toLowerCase()}`;
  }
  return buildObjectActionTitle({
    action,
    objectKind: kind ?? "entity",
    objectName: name,
  });
}

/**
 * True when a stored summary is exactly the generated tool-id shape
 * (`Run <verbId>`) the pod wrote before this rule existed. Only THAT string is
 * ever re-derived — a summary a person or agent wrote is never rewritten.
 */
export function isGeneratedCapabilityRunSummary(
  summary: string | null | undefined,
  verbId: string | null | undefined
): boolean {
  return typeof verbId === "string" && summary === `Run ${verbId}`;
}

/**
 * The run's reason, when the caller put it where a run has room for one: the
 * run door takes no top-level `reasoning`, so agents pass it inside
 * `parameters`. Hoisted so the reviewer reads WHY without opening the payload.
 */
export function capabilityRunReasoning(
  parameters: Record<string, unknown> | null | undefined
): string | undefined {
  const r = parameters?.reasoning;
  return typeof r === "string" && r.trim() ? r.trim() : undefined;
}

// ── What a tool run SENDS ───────────────────────────────────────────────────
//
// Founder dogfood (2026-10-30, proposal 4b5e040e, `hcloud_create_server`): the
// review read "Run Tool", then a card "Untitled · Skill ID · Parameters: Name,
// Image, Location, User data, Server type" — the names of the arguments, never
// their values. Nobody can approve creating a server without seeing which
// server. A run is reviewed as the CALL it makes: the action and the tool in
// the heading, then each argument with what the agent put in it.

/** One argument of a tool run, as the reviewer reads it. */
export interface ProposalToolRunParameter {
  /** The key the agent passed (`serverType`). */
  key: string;
  /** The schema's `title`, else the key in words ("Server type"). */
  label: string;
  /** What the verb's schema says the argument is, when it says. */
  description?: string;
  /** The value the agent passed, whole. Absent when `secret`. */
  value?: unknown;
  /** The argument names a credential: its value never leaves the pod. */
  secret?: true;
}

/**
 * A `capability.run` as the call it makes (`ProposalReviewModel.toolRun`):
 * WHAT it does, THROUGH which tool, WITH which arguments.
 */
export interface ProposalToolRun {
  /** The action in words, imperative: "Create server". */
  action: string;
  /** The tool(s) it runs through, in words ("Hetzner cloud"); absent = none readable. */
  tool?: string;
  /** The verb's own description, when it has one. */
  description?: string;
  /**
   * Every argument: the ones the verb declares first, then the rest. Within
   * each group, the stored order (jsonb sorts object keys, so neither the
   * schema's nor the agent's own order survives a stored row).
   */
  parameters: ProposalToolRunParameter[];
}

/**
 * A verb's name as the action it performs, never the vendor-prefixed id:
 * `hcloud_create_server` → "Create server" (the longest tail the tool door
 * knows), `apify.run_actor` → "Run actor"; a name with no known tail reads
 * whole ("Hcloud create server"), through the same door.
 */
export function toolRunActionLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (isKnownToolName(trimmed)) return resolveToolLabel(trimmed, "imperative");
  const parts = trimmed.split(/[._]/).filter(Boolean);
  for (let i = 1; i < parts.length; i += 1) {
    const tail = parts.slice(i).join("_");
    if (isKnownToolName(tail)) return resolveToolLabel(tail, "imperative");
  }
  return resolveToolLabel(trimmed, "imperative");
}

interface DeclaredParameter {
  key: string;
  title?: string;
  description?: string;
  secret: boolean;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The arguments a verb declares, in order, from either dialect of
 * `skills.parameters`: JSON Schema (`{type:"object", properties}`, the same
 * discrimination as the run door's `looksLikeJsonSchema`) or the shorthand
 * type map (`{ name: "string", tags: "string[]?" }`).
 */
export function declaredToolParameters(schema: unknown): DeclaredParameter[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const bag = schema as Record<string, unknown>;
  const isJsonSchema =
    bag.type === "object" &&
    !!bag.properties &&
    typeof bag.properties === "object" &&
    !Array.isArray(bag.properties);
  const entries = Object.entries(
    isJsonSchema ? (bag.properties as Record<string, unknown>) : bag
  );
  return entries.map(([key, raw]) => {
    const prop =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    return {
      key,
      title: text(prop.title),
      description: text(prop.description),
      secret: prop.format === "password" || prop.writeOnly === true,
    };
  });
}

export interface ToolRunInput {
  /** The verb the run calls (`data.verbId`). */
  verbId: string | null;
  /** The skill's own name, when the viewer can read it. */
  skillName?: string | null;
  skillDescription?: string | null;
  /** The skill's `parameters` schema, when the viewer can read it. */
  schema?: unknown;
  /** The tools it declares (`skill → requires → tool`), already in words. */
  toolNames?: readonly string[];
  /** The arguments the agent passed (`data.parameters`). */
  parameters: Record<string, unknown> | null | undefined;
  /** A name that reads as a credential (the pod's one heuristic). */
  isSecretName: (key: string) => boolean;
}

/**
 * The call a run makes, or `null` when there is no verb to name. `reasoning`
 * is the agent's WHY, hoisted to the review's own line
 * (`capabilityRunReasoning`), so it is not an argument here.
 */
export function describeToolRun(input: ToolRunInput): ProposalToolRun | null {
  const name = text(input.skillName) ?? text(input.verbId);
  if (!name) return null;
  const passed = input.parameters ?? {};
  const declared = declaredToolParameters(input.schema);
  const byKey = new Map(declared.map((d) => [d.key, d]));
  const keys = [
    ...declared.map((d) => d.key).filter((k) => k in passed),
    ...Object.keys(passed).filter((k) => !byKey.has(k)),
  ].filter((k) => k !== "reasoning");
  const parameters = keys.map((key): ProposalToolRunParameter => {
    const d = byKey.get(key);
    const secret = d?.secret === true || input.isSecretName(key);
    return {
      key,
      label: d?.title ?? formatFieldLabel(key),
      ...(d?.description ? { description: d.description } : {}),
      ...(secret ? { secret: true as const } : { value: passed[key] }),
    };
  });
  const tools = [...new Set((input.toolNames ?? []).filter(Boolean))];
  const description = text(input.skillDescription);
  return {
    action: toolRunActionLabel(name),
    ...(tools.length > 0 ? { tool: tools.join(", ") } : {}),
    ...(description ? { description } : {}),
    parameters,
  };
}
