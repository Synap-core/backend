/**
 * New goal → the criteria the start door takes. A person writes a criterion
 * as words and a kind of check ("Measured", "Judged by a person", …); the
 * pod stores the session criterion shape (`sessionCriterionSchema`: a slug
 * `key`, a `check.kind` the meaning can carry, `checkKind`, `about`). This is
 * the ONE translation, so the desk's and the phone's New goal send the same
 * thing, and the pod's own refusal (`checkCriterionMeaning`) can never fire
 * on what a form built.
 *
 * PURE: no React, no DOM.
 */
import {
  CHECK_MEANING_EVALUATORS,
  checkCriterionMeaning,
  checkGoalCriteriaCount,
  type CriterionCheckMeaning,
} from "../units/index.js";
import type { EvaluatorKind } from "../focus-sessions/index.js";

/** What a person wrote for one criterion. */
export interface GoalCriterionDraft {
  statement: string;
  meaning: CriterionCheckMeaning;
  /** A slug to keep (an edited criterion); absent ⇒ made from the statement. */
  key?: string;
}

/** One criterion as the start door (`tracks.start` / `setDirection`) takes it. */
export interface GoalCriterionInput {
  key: string;
  statement: string;
  required: true;
  check: { kind: EvaluatorKind; evidenceKey?: string };
  checkKind: CriterionCheckMeaning;
  about?: "method";
}

/** The pod's key rule (`sessionCriterionSchema`): a lowercase slug, at most 80. */
const KEY_RE = /^[a-z0-9][a-z0-9_.-]*$/;
const KEY_MAX = 80;
/** Room left for a "-N" suffix inside the 80. */
const SLUG_MAX = 60;

/** A statement as a key: "Median wait < 20 min" → "median-wait-20-min". */
export function criterionKeyOf(statement: string): string {
  const slug = statement
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || "criterion";
}

/**
 * The check a meaning is carried by (`CHECK_MEANING_EVALUATORS`): a MEASURED
 * criterion is checked by evidence the work posts (under its own key); every
 * other meaning is a person's check — judged, handed over, learning, decided
 * outside and certified are all recorded as a person's grade.
 */
export function checkKindFor(meaning: CriterionCheckMeaning): EvaluatorKind {
  const allowed: readonly EvaluatorKind[] = CHECK_MEANING_EVALUATORS[meaning];
  return meaning !== "measured" && allowed.includes("human")
    ? "human"
    : allowed[0]!;
}

/**
 * ONE criterion for the start door. `taken` = keys already used in the list:
 * a clash gets "-2", "-3"… (keys are unique within a goal). A `key` the
 * person kept is used when it is a valid slug, else rebuilt from the words.
 */
export function goalCriterionInput(
  draft: GoalCriterionDraft,
  taken: ReadonlySet<string> = new Set()
): GoalCriterionInput {
  const statement = draft.statement.trim();
  const kept =
    draft.key && KEY_RE.test(draft.key) && draft.key.length <= KEY_MAX
      ? draft.key
      : null;
  const base = kept ?? criterionKeyOf(statement);
  let key = base;
  for (let n = 2; taken.has(key); n++)
    key = `${base.slice(0, KEY_MAX - String(n).length - 1)}-${n}`;
  const kind = checkKindFor(draft.meaning);
  return {
    key,
    statement,
    required: true,
    check: kind === "evidence" ? { kind, evidenceKey: key } : { kind },
    checkKind: draft.meaning,
    ...(draft.meaning === "learning" ? { about: "method" as const } : {}),
  };
}

/** A whole list for the start door, keys unique, in the order written. */
export function goalCriteriaInput(
  drafts: readonly GoalCriterionDraft[]
): GoalCriterionInput[] {
  const taken = new Set<string>();
  return drafts.map((d) => {
    const c = goalCriterionInput(d, taken);
    taken.add(c.key);
    return c;
  });
}

/**
 * The form's refusal before sending, `null` when the pod will take it: no
 * criteria (a lasting goal) or 2 to 5 (`checkGoalCriteriaCount`, the pod's own
 * words), each with words, and a check its meaning can carry.
 */
export function goalCriteriaInputCheck(
  list: readonly GoalCriterionInput[]
): string | null {
  const count = checkGoalCriteriaCount(list.length);
  if (count) return count;
  if (list.some((c) => !c.statement.trim()))
    return "Every criterion needs words.";
  for (const c of list) {
    const incoherent = checkCriterionMeaning(c);
    if (incoherent) return incoherent;
  }
  return null;
}
