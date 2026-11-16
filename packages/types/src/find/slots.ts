/**
 * The slot vocabularies a selection can fill, read as pure data: which
 * parameters of a verb take pod files, which fields of an intent's input take
 * them, and which field names the recipient.
 *
 * These readers lived in the api (`services/capabilities/file-parameters.ts`,
 * `file-input-map.ts`, `intent-input.ts`, `parameter-dialect.ts`); they live
 * HERE now so `bindContext` (every surface) and the run doors (the pod) read
 * one copy. The api re-exports each one unchanged. Pure: no imports.
 */

/**
 * Is this bag JSON Schema rather than the shorthand type map?
 *
 * DISCRIMINATE ON `properties`, NOT ON `type`. A type map may legitimately
 * declare a FIELD named `type` — `exa_search` does (`"type": "string?"`) — so
 * keying on `type` alone would misread a real type map as a schema. Only the
 * pairing of `type: "object"` with a `properties` OBJECT identifies the
 * dialect.
 */
export function looksLikeJsonSchema(
  declared: Record<string, unknown>
): boolean {
  return (
    declared.type === "object" &&
    typeof declared.properties === "object" &&
    declared.properties !== null &&
    !Array.isArray(declared.properties)
  );
}

/** One declared file parameter of a verb. */
export interface PodFileParameter {
  field: string;
  /** `file[]`: a list of file ids; `file`: one. */
  many: boolean;
  /** As declared after the `:` — null when the declaration names none. */
  delivery: string | null;
  optional: boolean;
}

/** Most files one `file[]` parameter may carry (an Instagram carousel's 20). */
export const POD_FILES_PER_PARAMETER_MAX = 20;

const FILE_TYPE = /^file(\[\])?(?::([a-z]+))?(\?)?$/;

/**
 * Read one type-map entry as a file parameter, or null when it is not one.
 * `file`, `file[]`, each with an optional `:<delivery>` and an optional `?`.
 */
export function parseFileParameterType(
  raw: unknown
): Omit<PodFileParameter, "field"> | null {
  if (typeof raw !== "string") return null;
  const m = FILE_TYPE.exec(raw);
  if (!m) return null;
  return { many: !!m[1], delivery: m[2] ?? null, optional: !!m[3] };
}

/** The file parameters a verb's `parameters` declare (type-map dialect only). */
export function declaredFileParameters(
  parameters: unknown
): PodFileParameter[] {
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters) ||
    looksLikeJsonSchema(parameters as Record<string, unknown>)
  ) {
    return [];
  }
  const out: PodFileParameter[] = [];
  for (const [field, raw] of Object.entries(
    parameters as Record<string, unknown>
  )) {
    const parsed = parseFileParameterType(raw);
    if (parsed) out.push({ field, ...parsed });
  }
  return out;
}

/** The JSON Schema annotation marking an intent input field as pod file ids. */
export const POD_FILE_INPUT_KEYWORD = "x-synap-pod-file";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The intent input's pod-file fields: name → a list (`array`) or one id. */
export function podFileInputFields(
  intentSchema: Record<string, unknown> | null
): Map<string, { many: boolean }> {
  const out = new Map<string, { many: boolean }>();
  const properties = isRecord(intentSchema?.properties)
    ? intentSchema.properties
    : {};
  for (const [field, schema] of Object.entries(properties)) {
    if (isRecord(schema) && schema[POD_FILE_INPUT_KEYWORD] === true)
      out.set(field, { many: schema.type === "array" });
  }
  return out;
}

/**
 * The intent input field that names the RECIPIENT: present when a verb's map
 * reads `$to.*`. Takes an entity id, kind-blind.
 */
export const RECIPIENT_INPUT_FIELD = "to";
