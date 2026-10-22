/**
 * What the proposal review reads at a glance — pure, so each mark is tested
 * apart from the markup that draws it.
 *
 *   `fieldChangeRows`  — the change itself: the pod's before → after diff
 *                        (`review.changes`, `routers/proposals/changes.ts`),
 *                        one row per field, values in words.
 *   `governanceMark`   — the policy's WHY as a mark: can one of your rules
 *                        ever let this through, or does it always ask?
 *                        Read from the ladder's ONE table
 *                        (`GOVERNANCE_REASON_RULE_REACH`).
 *   `approveConsequence` — what approving does, as a mark: undoable or not
 *                        (the pod's own `revertable`, never a guess).
 *   `initials`         — the person chip's avatar.
 */

import { GOVERNANCE_REASON_RULE_REACH } from "@synap-core/types/trust-ladder";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";

/** One field of the pod's diff, read structurally. */
export interface ProposalChangeInput {
  path: string;
  label: string;
  operation: "create" | "update" | "delete" | "set";
  before?: unknown;
  after?: unknown;
  drift?: "unchanged" | "changed_since" | "unknown";
}

export interface FieldChangeRow {
  key: string;
  label: string;
  op: "add" | "change" | "remove";
  /**
   * `undefined` = not recorded (draw no "before"); `null` = recorded empty
   * ("was empty"); a string = the value in words.
   */
  before: string | null | undefined;
  after: string | null | undefined;
  /** The field moved after this was proposed: the `before` shown is stale. */
  stale: boolean;
}

/** The longest value drawn inline; the whole value stays in Advanced. */
const MAX_VALUE_CHARS = 160;

function clip(text: string): string {
  return text.length > MAX_VALUE_CHARS
    ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…`
    : text;
}

/**
 * A value in words. A kind slug reads as its noun ("finding" → "Finding"),
 * through the vocabulary door.
 */
function valueText(path: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (path === "profileSlug" && typeof value === "string")
    return resolveObjectNoun(value);
  if (typeof value === "string") return clip(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => valueText(path, v))
      .filter((v): v is string => !!v);
    return parts.length > 0 ? clip(parts.join(", ")) : null;
  }
  try {
    return clip(JSON.stringify(value));
  } catch {
    return clip(String(value));
  }
}

/**
 * The field's name. The pod labels a path by capitalising it
 * (`labelFromPath`), which turns the one camelCase entity column a reviewer
 * meets — `profileSlug` — into "ProfileSlug". That column IS the record's
 * kind; say so.
 */
function fieldLabel(change: ProposalChangeInput): string {
  if (change.path === "profileSlug") return "Kind";
  return change.label || change.path;
}

export function fieldChangeRows(
  changes: readonly ProposalChangeInput[] | null | undefined
): FieldChangeRow[] {
  if (!Array.isArray(changes)) return [];
  return changes.map((c) => {
    const op: FieldChangeRow["op"] =
      c.operation === "delete"
        ? "remove"
        : c.operation === "update"
          ? "change"
          : "add";
    return {
      key: c.path,
      label: fieldLabel(c),
      op,
      before:
        op === "change" && c.before !== undefined
          ? valueText(c.path, c.before)
          : op === "remove"
            ? valueText(c.path, c.before ?? null)
            : undefined,
      after: op === "remove" ? undefined : valueText(c.path, c.after),
      stale: c.drift === "changed_since",
    };
  });
}

export type ReviewTone = "warning" | "primary" | "default" | "success";

export interface ReviewMark {
  tone: ReviewTone;
  label: string;
}

/**
 * Can one of the reviewer's own rules ever let this kind of write through?
 *
 *   floor / ambiguous → it always asks a person (fail closed, as the ladder
 *                       does for an ambiguous code);
 *   rule              → one of your rules asked for it;
 *   below             → the default: no rule says anything yet.
 *
 * An unknown or absent code draws no mark — the sentence alone says why.
 */
export function governanceMark(
  code: string | null | undefined
): ReviewMark | null {
  if (!code || !Object.hasOwn(GOVERNANCE_REASON_RULE_REACH, code)) return null;
  const reach =
    GOVERNANCE_REASON_RULE_REACH[
      code as keyof typeof GOVERNANCE_REASON_RULE_REACH
    ];
  if (reach === "rule") return { tone: "primary", label: "Your rule" };
  if (reach === "below") return { tone: "default", label: "Asks by default" };
  return { tone: "warning", label: "Always asks a person" };
}

/**
 * What approving does. `revertable` is the pod's answer for this proposal
 * (`revertableForRow`: for a pending one, "could it be undone once
 * applied"); absent = unknown, and no promise is drawn.
 */
export function approveConsequence(revertable: boolean | null | undefined): {
  mark: ReviewMark | null;
  sentence: string;
} {
  if (revertable === true) {
    return {
      mark: { tone: "success", label: "Can be undone" },
      sentence: "Approving applies it now; you can undo it from its history.",
    };
  }
  if (revertable === false) {
    return {
      mark: { tone: "warning", label: "Can't be undone" },
      sentence: "Approving applies it now, and it cannot be undone from here.",
    };
  }
  return { mark: null, sentence: "Approving applies it now." };
}

/** "Antoine Servant" → "AS"; one word → its first two letters. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}
