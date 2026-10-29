/**
 * A review's MARK: a state said as a short label, its sentence disclosed on
 * press (`DisclosedMark`, `./review-parts.tsx`). Pure, so models
 * (`proposal-review-model.ts`) build marks without a React import.
 */

export type ReviewTone = "warning" | "primary" | "default" | "success";

/** A state, said as a short label; its sentence is disclosed on press. */
export interface ReviewMark {
  tone: ReviewTone;
  label: string;
  sentence: string;
}
