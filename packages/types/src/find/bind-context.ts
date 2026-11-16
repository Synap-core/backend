/**
 * `bindContext` — fill what the person has selected (or has open) into the
 * right slot of a find row, before they run it.
 *
 * Pure and deterministic: no ranking, no network, never a guess between two
 * candidates. It runs on the DEVICE, over rows it already has: the selection
 * never leaves the device until the person runs the row (decision b9395bde:
 * selection context is ephemeral), find stays query-only (so its catalog stays
 * cacheable), and a change of selection re-binds with no call.
 *
 * The run door still decides: a slot filled `unverified` (a role subject the
 * surface could not check) is re-checked by `assertSubjectKind`, and every
 * file id is read-checked as the caller (`checkPodFilesAtAsk`).
 *
 * Three vocabularies, one rule each:
 *  1. Playbook: `subject` (a kind or role slug, or null) and its required
 *     params. An `entity` param with `from` is filled by the run funnel from
 *     the subject (`fillParamsFromSubject`), so it is never owed here.
 *  2. Capability action: the file parameters its type map declares
 *     (`file`, `file[]`). Files never go into a plain parameter (the same rule
 *     as the install check, `fileInputMapProblems`).
 *  3. Intent input: `x-synap-pod-file` fields take files; `to` takes the one
 *     selected non-file item.
 */
import {
  declaredFileParameters,
  looksLikeJsonSchema,
  podFileInputFields,
  POD_FILES_PER_PARAMETER_MAX,
  RECIPIENT_INPUT_FIELD,
} from "./slots.js";

/**
 * Most selected items a surface sends. A surface caps its selection here; the
 * binder does not cut it, so a file over a `file[]` cap is reported as left
 * out (`mismatch`), never dropped in silence.
 */
export const FIND_SELECTION_MAX = 20;
/** Owed slots shown inline; the rest is counted in `owedMore`. */
export const OWED_INLINE_MAX = 3;

/** What the person has selected or open right now. Ephemeral: never stored (b9395bde). */
export interface FindSelection {
  items: Array<{
    /** Entity id (a stored file is an entity). */
    id: string;
    /** Its kind token: person, company, task, file… */
    kind: string;
    /** Live role slugs, when the surface knows them. Absent = unknown. */
    roles?: string[];
    /** Present iff it is a stored file. */
    file?: { mimeType: string | null };
  }>;
  /** Selected text (not bound in W1). */
  text?: string;
}

export type FindSelectionItem = FindSelection["items"][number];

export type BindVocabulary = "subject" | "param" | "file" | "recipient";

/**
 * One slot the selection filled. Shaped as a surface's filled input
 * (the browser palette reads it as `metadata.filledInputs`).
 */
export interface FilledSlot {
  /** The slot: `subject`, a param name, a file parameter, `to`. */
  name: string;
  /** The slot's own label, when it declares one. */
  label?: string;
  /** The entity id filled; a list for a `file[]` / `many` slot. */
  value: string | string[];
  /** Which vocabulary filled it. */
  source?: BindVocabulary;
  /** The surface could not check the kind or role: the run door decides. */
  unverified?: true;
}

export interface ContextBinding {
  filled: FilledSlot[];
  /** Required slots still empty, at most {@link OWED_INLINE_MAX}. */
  owed: Array<{ slot: string; label: string; type: string }>;
  /** Required slots beyond those shown (a "more" link to the full form). */
  owedMore: number;
  /** Why (part of) the selection cannot go here, one plain sentence. */
  mismatch?: string;
}

/** A playbook's required param as the find wire carries it. */
export interface FindRequiredParam {
  name: string;
  label?: string;
  type: string;
  from?: string;
}

/** What a row runs, as far as binding is concerned. */
export type BindTarget =
  | {
      vocabulary: "playbook";
      /** `subject_profile.profileSlug`, or null for a subject-less playbook. */
      subject: string | null;
      requiredParams: readonly FindRequiredParam[];
    }
  | {
      vocabulary: "action";
      /** The action's real parameter contract (type map or JSON Schema). */
      parameters: Record<string, unknown>;
    }
  | {
      vocabulary: "intent";
      /** The intent's input JSON Schema. */
      input: Record<string, unknown> | null;
    };

type Owed = ContextBinding["owed"][number];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function finish(
  filled: ContextBinding["filled"],
  owed: Owed[],
  mismatch?: string
): ContextBinding {
  return {
    filled,
    owed: owed.slice(0, OWED_INLINE_MAX),
    owedMore: Math.max(0, owed.length - OWED_INLINE_MAX),
    ...(mismatch ? { mismatch } : {}),
  };
}

/** Fill file slots in order; returns the mismatch sentence when files are left over by a cap. */
function fillFiles(
  slots: Array<{ field: string; many: boolean; optional: boolean }>,
  files: readonly FindSelectionItem[],
  filled: ContextBinding["filled"],
  owed: Owed[]
): string | undefined {
  // Required slots take files first: two `file` params and one file fill the
  // first REQUIRED one, never an optional one ahead of it.
  const ordered = [
    ...slots.filter((s) => !s.optional),
    ...slots.filter((s) => s.optional),
  ];
  let next = 0;
  let mismatch: string | undefined;
  for (const slot of ordered) {
    const left = files.slice(next);
    if (left.length === 0) {
      if (!slot.optional)
        owed.push({
          slot: slot.field,
          label: slot.field,
          type: slot.many ? "file[]" : "file",
        });
      continue;
    }
    const take = slot.many
      ? left.slice(0, POD_FILES_PER_PARAMETER_MAX)
      : left.slice(0, 1);
    next += take.length;
    filled.push({
      name: slot.field,
      value: slot.many ? take.map((f) => f.id) : take[0]!.id,
      source: "file",
    });
    if (slot.many && left.length > take.length) {
      mismatch = `At most ${POD_FILES_PER_PARAMETER_MAX} files go into ${slot.field}; ${left.length - take.length} left out.`;
    }
  }
  return mismatch;
}

/** The required, non-file fields of a JSON Schema, as owed slots. */
function schemaRequired(
  schema: Record<string, unknown>,
  skip: ReadonlySet<string>
): Owed[] {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((f): f is string => typeof f === "string")
    : [];
  const props = isRecord(schema.properties) ? schema.properties : {};
  return required
    .filter((f) => !skip.has(f))
    .map((f) => {
      const p = props[f];
      const type =
        isRecord(p) && typeof p.type === "string" ? p.type : "unknown";
      const label =
        isRecord(p) && typeof p.title === "string" && p.title.trim()
          ? p.title.trim()
          : f;
      return { slot: f, label, type };
    });
}

function bindPlaybook(
  selection: FindSelection,
  target: Extract<BindTarget, { vocabulary: "playbook" }>
): ContextBinding {
  const filled: ContextBinding["filled"] = [];
  const owed: Owed[] = [];
  let mismatch: string | undefined;
  const things = selection.items.filter((i) => !i.file);
  let subjectId: string | null = null;

  if (target.subject) {
    const s = target.subject;
    const fits = things.find((i) => i.kind === s || i.roles?.includes(s));
    if (fits) {
      subjectId = fits.id;
      filled.push({ name: "subject", value: fits.id, source: "subject" });
    } else if (things.length > 0) {
      const first = things[0]!;
      if (first.roles === undefined) {
        // The surface does not know its roles: it may wear `s` as a role.
        subjectId = first.id;
        filled.push({
          name: "subject",
          value: first.id,
          source: "subject",
          unverified: true,
        });
      } else {
        mismatch = `This works on a ${s}; the selection is a ${first.kind}.`;
        owed.push({ slot: "subject", label: s, type: "entity" });
      }
    } else {
      owed.push({ slot: "subject", label: s, type: "entity" });
    }
  }

  const rest = things.filter((i) => i.id !== subjectId);
  for (const p of target.requiredParams) {
    if (p.type === "entity" && p.from) continue; // the run funnel fills it
    if (p.type === "entity" && rest.length === 1) {
      filled.push({
        name: p.name,
        ...(p.label ? { label: p.label } : {}),
        value: rest[0]!.id,
        source: "param",
      });
      continue;
    }
    // None, or two candidates: owed. Never a guess.
    owed.push({ slot: p.name, label: p.label ?? p.name, type: p.type });
  }
  return finish(filled, owed, mismatch);
}

function bindAction(
  selection: FindSelection,
  target: Extract<BindTarget, { vocabulary: "action" }>
): ContextBinding {
  const filled: ContextBinding["filled"] = [];
  const owed: Owed[] = [];
  const files = selection.items.filter((i) => i.file);
  const params = target.parameters;
  const fileSlots = declaredFileParameters(params);
  // No declared file parameter: selected files fill NOTHING (never a plain one).
  const mismatch = fillFiles(fileSlots, files, filled, owed);
  const fileFields = new Set(fileSlots.map((s) => s.field));
  if (looksLikeJsonSchema(params)) {
    owed.push(...schemaRequired(params, fileFields));
  } else {
    for (const [field, raw] of Object.entries(params)) {
      if (fileFields.has(field)) continue;
      // Only a string entry is this dialect; requiredness is its missing `?`.
      if (typeof raw !== "string" || raw.trim().endsWith("?")) continue;
      owed.push({ slot: field, label: field, type: raw.trim() });
    }
  }
  return finish(filled, owed, mismatch);
}

function bindIntent(
  selection: FindSelection,
  target: Extract<BindTarget, { vocabulary: "intent" }>
): ContextBinding {
  const filled: ContextBinding["filled"] = [];
  const owed: Owed[] = [];
  const schema = target.input ?? {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((f): f is string => typeof f === "string")
      : []
  );
  const files = selection.items.filter((i) => i.file);
  const things = selection.items.filter((i) => !i.file);
  const podFields = podFileInputFields(schema);
  const mismatch = fillFiles(
    [...podFields].map(([field, { many }]) => ({
      field,
      many,
      optional: !required.has(field),
    })),
    files,
    filled,
    owed
  );
  const handled = new Set(podFields.keys());
  const props = isRecord(schema.properties) ? schema.properties : {};
  if (RECIPIENT_INPUT_FIELD in props) {
    handled.add(RECIPIENT_INPUT_FIELD);
    if (things.length === 1) {
      filled.push({
        name: RECIPIENT_INPUT_FIELD,
        value: things[0]!.id,
        source: "recipient",
      });
    } else if (required.has(RECIPIENT_INPUT_FIELD)) {
      owed.push({
        slot: RECIPIENT_INPUT_FIELD,
        label: RECIPIENT_INPUT_FIELD,
        type: "entity",
      });
    }
  }
  owed.push(...schemaRequired(schema, handled));
  return finish(filled, owed, mismatch);
}

/**
 * Bind a selection to what a row runs. Never throws, never guesses: a slot
 * two items could fill is owed.
 */
export function bindContext(
  selection: FindSelection,
  target: BindTarget
): ContextBinding {
  switch (target.vocabulary) {
    case "playbook":
      return bindPlaybook(selection, target);
    case "action":
      return bindAction(selection, target);
    case "intent":
      return bindIntent(selection, target);
  }
}
