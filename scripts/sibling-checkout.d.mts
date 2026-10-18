/** Types for sibling-checkout.mjs — see that file for the resolution order. */

export type SiblingRepo = "synap-app" | "synap-control-plane-api";

/** The root of THIS checkout (the directory holding `scripts/`). */
export const BACKEND_ROOT: string;

/** Every directory name a repo is checked out under, and its override var. */
export const SIBLINGS: Record<SiblingRepo, { env: string; names: string[] }>;

/** Absolute root of `repo`'s checkout, or null when none is present. */
export function siblingCheckout(repo: SiblingRepo): string | null;

/** Whether an absent sibling is a failure here (CI, unless acknowledged). */
export function siblingRequired(): boolean;

/** The line a skipped guard prints, naming what is missing and how to fix it. */
export function siblingSkipReason(repo: SiblingRepo, guard: string): string;
