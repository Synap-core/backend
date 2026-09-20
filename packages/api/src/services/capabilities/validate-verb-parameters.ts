/**
 * ARGUMENT VALIDATION AT THE PROPOSE MOMENT — check the call against the verb's
 * DECLARED schema before a human is asked to approve it.
 *
 * THE DEFECT. `entity.delete` was called with `{"entityIds":[…]}` — plural, a
 * field the verb does not declare — and the gate filed proposal
 * `81417965-cf1d-456c-8149-d747ba9115fb` with no complaint. Nothing between the
 * caller and the review queue reads the arguments: the gate reasons about WHO
 * and WHAT KIND, never about the payload, and the handler's own
 * `entityDeleteParams.parse(params)` runs only on APPROVAL. So the reviewer
 * spends their approval on a call whose validity is unknown, and learns it was
 * malformed after saying yes. (Parameter Mismatch is the single largest
 * tool-failure class at 42%.)
 *
 * THE SCHEMA IS NOT A NEW TABLE. Both sources here are the ones that already
 * exist and are already asserted to agree with the catalog:
 *   - builtin verbs → `BUILTIN_VERB_PARAM_SCHEMAS` (`builtin-verbs.ts`), the
 *     handler's OWN Zod schema and the SSOT the `catalog-schema-coherence`
 *     tripwire holds the advertised catalog against. Validating against the
 *     HANDLER (not the catalog projection) is deliberate: where the two are
 *     known to disagree today — `market.install` accepts `projectId`/
 *     `projectName` without advertising them, which is why that tripwire is
 *     RED — validating against the catalog would REJECT a call the handler
 *     accepts. A false rejection is worse than the miss it fixes.
 *   - every other verb → `skills.parameters`, which IS the catalog's
 *     `ToolVerbCatalogEntry.argsSchema` (`deriveToolVerbs` copies it verbatim).
 *
 * ABSENT SCHEMA MEANS "CANNOT VALIDATE", NEVER "NO ARGUMENTS ALLOWED". A verb
 * that declares nothing — and a declared shape this module does not understand
 * — returns `unvalidated`, and the call proceeds exactly as it does today.
 * Honest-unknown; never a false rejection.
 *
 * UNKNOWN KEYS ARE REPORTED, NOT REJECTED. `missing` and `wrongType` mean the
 * call CANNOT work. An extra key is usually harmless (a Zod object strips it;
 * a declarative verb ignores it), and the two sources are known to be narrower
 * than reality in at least one live case, so rejecting on `unknown` alone would
 * refuse calls that work today. It rides in the repair payload so the caller
 * can still see and fix it.
 */

import { z } from "zod";
import { BUILTIN_VERB_PARAM_SCHEMAS } from "./builtin-verbs.js";

/** What the caller must change, machine-readable. */
export interface ParameterRepair {
  /** Declared, required, and absent from the call. */
  missing: string[];
  /** Present but the wrong type — `field → { expected, received }`. */
  wrongType: Record<string, { expected: string; received: string }>;
  /** Passed but not declared. Informational — never a rejection on its own. */
  unknown: string[];
}

export type VerbParameterCheck =
  /**
   * No schema this module can read → proceed exactly as before.
   *
   * TWO DISTINCT REASONS, deliberately not collapsed:
   *  - `no_declared_schema` — the verb declares nothing. Nothing to check.
   *  - `unreadable_dialect` — a schema EXISTS but is in a form this module does
   *    not parse (today: JSON Schema, where we read the shorthand type map).
   *    Folding it into the first would report "this verb has no schema" about a
   *    verb that has one, and that lie would later read as "nothing to fix".
   */
  | {
      status: "unvalidated";
      reason: "no_declared_schema" | "unreadable_dialect";
    }
  /** Checked and usable. `unknown` may still be non-empty. */
  | { status: "ok"; unknown: string[] }
  /** Checked and NOT usable — the call cannot succeed as written. */
  | { status: "invalid"; repair: ParameterRepair };

/** The runtime type name a declared type-map string is compared against. */
function runtimeTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * The type-map dialect `skills.parameters` is written in — the same one the IS
 * `buildZodSchema` reads: `{ field: "string" | "number?" | "array" | … }`, where
 * a trailing `?` marks the field optional. Measured over the 78 skills in the
 * Control Plane's capability templates: 63 declare a type map, 15 declare
 * nothing; no other dialect occurs. A value this set does not contain makes
 * that ONE FIELD unverifiable — never the whole call.
 */
const KNOWN_DECLARED_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "object",
  "array",
]);

/**
 * Is this bag JSON Schema rather than the shorthand type map?
 *
 * DISCRIMINATE ON `properties`, NOT ON `type`. A type map may legitimately
 * declare a FIELD named `type` — `exa_search` does (`"type": "string?"`) — so
 * keying on `type` alone would misread a real type map as a schema. Only the
 * pairing of `type: "object"` with a `properties` OBJECT identifies the
 * dialect.
 */
function looksLikeJsonSchema(declared: Record<string, unknown>): boolean {
  return (
    declared.type === "object" &&
    typeof declared.properties === "object" &&
    declared.properties !== null &&
    !Array.isArray(declared.properties)
  );
}

function checkTypeMap(
  declared: Record<string, unknown>,
  params: Record<string, unknown>
): VerbParameterCheck {
  // WRONG DIALECT → `unvalidated`, never a rejection.
  //
  // Read as a type map, a JSON-Schema bag `{type:"object", properties, required}`
  // reports the KEY `type` (whose value "object" is a known type name, with no
  // `?` suffix) as a MISSING REQUIRED ARGUMENT, and dumps every real argument
  // into `unknown`. The repair text is then nonsense and the verb becomes
  // permanently uncallable through the governed path.
  //
  // This is not hypothetical: `find-intent` advertises `argsSchema` to agents
  // as "the verb's declared arg schema", and that column holds JSON Schema for
  // agent-authored declarative verbs (`create-declarative-verb.ts` types
  // `parameters?: unknown` and copies it verbatim — no dialect enforcement).
  // So the two dialects already coexist, and an agent obeying what we
  // advertised would have been refused for it.
  //
  // Shipped CP templates are clean today (63 type-map, 15 none, 0 JSON-Schema),
  // which is why this was latent rather than live. Honouring the module's own
  // rule — "a false rejection is worse than the miss it fixes" — we decline to
  // judge instead of guessing.
  if (looksLikeJsonSchema(declared)) {
    return { status: "unvalidated", reason: "unreadable_dialect" };
  }

  const repair: ParameterRepair = { missing: [], wrongType: {}, unknown: [] };
  let checkedSomething = false;

  for (const [field, rawType] of Object.entries(declared)) {
    if (typeof rawType !== "string") continue; // not this dialect → skip field
    const optional = rawType.endsWith("?");
    const type = optional ? rawType.slice(0, -1) : rawType;
    // A declared type outside the dialect means we are not sure we are reading
    // this declaration correctly, so the field is skipped ENTIRELY — not even
    // its requiredness is enforced. Requiredness IS readable from the `?`
    // suffix alone, but acting on half a declaration we do not understand is
    // how a false rejection happens, and a miss is the cheaper error here.
    // (Found by this module's own test: `{weird:"date"}` absent was being
    // reported as a missing required argument.)
    if (!KNOWN_DECLARED_TYPES.has(type)) continue;
    const value = params[field];
    if (value === undefined) {
      if (!optional) repair.missing.push(field);
      checkedSomething = true;
      continue;
    }
    checkedSomething = true;
    const received = runtimeTypeOf(value);
    const matches =
      type === "object"
        ? received === "object"
        : type === "array"
          ? received === "array"
          : received === type;
    if (!matches) repair.wrongType[field] = { expected: type, received };
  }

  if (!checkedSomething) {
    return { status: "unvalidated", reason: "no_declared_schema" };
  }
  repair.unknown = Object.keys(params).filter((k) => !(k in declared));
  return repair.missing.length || Object.keys(repair.wrongType).length
    ? { status: "invalid", repair }
    : { status: "ok", unknown: repair.unknown };
}

function checkZodObject(
  schema: z.ZodObject<z.ZodRawShape>,
  params: Record<string, unknown>
): VerbParameterCheck {
  const shape = schema.shape;
  const parsed = schema.safeParse(params);
  const unknown = Object.keys(params).filter((k) => !(k in shape));
  if (parsed.success) return { status: "ok", unknown };

  const repair: ParameterRepair = { missing: [], wrongType: {}, unknown };
  for (const issue of parsed.error.issues) {
    const path = issue.path.map(String).join(".");
    if (!path) continue; // a whole-object issue names no field to repair
    // MISSING is derived from the INPUT, not from the issue text. Zod 4's
    // `invalid_type` issue carries `expected` but no `received` (verified
    // against the installed 4.3.6), so "expected string, received undefined"
    // is prose, not a field. The value at the path is the fact.
    const present = path
      .split(".")
      .reduce<unknown>(
        (acc, key) =>
          acc && typeof acc === "object"
            ? (acc as Record<string, unknown>)[key]
            : undefined,
        params
      );
    if (present === undefined) {
      if (!repair.missing.includes(path)) repair.missing.push(path);
      continue;
    }
    repair.wrongType[path] = {
      // `expected` for a type mismatch; the FORMAT name for a format failure
      // (`invalid_format` + `format:"uuid"` is how Zod 4 reports a bad uuid —
      // "uuid" is the repairable word, "invalid_format" is not); the code as a
      // last resort.
      expected:
        "expected" in issue && typeof issue.expected === "string"
          ? issue.expected
          : "format" in issue && typeof issue.format === "string"
            ? issue.format
            : issue.code,
      received: runtimeTypeOf(present),
    };
  }
  // Zod rejected the call, but every issue landed on the object itself (no
  // field path) — we cannot say WHAT to repair, so we do not claim to.
  if (!repair.missing.length && !Object.keys(repair.wrongType).length) {
    return { status: "unvalidated", reason: "no_declared_schema" };
  }
  return { status: "invalid", repair };
}

/**
 * Check a call's `parameters` against the verb's declared schema.
 *
 * @param skill  the resolved skill row — `kind` selects the schema SOURCE and
 *               `parameters` carries the declaration for a non-builtin verb.
 */
export function checkVerbParameters(
  skill: {
    kind: string | null;
    name: string;
    parameters?: unknown;
  },
  parameters: Record<string, unknown> | undefined
): VerbParameterCheck {
  const params = parameters ?? {};

  if (skill.kind === "builtin") {
    const schema = BUILTIN_VERB_PARAM_SCHEMAS[skill.name];
    // A builtin with no registered schema (e.g. `feed.read`, which parses
    // inline) is unvalidatable HERE — the same honest-unknown as any other.
    if (!schema) return { status: "unvalidated", reason: "no_declared_schema" };
    return checkZodObject(
      schema as unknown as z.ZodObject<z.ZodRawShape>,
      params
    );
  }

  const declared = skill.parameters;
  if (
    !declared ||
    typeof declared !== "object" ||
    Array.isArray(declared) ||
    Object.keys(declared as Record<string, unknown>).length === 0
  ) {
    return { status: "unvalidated", reason: "no_declared_schema" };
  }
  return checkTypeMap(declared as Record<string, unknown>, params);
}

/** The human half of the repair error — one sentence the agent can act on. */
export function describeParameterRepair(
  verbLabel: string,
  repair: ParameterRepair
): string {
  const parts: string[] = [];
  if (repair.missing.length) {
    parts.push(`missing required ${repair.missing.join(", ")}`);
  }
  for (const [field, t] of Object.entries(repair.wrongType)) {
    parts.push(`${field} should be ${t.expected}, got ${t.received}`);
  }
  if (repair.unknown.length) {
    parts.push(
      `unknown argument${repair.unknown.length > 1 ? "s" : ""} ${repair.unknown.join(", ")}`
    );
  }
  return (
    `${verbLabel} was called with arguments that do not match its declared ` +
    `schema (${parts.join("; ")}). Nothing was proposed or run — fix the ` +
    `arguments and call it again.`
  );
}
