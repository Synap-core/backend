#!/usr/bin/env node
/**
 * publish-guard — `prepublishOnly` of @synap-core/api-types: refuses a publish
 * from anywhere but the publish-types workflow.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * 2026-10-28: @synap-core/api-types was published to npm by hand, ahead of the
 * version on main. Every backend PR then went red on the publish-freshness
 * tripwire (scripts/check-publish-freshness.mjs) until a PR brought main up
 * to npm (pod caution 6b19d446). The one publish door is
 * .github/workflows/publish-types.yml (Trusted Publishing, provenance, the
 * drift-aware bump that keeps main and npm in step).
 *
 * ── WHAT IT DOES NOT STOP ────────────────────────────────────────────────────
 * It is a lifecycle script, so it is a guard rail, not a lock:
 *   - `npm publish --ignore-scripts` / `pnpm publish --ignore-scripts` skip it;
 *   - `npm publish <tarball>` runs no script of this package.json;
 *   - anyone can set GITHUB_ACTIONS and GITHUB_WORKFLOW_REF by hand.
 * The lock is npm's per-package "Require trusted publishing" setting (no token
 * can publish), which only an npm owner of the package can turn on.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const WORKFLOW =
  /^Synap-core\/backend\/\.github\/workflows\/publish-types\.yml@/;

/** True only inside a GitHub Actions run of publish-types.yml in Synap-core/backend. */
export function publishAllowed(env) {
  return (
    env.GITHUB_ACTIONS === "true" &&
    WORKFLOW.test(env.GITHUB_WORKFLOW_REF ?? "")
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!publishAllowed(process.env)) {
    console.error(
      [
        "✗ @synap-core/api-types is published ONLY by .github/workflows/publish-types.yml.",
        "  A hand publish puts npm ahead of main, and every backend PR goes red on the",
        "  api-types publish-freshness check until main catches up (2026-10-28).",
        "  To ship: run the workflow (Actions → Publish Type Packages, or a v* tag).",
      ].join("\n")
    );
    process.exit(1);
  }
  console.log(
    `publish-guard: publishing from ${process.env.GITHUB_WORKFLOW_REF}`
  );
}
