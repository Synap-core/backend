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
 *   pass  every sub-job ended `success`. A sub-job named in IMAGE_JOBS must
 *         succeed only when IMAGE_DUE is "true" (an image-relevant change);
 *         otherwise it must have been `skipped` (or `success`).
 *   fail  any sub-job `failure`, `cancelled` (a timeout ends a job so),
 *         `skipped` while it was due, or with no result at all; fewer than two
 *         sub-jobs in `needs` (the scan saw nothing: never a vacuous pass).
 *
 * The sub-jobs are DERIVED: every job in `needs` except `changes` and
 * `preflight` (the jobs that decide, not the gate's work). A job added to the
 * judge's `needs:` is required by existing.
 *
 * Usage (ci.yml, job release-gate):
 *   env NEEDS=${{ toJSON(needs) }}, IMAGE_JOBS="gate-deploy gate-image",
 *       IMAGE_DUE=true|false
 *   node scripts/ci/release-gate-judge.mjs      exit 0 = pass, 1 = fail
 * Self-contained (node: builtins only): the judge job checks out this file
 * alone and runs no install.
 */
import { pathToFileURL } from "node:url";

/** Jobs the judge needs that are not part of the gate's work. */
export const DECIDERS = ["changes", "preflight"];

/**
 * @param {{ needs: Record<string, {result?: string}>, imageJobs: string[], imageDue: boolean }} input
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function judge({ needs, imageJobs, imageDue }) {
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
  for (const id of imageJobs)
    if (!subJobs.includes(id)) {
      ok = false;
      lines.push(
        `${id}: named in IMAGE_JOBS but not in the judge's needs (renamed?)`
      );
    }
  for (const id of subJobs) {
    const result = needs[id]?.result ?? "";
    const due = !imageJobs.includes(id) || imageDue;
    const pass = due
      ? result === "success"
      : result === "skipped" || result === "success";
    if (!pass) ok = false;
    lines.push(
      `${pass ? "ok  " : "RED "} ${id}: ${result || "(no result)"}${due ? "" : " (not due: no image-relevant change)"}`
    );
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
  const imageJobs = (process.env.IMAGE_JOBS ?? "").split(/\s+/).filter(Boolean);
  const imageDue = process.env.IMAGE_DUE === "true";
  const r = judge({ needs, imageJobs, imageDue });
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
