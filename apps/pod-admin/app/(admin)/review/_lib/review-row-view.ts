/**
 * What a Review row DRAWS — the shared three-line request row
 * (`requestRow`, `@synap-core/types/needs-you`) of the row's lens row, plus
 * the two things only this page knows: the decision it asks (its package,
 * named outside "Group by Package") and its one verb.
 *
 *   what        the state mark, the kind tile, the question, its age
 *   holds       what it holds up and the status it cannot reach yet, else
 *               what answering unblocks, else the reason
 *   who/where   who asked (or what raised it) and where, each a door
 *
 * Marks and doors, never one joined sentence: it replaced `secondaryLine`
 * ("Questions · Owed · Claude Code on MacBook · Pod-run delivery · …"),
 * which joined eight values none of which opened anything (founder dogfood,
 * 16 Nov 2026; plan d717d6ac §1). Pure: the component only draws this.
 */

import { requestRow, type RequestRowView } from "@synap-core/types/needs-you";
import {
  resolveObjectNoun,
  resolveReviewPackageLabel,
} from "@synap-core/types/vocabulary";
import type { ReviewRow } from "./review-rows";

export type ReviewRowVerb =
  | { kind: "answer" }
  | { kind: "review" }
  /** Its decision lives elsewhere: the row's door opens it there. */
  | { kind: "exit" }
  | null;

/**
 * The request's family, drawn as its kind tile (one grammar, icon = kind):
 * a secret or connection to hand over, a change to approve, a question, a
 * step to approve (a go / no-go), an access request.
 */
export type RequestFamily =
  "secret" | "change" | "question" | "step" | "access";

export function requestFamily(row: ReviewRow): RequestFamily {
  if (row.group === "access") return "access";
  if (row.detail?.kind === "ask") {
    const mode = row.detail.slot.ask?.mode;
    return mode === "provide" ? "secret" : "question";
  }
  if (row.group === "asks") return "question";
  return row.package === "releases" ? "step" : "change";
}

export interface ReviewRowView extends RequestRowView {
  family: RequestFamily;
  /** The decision it asks, outside "Group by Package"; null when said already. */
  packageLabel: string | null;
  /** "and N more like it" for a cluster (`LensRow.repeat`); null for one thing. */
  repeat: string | null;
  /** The row's one verb. */
  action: ReviewRowVerb;
  /** May be approved from the row (routine, reversible, the viewer's own call). */
  inlineApprove: boolean;
}

export function reviewRowView(
  row: ReviewRow,
  { showPackage = false }: { showPackage?: boolean } = {}
): ReviewRowView {
  const base = requestRow(row.lens);
  // A proposal's tile is the kind of thing it creates or changes (a Person,
  // a Rule), which only `proposals.list` names (`proposalSubjectKind`); the
  // lens row knows it only as "a proposal".
  const what =
    row.group === "asks"
      ? base.what
      : base.what.map((p) =>
          p.kind === "tile"
            ? {
                kind: "tile" as const,
                objectKind: row.nounKind,
                noun: resolveObjectNoun(row.nounKind),
              }
            : p
        );
  const pkg = showPackage ? resolveReviewPackageLabel(row.package) : null;
  // A kind that reads the same word as its package (a Knowledge item in
  // Knowledge) says it once: the tile carries the kind.
  const tile = what.find((p) => p.kind === "tile");
  const kindNoun = tile?.kind === "tile" ? tile.noun : null;
  return {
    ...base,
    family: requestFamily(row),
    what,
    packageLabel: pkg && pkg !== kindNoun ? pkg : null,
    repeat: row.lens.repeat,
    action:
      row.detail === null
        ? null
        : row.detail.kind === "open"
          ? { kind: "exit" }
          : row.detail.kind === "ask"
            ? { kind: "answer" }
            : { kind: "review" },
    inlineApprove: row.inlineApprove,
  };
}
