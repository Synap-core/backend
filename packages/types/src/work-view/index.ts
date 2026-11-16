/**
 * work-view — the ONE shared derivation of the Work view (plan 5207fbb6 "one
 * timeline for Work", 16 Nov 2026): what the browser, Relay and pod admin all
 * draw a job, a goal and the needs-you headline with. Pure TS, no React; it
 * builds on `needs-you`, `units`, `activity` and `vocabulary`.
 *
 *   requestsOf     the needs-you headline as requests: merged, rolled up to
 *                  the parent job, batched, capped at 5 (`./requests.ts`);
 *   activityLine   one Activity line, Summary / Milestones / Trace
 *                  (`./activity-line.ts`);
 *   jobBranches    child jobs as forks; PRs and blockers as marks
 *                  (`./branches.ts`);
 *   markOf         the one tone + glyph, from `resolveUnitState` (`./mark.ts`).
 *
 * User words: Request (`resolveObjectNoun("request")`, the `proposal` row),
 * Branch (`resolveObjectNoun("branch")`), Job, Activity — through
 * `@synap-core/types/vocabulary`, never here.
 */

export * from "./requests.js";
export * from "./activity-line.js";
export * from "./branches.js";
export * from "./mark.js";
