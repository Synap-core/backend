#!/usr/bin/env node
/**
 * release-gate-judge.mjs — the verdict of the job named "Release gate".
 *
 * Since 2026-10-29 (lane cispeed) the Release gate's work runs in parallel
 * "Release gate: <part>" jobs (ci.yml), and the job named exactly "Release
 * gate" (the required check; the one docker-publish.yml's ci-gate and the
 * merge queue's same-tree reuse read) judges them. A judge that passes on a
 * skipped sub-job would release a commit nobody built: GitHub reports a job
 * skipped by its `if:` as `skipped`, and a skipped required check as passed.
 *
 *   pass  every sub-job ended `success`. The image jobs too: since
 *         2026-10-29 (decision ffaafe15) a change that does not need the
 *         image still RUNS them, and they succeed through their logged "Not
 *         affected" step (ci.yml). Until then they were skipped and the judge
 *         accepted `skipped` for them (IMAGE_JOBS / IMAGE_DUE), a skip read
 *         as a pass.
 *   fail  any sub-job `failure`, `cancelled` (a timeout ends a job so),
 *         `skipped`, or with no result at all; fewer than two sub-jobs in
 *         `needs` (the scan saw nothing: never a vacuous pass).
 *
 * The sub-jobs are DERIVED: every job in `needs` except `changes` and
 * `preflight` (the jobs that decide, not the gate's work). A job added to the
 * judge's `needs:` is required by existing.
 *
 * Usage (ci.yml, job release-gate):
 *   env NEEDS=${{ toJSON(needs) }}
 *   node scripts/ci/release-gate-judge.mjs      exit 0 = pass, 1 = fail
 * Self-contained (node: builtins only): the judge job checks out this file
 * alone and runs no install.
 */
import { pathToFileURL } from "node:url";

/** Jobs the judge needs that are not part of the gate's work. */
export const DECIDERS = ["changes", "preflight"];

/**
 * @param {{ needs: Record<string, {result?: string}> }} input
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function judge({ needs }) {
  const lines = [];
  let ok = true;
  const subJobs = Object.keys(needs ?? {})
    .filter((id) => !DECIDERS.includes(id))
    .sort();
  if (subJobs.length < 2) {
    return {
      ok: false,
      lines: [
        `only ${subJobs.length} Release gate sub-job(s) in needs (${subJobs.join(", ") || "none"}): the judge saw nothing to judge`,
      ],
    };
  }
  for (const id of subJobs) {
    const result = needs[id]?.result ?? "";
    const pass = result === "success";
    if (!pass) ok = false;
    lines.push(`${pass ? "ok  " : "RED "} ${id}: ${result || "(no result)"}`);
  }
  return { ok, lines };
}

function main() {
  let needs;
  try {
    needs = JSON.parse(process.env.NEEDS ?? "");
  } catch (err) {
    console.log(
      `::error::NEEDS is not the needs context as JSON: ${err.message}`
    );
    process.exit(1);
  }
  const r = judge({ needs });
  for (const line of r.lines) console.log(line);
  if (!r.ok) {
    console.log(
      "::error::A Release gate job did not succeed: open the red job above for its failing step."
    );
    process.exit(1);
  }
  console.log("Release gate: every sub-job succeeded.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
