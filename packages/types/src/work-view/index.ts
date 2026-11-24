/**
 * work-view — the ONE shared derivation of the Work view (plan 5207fbb6 "one
 * timeline for Work", 16 Nov 2026): what the browser and Relay draw a job, a
 * goal and the needs-you headline with. Pure TS, no React; it builds on
 * `needs-you`, `units`, `activity`, `goal` and `vocabulary`.
 *
 *   requestsOf     the needs-you headline as requests: rolled up to the
 *                  parent job, merged, batched, capped at 5 (`./requests.ts`);
 *   activityLine   one Activity line, Summary / Milestones / Trace
 *                  (`./activity-line.ts`);
 *   jobBranches    child jobs as forks; PRs and blockers as marks
 *                  (`./branches.ts`);
 *   markOf         the one tone + glyph, from the existing doors (`./mark.ts`);
 *   entryOf        one line entry as the ONE display entry: who, when, words,
 *                  mark, door (`./entry.ts`);
 *   groupEntries   fold checks into their pull request row (red stands alone),
 *                  group by day or by Job (`./entry.ts`);
 *   nextStepsOf    what a blocker offers, at most 3, each a person's tap
 *                  (`./next-steps.ts`).
 *
 * User words come from `@synap-core/types/vocabulary`, never from here: a
 * request is the `proposal` noun ("Request"), a child job is a Job, folded as
 * `resolveJobsStartedHereLabel(n)` ("3 jobs started from here").
 */

export * from "./requests.js";
export * from "./activity-line.js";
export * from "./branches.js";
export * from "./mark.js";
export * from "./entry.js";
export * from "./next-steps.js";
