/** Types for sibling-checkout.mjs — see that file for the resolution order. */

/** A directory of scripts/layout/layout.json other than synap-backend. */
export type SiblingRepo =
  | "synap-app"
  | "synap-control-plane-api"
  | "browser"
  | "relay-app"
  | "synap-cli"
  | "synap-landing"
  | "synap-control-plane-dashboard"
  | "synap-intelligence-service"
  | "synap-bridge"
  | "site-content-studio";

/** The root of THIS checkout (the directory holding `scripts/`). */
export const BACKEND_ROOT: string;

/** Every directory name a repo is checked out under, and its override var. */
export const SIBLINGS: Record<SiblingRepo, { env: string; names: string[] }>;

/** Absolute root of `repo`'s checkout, or null when none is present. */
export function siblingCheckout(repo: SiblingRepo): string | null;

/**
 * Warn (once per repo, never throw) when the checkout at `dir` is not at the
 * commit sibling-pins.json pins `repo` to (`pinsFile`: that file by default).
 */
export function warnIfOffPin(
  repo: SiblingRepo,
  dir: string,
  pinsFile?: string
): void;

/** Whether an absent sibling is a failure here (CI, unless acknowledged). */
export function siblingRequired(): boolean;

/** The line a skipped guard prints, naming what is missing and how to fix it. */
export function siblingSkipReason(repo: SiblingRepo, guard: string): string;
