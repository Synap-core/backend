/**
 * THE DEFAULT PHASE SKELETON a new playbook starts with.
 *
 * ── Why a default at all ───────────────────────────────────────────────────
 * Measured on the live pod 2026-09-21: of 29 playbooks, 10 declared stages and
 * 19 did not — and FOUR of those 19 had an ordered process written into their
 * `goalTemplate` PROSE instead ("Research a Question" spelled out five numbered
 * steps; "Client Onboarding" seven; "Lead Outreach" five; "CRM Hygiene" two
 * passes). Authors already wanted phases. The structure simply was not offered
 * where they were looking, so the steps landed in a prompt string where no
 * gate, no criterion and no UI can reach them.
 *
 * ── Why THESE three ────────────────────────────────────────────────────────
 * Every one of the 8 real staged playbooks on that pod already ran
 * gather -> settle, in its own words: Sweep->Handoff, Discover->Decide,
 * Brainstorming->Finishing, Detect->Verify, Kickoff->Validation,
 * Diagnose->Handoff, Understand->Confirm, Sourced->Qualified. The triad is not
 * a taxonomy of work (a discriminator constant across every instance
 * discriminates nothing) — it is the DEFAULT SEQUENCE, which is exactly what a
 * starting point should be.
 *
 * ── It is a STARTING POINT, never a contract ───────────────────────────────
 * Every field here is editable and every stage is deletable on the playbook's
 * Definition facet. A playbook that keeps all three unchanged and a playbook
 * that deletes all three are both correct. Nothing reads these keys back: no
 * code may branch on `gather`/`work`/`review`, or this quietly becomes the
 * closed work-type enum that was removed on 2026-09-21 wearing a new hat.
 *
 * `category` is the closed cross-playbook rollup axis and is REQUIRED at every
 * write boundary, so it is spelled here rather than left to a default.
 */

/**
 * A stage as the create doors accept it. Structural on purpose: this package is
 * dependency-free and must not import the playbooks package.
 *
 * ⚠️ A `type` ALIAS, deliberately — NOT an `interface`. The write door's schema
 * is a `z.looseObject`, so its inferred type carries a catchall
 * `[x: string]: unknown`. TypeScript gives an implicit index signature to a
 * type alias of an object literal but NEVER to an interface, so declaring this
 * as an interface makes it unassignable to the door's own input type — the
 * value is correct, the door accepts it at runtime, and the build still fails.
 * That cost a full browser typecheck to find, because only the CONSUMER sees
 * both ends: this package and the UI package each typecheck clean on their own.
 */
export type DefaultPhase = {
  key: string;
  name: string;
  category: "planned" | "started" | "completed";
  description: string;
};

export const DEFAULT_PLAYBOOK_PHASES: readonly DefaultPhase[] = [
  {
    key: "gather",
    name: "Gather",
    category: "planned",
    description: "What has to be known or decided before the work can start.",
  },
  {
    key: "work",
    name: "Work",
    category: "started",
    description: "The work itself.",
  },
  {
    key: "review",
    name: "Review",
    category: "completed",
    description: "Check what came out against what was asked for.",
  },
] as const;

/** A fresh copy, because the caller hands this to a form that will mutate it. */
export function defaultPlaybookPhases(): DefaultPhase[] {
  return DEFAULT_PLAYBOOK_PHASES.map((p) => ({ ...p }));
}
