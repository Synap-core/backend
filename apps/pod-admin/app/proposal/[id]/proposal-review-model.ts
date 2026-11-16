/**
 * The review's marks — pure, so each is tested apart from the markup.
 *
 *   `reasonMark` — WHY the write waits, as ONE mark, and only when the reason
 *                  is particular to this change: its short label ("Possible
 *                  duplicate"), its sentence behind it (on press), toned by
 *                  the ladder's ONE table (`GOVERNANCE_REASON_RULE_REACH`).
 *                  "Asks by default" / "Always asks a person" are gone: a
 *                  pending proposal already waits on the person.
 *   `undoMark`   — what approving cannot take back. Undo is the default, so
 *                  an undoable change draws NOTHING (founder, 2026-10-23: "Can
 *                  be undone … we will not need to showcase that"); only the
 *                  pod's own `revertable: false` earns a mark.
 *
 * The change itself is `proposal-record-model.ts`.
 */

import { isUuid } from "../../../lib/format";
import { objectReadsWide } from "../../_lib/object/object-width";
import { governanceReasonMark } from "@synap-core/types/proposals";
import { GOVERNANCE_REASON_RULE_REACH } from "@synap-core/types/trust-ladder";

/** One field of the pod's diff, read structurally. */
export interface ProposalChangeInput {
  path: string;
  label: string;
  operation: "create" | "update" | "delete" | "set";
  before?: unknown;
  after?: unknown;
  drift?: "unchanged" | "changed_since" | "unknown";
}

export type ReviewTone = "warning" | "primary" | "default" | "success";

/** A state, said as a short label; its sentence is disclosed on press. */
export interface ReviewMark {
  tone: ReviewTone;
  label: string;
  sentence: string;
}

/**
 * The reason a person decides, as one mark — only when it says something
 * particular about THIS change. A reason that only restates "this waits for
 * you" (the default, a rule of yours that asks, a human gate) has no label at
 * its one home (`GOVERNANCE_REASON_SHORT_LABELS`), and no mark is drawn: a
 * pending proposal is already waiting on the person. A stored sentence with no
 * code cannot be told apart either way, so it draws nothing.
 *
 * Tone: a floor the ladder never lets a rule widen (or an ambiguous code,
 * failing closed) is a warning; anything else is quiet.
 */
export function reasonMark(code: string | null | undefined): ReviewMark | null {
  const named = governanceReasonMark(code);
  if (!named) return null;
  const reach = Object.hasOwn(GOVERNANCE_REASON_RULE_REACH, named.code)
    ? GOVERNANCE_REASON_RULE_REACH[
        named.code as keyof typeof GOVERNANCE_REASON_RULE_REACH
      ]
    : undefined;
  const tone: ReviewTone =
    reach === "rule" || reach === "below" ? "default" : "warning";
  return { tone, label: named.label, sentence: named.sentence };
}

/**
 * The one consequence worth a mark: approving cannot be undone. `revertable`
 * is the pod's answer for this proposal (`revertableForRow`); `true` and
 * unknown draw nothing — undo is the default, and an unknown is not promised.
 */
export function undoMark(
  revertable: boolean | null | undefined
): ReviewMark | null {
  if (revertable !== false) return null;
  return {
    tone: "warning",
    label: "Can't be undone",
    sentence: "Approving applies it now, and it cannot be undone from here.",
  };
}

/**
 * Whether the review reads at a document's width. First, as wide as the
 * object it creates or changes: the proposal's subject, or a record it draws,
 * is of a kind whose own page reads wide (`objectReadsWide`, the rule the
 * object page reads too), so a proposed document opens at its document's
 * width (founder, 2026-11-03). Then, what it draws: a document's change, or
 * a tool argument or record field that is prose, code or a text diff (each
 * one's `wide`, set by its own model). A review of short values (a status
 * move, an app asking for a key, a few names) stays at the receiver's
 * default width. The page reads this as `READS_WIDE_ATTR`.
 */
export function reviewReadsWide(drawn: {
  /** The kind the proposal is about (`proposalSubjectKind`). */
  subjectKind: string | null;
  documentChanges: boolean;
  toolArguments: readonly { wide: boolean }[];
  records: readonly {
    kind: string | null;
    fields: readonly { wide: boolean }[];
  }[];
}): boolean {
  return (
    objectReadsWide(drawn.subjectKind) ||
    drawn.records.some((r) => objectReadsWide(r.kind)) ||
    drawn.documentChanges ||
    drawn.toolArguments.some((a) => a.wide) ||
    drawn.records.some((r) => r.fields.some((f) => f.wide))
  );
}

/** The object an approved create made, named so the page can open it. */
export interface CreatedObject {
  /** The object kind `openIn` opens (`document`, `entity`). */
  kind: string;
  id: string;
  title: string | null;
}

/** Target types the review can open after a create: id known, page hosted. */
const OPENABLE_CREATED: ReadonlySet<string> = new Set(["document", "entity"]);

/**
 * What an approved create made, when the page can open it: the proposal's own
 * `targetId` + `targetType` (the id the document was written under), so it
 * reads the same when the page is reopened later. A capture graph's target id
 * is not one object's, so it names nothing. `null` for anything else.
 */
export function createdObject(input: {
  status: string;
  action: string;
  targetType: string | null | undefined;
  targetId: string | null | undefined;
  title: string | null | undefined;
  graph: boolean;
}): CreatedObject | null {
  if (input.status !== "approved" && input.status !== "auto_approved") {
    return null;
  }
  if (input.action !== "create" || input.graph) return null;
  const kind = input.targetType ?? "";
  if (!OPENABLE_CREATED.has(kind)) return null;
  const id = input.targetId ?? "";
  if (!isUuid(id)) return null;
  return { kind, id, title: input.title?.trim() || null };
}

/** The object an update changes, named so the page can open it. */
export interface UpdatedObject {
  /** The object kind `openIn` opens (`document`, `session`, …). */
  kind: string;
  id: string;
  title: string | null;
}

/**
 * A proposal's `targetType` is its own word for what it changes; `/open` hosts
 * the same objects under its own. Only the kinds seen on real update proposals
 * are listed (document, entity, playbook, skill, and a session as
 * `focus_session`): a kind not here gets no door, never a guessed route.
 */
const OPEN_KIND_OF_TARGET: ReadonlyMap<string, string> = new Map([
  ["document", "document"],
  ["entity", "entity"],
  ["playbook", "playbook"],
  ["skill", "skill"],
  ["focus_session", "session"],
]);

/**
 * The existing object an UPDATE changes, when the page can open it. Unlike a
 * create (`createdObject`, which names something only once approved), an update
 * names its object at every status: the reviewer wants to open the thing being
 * changed BEFORE deciding, and the review page is not the object's page. A
 * create has no object yet, a delete may have none left, and a capture graph's
 * target id is not one object's, so those name nothing.
 */
export function updatedObject(input: {
  action: string;
  targetType: string | null | undefined;
  targetId: string | null | undefined;
  title: string | null | undefined;
  graph: boolean;
}): UpdatedObject | null {
  if (input.action !== "update" || input.graph) return null;
  // A Map, not an object: `targetType` comes from a stored row, and an object
  // literal answers "constructor" or "toString" with an inherited function.
  const kind = OPEN_KIND_OF_TARGET.get(input.targetType ?? "");
  if (!kind) return null;
  const id = input.targetId ?? "";
  if (!isUuid(id)) return null;
  return { kind, id, title: input.title?.trim() || null };
}
