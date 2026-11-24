/**
 * Playbook PARAMS — reading the declaration, and validating the answers.
 *
 * `PlaybookParam[]` (see index.ts) has been DECLARED since playbooks shipped and
 * ENFORCED by nobody: `resolveGoal` took whatever map the caller passed,
 * stringified it, and substituted. A `required` param nobody answered rendered
 * as `""` and a `default` nobody supplied never reached the prompt at all — the
 * declared-on-the-wire-populated-by-nobody shape, in the one place where the
 * missing value is the agent's whole instruction.
 *
 * Everything here is PURE — no zod, no I/O — like the rest of this package. The
 * run funnel (`instantiateSessionRow`) is the single caller; six doors each
 * validating is how drift starts.
 */

import type { PlaybookParam, PlaybookParamType } from "./index.js";

/** A supplied value that could not be read as its declared type. */
export interface PlaybookParamTypeError {
  name: string;
  type: PlaybookParamType;
  /**
   * The value as the person would see it in an error message. A STRING, never
   * the raw value: a param map can carry an object, and a message that renders
   * `[object Object]` tells nobody anything.
   */
  received: string;
  /** `choice` only — what the value had to be one of. */
  options?: string[];
  /** True when the offending value came from the param's own `default`. */
  fromDefault?: boolean;
}

/**
 * THE sentence for a param type error — one wording for every door (session
 * create, track params, the approval replay): `"x" must be one of "a", "b" —
 * got "c".` for a choice, `"x" must be a number — got "lots".` otherwise.
 */
export function describeParamTypeError(e: PlaybookParamTypeError): string {
  return e.options
    ? `"${e.name}" must be one of ${e.options.map((o) => `"${o}"`).join(", ")} — got "${e.received}".`
    : `"${e.name}" must be a ${e.type} — got "${e.received}".`;
}

export interface PlaybookParamResolution {
  /**
   * What to substitute into the goal template. Declared params that resolved
   * (supplied or defaulted) plus every supplied key the playbook does NOT
   * declare, passed through verbatim — an undeclared key already substituted
   * before this function existed, and silently dropping it would break the
   * goal templates that rely on it.
   *
   * A param that is absent with no default is ABSENT from this map, so it
   * renders exactly as it did before (`""`). Enforcement is the caller's job:
   * `missingRequired` is what it acts on.
   */
  values: Record<string, unknown>;
  /**
   * The DECLARED params only — the same values as {@link values} minus every
   * undeclared key the caller sent.
   *
   * The two exist because substituting and STORING are different risks.
   * Substitution has to stay permissive for back-compat (an undeclared key
   * already rendered). Storage does not: `metadata.params` is a persisted bag
   * that UIs read and render, so letting arbitrary caller-supplied JSON land
   * in it means a stored, rendered field whose shape nothing declared, nothing
   * typed and nothing bounded in size. Persist THIS one.
   */
  declaredValues: Record<string, unknown>;
  /** Declared `required` params with no supplied value and no default. */
  missingRequired: PlaybookParam[];
  typeErrors: PlaybookParamTypeError[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PARAM_TYPES: readonly PlaybookParamType[] = [
  "text",
  "number",
  "entity",
  "choice",
  "boolean",
];

/**
 * Read a `playbooks.params` jsonb bag into declarations. TOLERANT, exactly like
 * `readCriteria`: an entry with no `name`, an unknown `type` or a duplicate name
 * is DROPPED rather than thrown on — a bag written by a newer pod or by hand
 * must not break every run.
 *
 * An entry whose `type` is missing reads as `text`: that is what the substituter
 * did with it (everything was stringified), so a legacy declaration keeps
 * behaving as it did instead of silently vanishing from validation.
 */
export function readPlaybookParams(raw: unknown): PlaybookParam[] {
  return readParamsAndDrops(raw).params;
}

/** Why {@link readPlaybookParams} drops a declared entry. */
export type DroppedParamReason =
  "not_an_object" | "missing_name" | "duplicate_name";

export interface DroppedParamEntry {
  /** Position in the declared array. */
  index: number;
  reason: DroppedParamReason;
  /** A `key` the entry carried instead of `name` — the usual author slip. */
  key?: string;
}

/**
 * The entries {@link readPlaybookParams} would DROP, and why — for a WRITE
 * door. The reader stays tolerant (a stored bag must not break every run); a
 * door that is about to STORE a bag must refuse an entry it knows the reader
 * will silently discard, or the caller is told "saved" about a param no run
 * will ever see. Same loop as the reader, so the two cannot disagree.
 */
export function findDroppedParamEntries(raw: unknown): DroppedParamEntry[] {
  return readParamsAndDrops(raw).dropped;
}

function readParamsAndDrops(raw: unknown): {
  params: PlaybookParam[];
  dropped: DroppedParamEntry[];
} {
  const out: PlaybookParam[] = [];
  const dropped: DroppedParamEntry[] = [];
  if (!Array.isArray(raw)) return { params: out, dropped };
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      dropped.push({ index, reason: "not_an_object" });
      continue;
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!name) {
      dropped.push({
        index,
        reason: "missing_name",
        ...(typeof e.key === "string" && e.key.trim()
          ? { key: e.key.trim() }
          : {}),
      });
      continue;
    }
    if (seen.has(name)) {
      dropped.push({ index, reason: "duplicate_name" });
      continue;
    }
    const type = (PARAM_TYPES as readonly unknown[]).includes(e.type)
      ? (e.type as PlaybookParamType)
      : "text";
    seen.add(name);
    out.push({
      name,
      type,
      ...(typeof e.label === "string" && e.label.trim()
        ? { label: e.label.trim() }
        : {}),
      ...(Array.isArray(e.options)
        ? {
            options: e.options.filter(
              (o): o is string => typeof o === "string"
            ),
          }
        : {}),
      ...(readDeclaredDefault(e) !== undefined
        ? { default: readDeclaredDefault(e) }
        : {}),
      ...(typeof e.required === "boolean" ? { required: e.required } : {}),
      ...(typeof e.from === "string" && e.from.trim()
        ? { from: e.from.trim() }
        : {}),
    });
  }
  return { params: out, dropped };
}

/**
 * A param's declared default, under EITHER spelling.
 *
 * `default` is the canonical contract field (`PlaybookParam.default`).
 * `defaultValue` is what the SHIPPED CORPUS actually contains: parsing all 33
 * `synap-app/packages/workspace-templates/src/*.yaml` files, `default` appears
 * on **0** playbook params and `defaultValue` on **4** — `ecosystem` Research
 * Competitor (`focus`, `outputTypes`), `meetings-knowledge` Import & Summarize
 * Meeting (`outputTypes`), `outreach-comms` Personalized Outreach (`channel`).
 *
 * So reading only the canonical spelling would make default-application INERT:
 * every default in the product would still reach the prompt never, and the
 * enforcement this module exists for would be a no-op on exactly the playbooks
 * that declare one. Verified by PARSING the YAML, not grepping — the repo is
 * full of `constraints: { defaultValue: … }` on PROPERTY DEFS, which a grep
 * cannot tell apart from a playbook param.
 *
 * ⚠️ DO NOT DELETE THIS ARM AS DEAD CODE. Two independent scans of that package
 * have already reported a FALSE ZERO on it. The package is 33 YAML files and
 * exactly one JSON file, and the overwhelming majority of `defaultValue` hits
 * in the repo are `constraints: { defaultValue: … }` on PROPERTY DEFS — so a
 * JSON-only walk, or any scan that does not descend specifically into
 * `playbooks[].params[]`, finds nothing and looks exactly like a clean
 * negative. The measurement above was made by parsing every YAML and walking
 * that path. Re-measure the same way before concluding this is unused.
 *
 * This arm is READ-COMPAT, not a second canonical spelling: the alias is never
 * WRITTEN (the resolution stores `default`), the write doors keep taking
 * `default`, and nothing downstream learns the second name. It exists because
 * already-INSTALLED pods hold `defaultValue` inside `playbooks.params` jsonb —
 * fixing the YAML cannot reach those rows. Retire it only once the corpus is
 * converged AND stored rows are migrated.
 *
 * `@synap-app/property-renderer`'s `playbookParamsToFormSpec` reads both arms
 * for the same reason and on the same measurement. The two must agree: a form
 * that offers a default the run then ignores is worse than no default at all.
 */
function readDeclaredDefault(e: Record<string, unknown>): unknown {
  if ("default" in e && e.default !== undefined) return e.default;
  if ("defaultValue" in e && e.defaultValue !== undefined) {
    return e.defaultValue;
  }
  return undefined;
}

/**
 * ABSENT means: not supplied at all, `null`, or a blank string. The third case
 * is the one worth stating — a form posts `""` for a field the person skipped,
 * and treating that as an answer would let a required param be satisfied by
 * leaving it empty, which is the defect this function exists to stop.
 */
export function isAbsentParamValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  );
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === "object") return "object";
  return String(value);
}

/**
 * Coerce one supplied value against its declared type. Returns the value to
 * store, or `undefined` when it cannot be read as that type (the caller then
 * records a type error). Deliberately permissive across the wire encodings that
 * actually occur — a number arriving as `"3"` from a form, a boolean as
 * `"true"` from a query string — and refusing everything else.
 */
function coerce(param: PlaybookParam, value: unknown): unknown | undefined {
  switch (param.type) {
    case "text":
      if (typeof value === "string") return value;
      // A number or boolean was already stringified by the substituter; keeping
      // that is not a widening, it is what the template already rendered.
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
      if (typeof value === "boolean") return String(value);
      return undefined;
    case "number": {
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
      }
      if (typeof value === "string") {
        const n = Number(value.trim());
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const s = value.trim().toLowerCase();
        if (s === "true") return true;
        if (s === "false") return false;
      }
      return undefined;
    case "entity":
      return typeof value === "string" && UUID_RE.test(value.trim())
        ? value.trim()
        : undefined;
    case "choice": {
      if (typeof value !== "string") return undefined;
      const options = param.options ?? [];
      // A `choice` that declares NO options cannot adjudicate anything — the
      // declaration is incomplete, and refusing every value would make the
      // playbook unrunnable over an authoring mistake. Any string is accepted,
      // which is what happened before this function existed.
      if (options.length === 0) return value;
      return options.includes(value) ? value : undefined;
    }
  }
}

/**
 * Validate the caller's answers against a playbook's declared params.
 *
 * COLLECTS, never throws: a missing required param and a mistyped one are both
 * facts the caller decides what to do with (the interactive doors refuse, the
 * headless doors file an owed slot). Throwing here would force that policy into
 * this package, where nothing knows which door is calling.
 */
export function validatePlaybookParams(
  declared: readonly PlaybookParam[],
  supplied: Record<string, unknown> | undefined
): PlaybookParamResolution {
  const given = supplied ?? {};
  const values: Record<string, unknown> = {};
  const declaredValues: Record<string, unknown> = {};
  const missingRequired: PlaybookParam[] = [];
  const typeErrors: PlaybookParamTypeError[] = [];
  const declaredNames = new Set<string>();

  for (const param of declared) {
    declaredNames.add(param.name);
    const raw = given[param.name];
    const absent = isAbsentParamValue(raw);
    const source = absent ? param.default : raw;

    if (isAbsentParamValue(source)) {
      if (param.required) missingRequired.push(param);
      // Absent with no default: NOT written. The template then renders it the
      // way it always did; the caller acts on `missingRequired`.
      continue;
    }

    const coerced = coerce(param, source);
    if (coerced === undefined) {
      typeErrors.push({
        name: param.name,
        type: param.type,
        received: describe(source),
        ...(param.type === "choice" && param.options?.length
          ? { options: param.options }
          : {}),
        ...(absent ? { fromDefault: true } : {}),
      });
      continue;
    }
    values[param.name] = coerced;
    declaredValues[param.name] = coerced;
  }

  // Undeclared supplied keys ride through untouched — see `values` above.
  for (const [key, value] of Object.entries(given)) {
    if (!declaredNames.has(key)) values[key] = value;
  }

  return { values, declaredValues, missingRequired, typeErrors };
}

/** One line naming the unanswered required params, for a refusal or a slot. */
export function describeMissingParams(
  missing: readonly PlaybookParam[]
): string {
  return missing.map((p) => p.label?.trim() || p.name).join(", ");
}

// ── Answers that come from the run's SUBJECT ────────────────────────────────

/**
 * The run's bound subject, as the param fill reads it. `kinds` is every slug
 * the subject counts as (its kind, the kind's ancestors, its live roles); it is
 * only read to tell which of SEVERAL entity params is the subject.
 */
export interface ParamSubject {
  id: string;
  title?: string | null;
  preview?: string | null;
  properties?: Record<string, unknown> | null;
  kinds?: readonly string[];
}

/** `from: "subject"`: the param IS the run's subject (an entity param). */
export const PARAM_FROM_SUBJECT = "subject" as const;
const SUBJECT_FIELD_PREFIX = "subject.";

/** The field a `from: "subject.<field>"` param reads, else null. */
export function subjectFieldOfParam(p: { from?: string }): string | null {
  return p.from?.startsWith(SUBJECT_FIELD_PREFIX) &&
    p.from.length > SUBJECT_FIELD_PREFIX.length
    ? p.from.slice(SUBJECT_FIELD_PREFIX.length)
    : null;
}

/**
 * One usable value out of a subject field: a non-blank string (trimmed), a
 * finite number or a boolean. A list counts only when it holds exactly ONE
 * such value (a single-select stored as a list); several values are not a
 * choice this function can make, so they answer nothing.
 */
function oneScalar(raw: unknown): unknown | undefined {
  if (typeof raw === "string")
    return raw.trim() === "" ? undefined : raw.trim();
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) {
    const usable = raw
      .map((v) => (Array.isArray(v) ? undefined : oneScalar(v)))
      .filter((v) => v !== undefined);
    return usable.length === 1 ? usable[0] : undefined;
  }
  return undefined;
}

function readSubjectField(subject: ParamSubject, field: string): unknown {
  if (field === "title") return oneScalar(subject.title);
  if (field === "preview") return oneScalar(subject.preview);
  const props = subject.properties ?? {};
  return Object.prototype.hasOwnProperty.call(props, field)
    ? oneScalar(props[field])
    : undefined;
}

/**
 * Does telling the subject's entity param apart need the subject's kinds?
 * Only with several entity params and none declared `from: "subject"` — so a
 * caller can skip the kind read everywhere else.
 */
export function needsSubjectKinds(declared: readonly PlaybookParam[]): boolean {
  const entity = declared.filter((p) => p.type === "entity");
  return (
    entity.length > 1 && !entity.some((p) => p.from === PARAM_FROM_SUBJECT)
  );
}

export interface SubjectParamFill {
  /** The supplied answers plus what the subject answered. */
  values: Record<string, unknown>;
  /** Param name → where its value came from (`subject` or `subject.<field>`). */
  filled: Record<string, string>;
}

/**
 * Fill the params the CALLER LEFT UNANSWERED from the run's bound subject —
 * what the playbook DECLARES, never a guess:
 *
 *  1. `from: "subject"` on an entity param: that param is the subject.
 *  2. `from: "subject.<field>"`: the subject's `title`, `preview` or property
 *     `<field>` (Produce Content's `platform` is the post's `post-platform`).
 *  3. No param declared the subject (back-compat, for entity params): the
 *     playbook's ONLY entity param is the subject; with several, the one
 *     NAMED after the subject's kind ("post" for a post). Two such, or none:
 *     nothing is filled — which one is the subject is not derivable.
 *
 * A caller's answer always wins. A field that is empty, missing, an object or
 * a list of several values fills nothing, so a required param stays missing
 * and the run door's refusal names it — never a blank or a wrong value. PURE:
 * the caller reads the subject (through its own visibility floor) and then
 * validates the result with {@link validatePlaybookParams}, which coerces and
 * type-checks a filled value exactly like a supplied one.
 */
export function fillParamsFromSubject(
  declared: readonly PlaybookParam[],
  supplied: Record<string, unknown> | undefined,
  subject: ParamSubject | null | undefined
): SubjectParamFill {
  const values: Record<string, unknown> = { ...(supplied ?? {}) };
  const filled: Record<string, string> = {};
  if (!subject?.id) return { values, filled };
  const unanswered = (name: string) =>
    isAbsentParamValue(
      Object.prototype.hasOwnProperty.call(values, name)
        ? values[name]
        : undefined
    );

  let subjectDeclared = false;
  for (const p of declared) {
    if (p.from === PARAM_FROM_SUBJECT && p.type === "entity") {
      subjectDeclared = true;
      if (unanswered(p.name)) {
        values[p.name] = subject.id;
        filled[p.name] = PARAM_FROM_SUBJECT;
      }
      continue;
    }
    const field = subjectFieldOfParam(p);
    if (field === null || !unanswered(p.name)) continue;
    const value = readSubjectField(subject, field);
    if (value !== undefined) {
      values[p.name] = value;
      filled[p.name] = `${SUBJECT_FIELD_PREFIX}${field}`;
    }
  }
  if (subjectDeclared) return { values, filled };

  // 3 — the implicit rule. Entity params without a `from` of their own; one
  // already holding the subject (the caller named it) settles it.
  const entity = declared.filter((p) => p.type === "entity" && !p.from);
  if (entity.some((p) => values[p.name] === subject.id)) {
    return { values, filled };
  }
  const allEntity = declared.filter((p) => p.type === "entity");
  let target: PlaybookParam | undefined;
  if (allEntity.length === 1 && entity.length === 1) {
    target = entity[0];
  } else {
    const kinds = new Set(subject.kinds ?? []);
    const named = entity.filter((p) => kinds.has(p.name));
    if (named.length === 1) target = named[0];
  }
  if (target && unanswered(target.name)) {
    values[target.name] = subject.id;
    filled[target.name] = PARAM_FROM_SUBJECT;
  }
  return { values, filled };
}
