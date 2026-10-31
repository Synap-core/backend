/**
 * Template updates — the pure rules between the pod's plan (`packageUpdates`)
 * and what pod admin draws: which group an update sits in, the mark of each
 * field state, the choices a both-changed field offers with the one
 * recommended, what the result of a choice is, and what the decision bar
 * says. No React and no words: the pages turn these answers into the
 * folder's copy (`copy.ts`), so every rule here is tested at the seam.
 *
 * The plan itself is the pod's (one comparator, `threeWayMergeFields`): this
 * module never compares a base, a catalog and a live value to decide a
 * state. It only reads the states the pod sent.
 */

import {
  PACKAGE_UPDATE_NEEDS,
  choiceKey,
  type ApplyPackageUpdateInput,
  type PackageFieldState,
  type PackageDataChange,
  type PackageUpdateChoice,
  type PackageUpdateChoiceName,
  type PackageUpdateField,
  type PackageUpdateNeeds,
  type PackageUpdatePlan,
  type PackageUpdateSummary,
} from "./contract";

// ─── The Updates list ────────────────────────────────────────────────────────

/**
 * The list's groups: what each update needs from the person, as the pod says
 * (`needs`, `derivePackageUpdateNeeds`, ordered most to least urgent), never
 * re-derived here. One split is the page's own: an update that needs nothing
 * and carries no edit of yours is `current`, counted in one reassuring line
 * rather than listed.
 */
export type UpdateGroup = PackageUpdateNeeds;

export const UPDATE_GROUPS: readonly UpdateGroup[] = PACKAGE_UPDATE_NEEDS;

export function updateGroupOf(
  s: Pick<PackageUpdateSummary, "needs" | "counts">
): UpdateGroup | "current" {
  if (s.needs === "nothing" && s.counts.yours === 0) return "current";
  return s.needs;
}

export interface UpdateGroupItems {
  group: UpdateGroup;
  items: PackageUpdateSummary[];
}

/**
 * The list's sections: empty groups omitted (OMIT, ui-composition §2), each
 * sorted by name so a reload keeps rows in place; `current` counted apart.
 */
export function groupUpdates(list: readonly PackageUpdateSummary[]): {
  groups: UpdateGroupItems[];
  current: PackageUpdateSummary[];
} {
  const by = new Map<UpdateGroup | "current", PackageUpdateSummary[]>();
  for (const s of list) {
    const g = updateGroupOf(s);
    by.set(g, [...(by.get(g) ?? []), s]);
  }
  const byName = (a: PackageUpdateSummary, b: PackageUpdateSummary) =>
    a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);
  return {
    groups: UPDATE_GROUPS.flatMap((group) => {
      const items = by.get(group);
      return items ? [{ group, items: [...items].sort(byName) }] : [];
    }),
    current: [...(by.get("current") ?? [])].sort(byName),
  };
}

/** Groups whose updates wait on something: the tab's and Home's count. */
const WAITING: ReadonlySet<UpdateGroup> = new Set([
  "consent",
  "choice",
  "review",
]);

/**
 * The updates still waiting, in the list's order: the tab count, and the
 * Review page's queue ("2 of 4", previous, next).
 */
export function waitingUpdates(
  list: readonly PackageUpdateSummary[]
): PackageUpdateSummary[] {
  return groupUpdates(list)
    .groups.filter((g) => WAITING.has(g.group))
    .flatMap((g) => g.items);
}

/** The updates that need nothing from anyone (the batch primary). */
export function updatesNeedingNothing(
  list: readonly PackageUpdateSummary[]
): PackageUpdateSummary[] {
  return (
    groupUpdates(list).groups.find((g) => g.group === "review")?.items ?? []
  );
}

export interface QueuePosition {
  /** 1-based. */
  index: number;
  total: number;
  previous: string | null;
  next: string | null;
}

/** Where `slug` sits among the waiting updates, or null when it is not one. */
export function queuePosition(
  list: readonly PackageUpdateSummary[],
  slug: string
): QueuePosition | null {
  const queue = waitingUpdates(list);
  const i = queue.findIndex((s) => s.slug === slug);
  if (i === -1) return null;
  return {
    index: i + 1,
    total: queue.length,
    previous: queue[i - 1]?.slug ?? null,
    next: queue[i + 1]?.slug ?? null,
  };
}

/** The next waiting update after `slug` once it is decided, or null. */
export function nextAfter(
  list: readonly PackageUpdateSummary[],
  slug: string
): string | null {
  return waitingUpdates(list).find((s) => s.slug !== slug)?.slug ?? null;
}

// ─── Marks ───────────────────────────────────────────────────────────────────

/**
 * A mark's tone. `choose` is the needs-you accent (ochre), `catalog` the
 * catalog's change, `consent` a change to records (warning); `yours` and
 * `same` are quiet.
 */
export type MarkTone = "choose" | "catalog" | "yours" | "same" | "consent";
export type MarkGlyph =
  "merge" | "arrive" | "pen" | "equal" | "records" | "alert";

export interface Mark {
  tone: MarkTone;
  glyph: MarkGlyph;
}

const FIELD_MARKS: Readonly<Record<PackageFieldState, Mark>> = {
  both: { tone: "choose", glyph: "merge" },
  updates: { tone: "catalog", glyph: "arrive" },
  yours: { tone: "yours", glyph: "pen" },
  same: { tone: "same", glyph: "equal" },
};

/** The mark of a field state: the same on the list, the page and Home. */
export function fieldMark(state: PackageFieldState): Mark {
  return FIELD_MARKS[state];
}

const GROUP_MARKS: Readonly<Record<UpdateGroup | "current", Mark>> = {
  choice: FIELD_MARKS.both,
  consent: { tone: "consent", glyph: "records" },
  review: FIELD_MARKS.updates,
  nothing: FIELD_MARKS.yours,
  current: FIELD_MARKS.same,
};

/** A package whose catalog the pod could not read ("Can't check"). */
export const UNREADABLE_MARK: Mark = { tone: "consent", glyph: "alert" };

/** The mark of a whole update, from the group it sits in. */
export function groupMark(group: UpdateGroup | "current"): Mark {
  return GROUP_MARKS[group];
}

/** The summary reads what needs the person first, what is the same last. */
const SUMMARY_ORDER: readonly PackageFieldState[] = [
  "both",
  "updates",
  "yours",
  "same",
];

/** Every state with a count above zero, in the summary's order. */
export function stateCounts(
  counts: Record<PackageFieldState, number>
): { state: PackageFieldState; count: number }[] {
  return SUMMARY_ORDER.flatMap((state) =>
    counts[state] > 0 ? [{ state, count: counts[state] }] : []
  );
}

// ─── Values ──────────────────────────────────────────────────────────────────

/** A short value fits one line; longer text reads as a diff. */
const SHORT_MAX_CHARS = 160;

/**
 * How a field's three values are drawn: `short` side by side in three lanes,
 * `text` as a text diff with tabs, `structured` (lists, objects) as a code
 * diff of their JSON, since struck-through structure is unreadable.
 */
export type FieldShape = "short" | "text" | "structured";

function valuesOf(field: PackageUpdateField): unknown[] {
  return [field.base, field.desired, field.live, field.merged].filter(
    (v) => v !== undefined
  );
}

export function fieldShape(field: PackageUpdateField): FieldShape {
  const values = valuesOf(field);
  if (values.some((v) => v !== null && typeof v === "object")) {
    return "structured";
  }
  const long = values.some(
    (v) =>
      typeof v === "string" && (v.length > SHORT_MAX_CHARS || v.includes("\n"))
  );
  return long ? "text" : "short";
}

/** A value as text: strings as they are, structure as indented JSON. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

/** Two values are the same when their text is (the pod compares deeply). */
export function sameValue(a: unknown, b: unknown): boolean {
  return valueText(a) === valueText(b);
}

// ─── Choices ─────────────────────────────────────────────────────────────────

/** The four answers a both-changed field offers. `edit` sends `{value}`. */
export type ChoiceId = PackageUpdateChoiceName | "edit";

const CHOICE_ORDER: readonly ChoiceId[] = [
  "catalog",
  "combine",
  "mine",
  "edit",
];

/**
 * Why "Combine both" cannot be picked: the field is not text (no line merge),
 * the two edits touch the same lines, or combining gives one side's value.
 */
export type CombineBlock =
  "notText" | "conflict" | "sameAsCatalog" | "sameAsMine";

export interface ChoiceOption {
  id: ChoiceId;
  recommended: boolean;
  /** Set when the option cannot be picked, with the reason to say. */
  blocked: CombineBlock | null;
}

/** Why "Combine both" is not on offer, or null when it is. */
export function combineBlock(field: PackageUpdateField): CombineBlock | null {
  if (field.merged === undefined) return "notText";
  if (field.merged === null) return "conflict";
  if (sameValue(field.merged, field.desired)) return "sameAsCatalog";
  if (sameValue(field.merged, field.live)) return "sameAsMine";
  return null;
}

/**
 * True when the person's edit is already inside the catalog's value: the
 * merge of the two IS the catalog's (the facecam-edit case). Words only;
 * which choice to recommend is the pod's (`plan.recommended`).
 */
export function catalogHasYourEdit(field: PackageUpdateField): boolean {
  return combineBlock(field) === "sameAsCatalog";
}

/**
 * The recommended choice of a both-changed field: the pod's, or none (the
 * person decides, and the page says so). Never derived here: the pod has
 * the one rule (`catalog` when your edit is in the catalog's text, `combine`
 * when the two merge without overlapping).
 */
export function recommendedChoice(
  field: PackageUpdateField,
  fromPod: PackageUpdateChoiceName | undefined
): ChoiceId | null {
  if (field.state !== "both" || !fromPod) return null;
  // A recommendation the field cannot take is not shown as one.
  if (fromPod === "combine" && combineBlock(field) !== null) return null;
  return fromPod;
}

/**
 * The options of a both-changed field, the recommended one first, the others
 * in a fixed order so a person who reads two fields finds them in one place.
 */
export function choiceOptions(
  field: PackageUpdateField,
  recommended: ChoiceId | null
): ChoiceOption[] {
  const order = recommended
    ? [recommended, ...CHOICE_ORDER.filter((c) => c !== recommended)]
    : CHOICE_ORDER;
  return order.map((id) => ({
    id,
    recommended: id === recommended,
    blocked: id === "combine" ? combineBlock(field) : null,
  }));
}

/** Every both-changed field of the plan, keyed `<rowId>:<field>`. */
export function choiceFields(
  plan: Pick<PackageUpdatePlan, "rows">
): { key: string; rowId: string; field: PackageUpdateField }[] {
  return plan.rows.flatMap((row) =>
    row.fields
      .filter((f) => f.state === "both")
      .map((field) => ({
        key: choiceKey(row.rowId, field.key),
        rowId: row.rowId,
        field,
      }))
  );
}

/** The choices the page opens with: each field's recommended one, if any. */
export function initialChoices(
  plan: Pick<PackageUpdatePlan, "rows" | "recommended">
): Record<string, ChoiceId> {
  const out: Record<string, ChoiceId> = {};
  for (const { key, field } of choiceFields(plan)) {
    const rec = recommendedChoice(field, plan.recommended?.[key]);
    if (rec) out[key] = rec;
  }
  return out;
}

/**
 * The starting text of "Edit the result": both changes combined when they
 * combine, else the catalog's (the person writes from the newer text).
 */
export function editStart(field: PackageUpdateField): string {
  return typeof field.merged === "string"
    ? field.merged
    : valueText(field.desired);
}

/** What a field holds after the update, for the choice made (or none). */
export function resultOf(
  field: PackageUpdateField,
  choice: ChoiceId | undefined,
  edited?: string
): unknown {
  switch (field.state) {
    case "updates":
      return field.desired;
    case "yours":
    case "same":
      return field.live;
    case "both":
      if (choice === "catalog") return field.desired;
      if (choice === "combine") return field.merged ?? field.live;
      if (choice === "edit") return edited ?? editStart(field);
      return field.live;
  }
}

// ─── The decision ────────────────────────────────────────────────────────────

/** Why the primary cannot be pressed yet, the first that holds. */
export type DecisionBlock = "choices" | "version";

/**
 * The changes to records a person can agree to: a destructive one is never
 * run by an update (an operator step, `needsPodAdmin`), so it has no box.
 */
export function consentableDataChanges(
  plan: Pick<PackageUpdatePlan, "dataChanges">
): PackageDataChange[] {
  return (plan.dataChanges?.items ?? []).filter((c) => !c.destructive);
}

export interface Decision {
  /** Fields whose value on the pod changes. */
  changing: number;
  /** Fields that stay as the person wrote them (theirs, or "Keep mine"). */
  keeping: number;
  /** Labels of both-changed fields with no choice yet. */
  missing: string[];
  /** The primary's verb: `update` writes; `keep` only records the choice. */
  primary: "update" | "keep";
  blocked: DecisionBlock | null;
  /** Changes to records the person left unticked: the update runs without. */
  recordsSkipped: number;
}

export function decisionOf(
  plan: Pick<PackageUpdatePlan, "rows" | "dataChanges" | "latestVersion">,
  chosen: Readonly<Record<string, ChoiceId>>,
  edits: Readonly<Record<string, string>>,
  accepted: ReadonlySet<string>
): Decision {
  let changing = 0;
  let keeping = 0;
  const missing: string[] = [];
  for (const row of plan.rows) {
    for (const field of row.fields) {
      const key = choiceKey(row.rowId, field.key);
      const choice = chosen[key];
      if (field.state === "both" && !choice) missing.push(field.label);
      if (
        field.state === "yours" ||
        (field.state === "both" && choice === "mine")
      ) {
        keeping += 1;
      }
      if (field.state === "same") continue;
      if (field.state === "both" && !choice) continue;
      if (!sameValue(resultOf(field, choice, edits[key]), field.live)) {
        changing += 1;
      }
    }
  }
  const consentable = consentableDataChanges(plan);
  const ticked = consentable.filter((c) => accepted.has(c.id)).length;
  const blocked: DecisionBlock | null =
    missing.length > 0 ? "choices" : !plan.latestVersion ? "version" : null;
  return {
    changing,
    keeping,
    missing,
    primary: changing > 0 || ticked > 0 ? "update" : "keep",
    blocked,
    recordsSkipped: consentable.length - ticked,
  };
}

/**
 * The apply door's input for what the page shows chosen. Every both-changed
 * field carries its choice; the others take the pod's default (`updates` →
 * the catalog's, `yours` stays).
 */
export function applyInput(
  plan: Pick<
    PackageUpdatePlan,
    "slug" | "latestVersion" | "rows" | "dataChanges"
  >,
  chosen: Readonly<Record<string, ChoiceId>>,
  edits: Readonly<Record<string, string>>,
  accepted: ReadonlySet<string> = new Set()
): ApplyPackageUpdateInput {
  const choices: Record<string, PackageUpdateChoice> = {};
  for (const { key, field } of choiceFields(plan)) {
    const choice = chosen[key];
    if (!choice) continue;
    choices[key] =
      choice === "edit" ? { value: edits[key] ?? editStart(field) } : choice;
  }
  const consentable = consentableDataChanges(plan);
  return {
    slug: plan.slug,
    expectedVersion: plan.latestVersion ?? "",
    choices,
    // Only the ids of what the person ticked, and never a destructive one.
    ...(consentable.length > 0
      ? {
          acceptDataChanges: consentable
            .filter((c) => accepted.has(c.id))
            .map((c) => c.id),
        }
      : {}),
  };
}

// ─── Failures ────────────────────────────────────────────────────────────────

/**
 * What a failed read, apply or undo means for the page. `conflict`: the
 * catalog moved since the page loaded (apply, 409: reload), or a field the
 * update changed was edited again since (undo). `gone`: no such update or
 * receipt here. `expired`: an undo after its 30 days. Anything else is a
 * failure with Try again, never "no updates".
 */
export type UpdateFailure = "conflict" | "gone" | "expired" | "failed";

export function updateFailureOf(error: unknown): UpdateFailure {
  if (!error || typeof error !== "object") return "failed";
  const data = (error as { data?: { code?: unknown; httpStatus?: unknown } })
    .data;
  const code = data?.code;
  const status = data?.httpStatus;
  if (code === "CONFLICT" || status === 409) return "conflict";
  if (code === "NOT_FOUND" || status === 404) return "gone";
  // Undo after its 30 days.
  if (code === "PRECONDITION_FAILED" || status === 412) return "expired";
  return "failed";
}
