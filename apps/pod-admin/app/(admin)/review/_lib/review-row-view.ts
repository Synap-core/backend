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
import type { RequestFamily } from "../../../_lib/request/family";

export type ReviewRowVerb =
  | { kind: "answer" }
  | { kind: "review" }
  /** Its decision lives elsewhere: the row's door opens it there. */
  | { kind: "exit" }
  | null;

export type { RequestFamily };

/** The request's family (`../../../_lib/request/family.ts`), from what the row holds. */
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

/** The kind tile's accessible name (its kind noun), when the row draws one. */
export function tileNoun(
  view: Pick<RequestRowView, "what">
): string | undefined {
  const tile = view.what.find((p) => p.kind === "tile");
  return tile?.kind === "tile" ? tile.noun : undefined;
}

export function reviewRowView(
  row: ReviewRow,
  { showPackage = false }: { showPackage?: boolean } = {}
): ReviewRowView {
  const base = requestRow(row.lens);
  // The row draws no state mark (everything on this list waits on you): its
  // kind tile carries the family. A proposal's tile is the kind of thing it
  // creates or changes (a Person, a Rule), which only `proposals.list` names
  // (`proposalSubjectKind`); the lens row knows it only as "a proposal".
  const what = base.what
    .filter((p) => p.kind !== "state")
    .map((p) =>
      p.kind === "tile" && row.group !== "asks"
        ? {
            kind: "tile" as const,
            objectKind: row.nounKind,
            noun: resolveObjectNoun(row.nounKind),
          }
        : p
    );
  // Who asked, in the ONE requester sentence (`proposalRequester`, D1/M5):
  // a proposal's row names its requester the way its review does.
  const requester = row.group !== "asks" ? row.who : null;
  const who = requester
    ? base.who.map((p) =>
        p.kind === "door" && p.role === "by" ? { ...p, label: requester } : p
      )
    : base.who;
  const pkg = showPackage ? resolveReviewPackageLabel(row.package) : null;
  // A kind that reads the same word as its package (a Knowledge item in
  // Knowledge) says it once: the tile carries the kind.
  const kindNoun = tileNoun({ what }) ?? null;
  return {
    ...base,
    family: requestFamily(row),
    what,
    who,
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
