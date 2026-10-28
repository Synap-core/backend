/**
 * Review's words — the names of the review PACKAGES (the decision an item
 * asks, `../proposals/review-package.ts`), of the ways a Review page groups,
 * and of a package's layouts. Spelled once so pod-admin, the browser and relay
 * name a package the same way (B-6). `review-words.test.ts` holds the floor
 * that every package, grouping and layout has a row here.
 *
 * Pure + dependency-free (the vocabulary contract): keyed by plain strings,
 * the unions live with the classifier.
 */

import { humanizeToken } from "./index.js";

/** A package's name — the header a person reads ("Hand-offs"). */
export const REVIEW_PACKAGE_LABELS = {
  questions: "Questions",
  access: "Access & secrets",
  releases: "Releases",
  "how-things-work": "How things work",
  "data-changes": "Changes to your data",
  "hand-offs": "Hand-offs",
  knowledge: "Knowledge",
  bookkeeping: "Bookkeeping",
} as const satisfies Readonly<Record<string, string>>;

/** A package's words; an unknown package humanizes rather than leaks. */
export function resolveReviewPackageLabel(
  pkg: string | null | undefined
): string {
  if (!pkg) return "";
  return (
    (REVIEW_PACKAGE_LABELS as Readonly<Record<string, string>>)[pkg] ??
    humanizeToken(pkg)
  );
}

/** A grouping's name, as the "Group by" control reads it. */
export const REVIEW_GROUP_BY_LABELS = {
  package: "Package",
  work: "Work",
  agent: "Agent",
  time: "Time",
} as const satisfies Readonly<Record<string, string>>;

export function resolveReviewGroupByLabel(
  groupBy: string | null | undefined
): string {
  if (!groupBy) return "";
  return (
    (REVIEW_GROUP_BY_LABELS as Readonly<Record<string, string>>)[groupBy] ??
    humanizeToken(groupBy)
  );
}

/** A package layout's name, as the layout switch reads it. */
export const REVIEW_LAYOUT_LABELS = {
  list: "List",
  cards: "Ask cards",
  diff: "Diff",
  gallery: "Gallery",
  "by-agent": "By agent",
  "by-session": "By session",
} as const satisfies Readonly<Record<string, string>>;

export function resolveReviewLayoutLabel(
  layout: string | null | undefined
): string {
  if (!layout) return "";
  return (
    (REVIEW_LAYOUT_LABELS as Readonly<Record<string, string>>)[layout] ??
    humanizeToken(layout)
  );
}
