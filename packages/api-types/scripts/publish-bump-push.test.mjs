/**
 * The publish workflow's version-bump push never runs the developer
 * pre-push hook (main red 37137fba, 5 Nov 2026): run 42025398081 published
 * @synap-core/types 1.12.13 and @synap-core/api-types 1.34.2, then its
 * "Commit version bumps" `git push` ran `.husky/pre-push`, whose main
 * typecheck refused it, so main stayed behind npm and every PR's Preflight
 * went red. The step sets the hook's documented bypass, and the hook honours it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/publish-types.yml"), "utf8");
const HOOK = readFileSync(join(ROOT, ".husky/pre-push"), "utf8");

/** The step's block: from its `- name:` line to the next step. */
function stepBlock(name) {
  const start = WORKFLOW.indexOf(`- name: ${name}`);
  expect(start, `step "${name}" exists`).toBeGreaterThan(-1);
  const next = WORKFLOW.indexOf("\n      - ", start + 1);
  return WORKFLOW.slice(start, next < 0 ? undefined : next);
}

describe("publish-types: the bump push skips the developer pre-push hook", () => {
  it("the step that pushes to main sets SYNAP_HOOK_SKIP=1 in its env", () => {
    const step = stepBlock("Commit version bumps");
    expect(step).toMatch(/push origin HEAD:main/);
    const env = step.slice(step.indexOf("env:"), step.indexOf("run: |"));
    expect(env).toMatch(/^\s+SYNAP_HOOK_SKIP: "1"$/m);
  });

  it("the hook skips everything on SYNAP_HOOK_SKIP=1, before any check runs", () => {
    const skipAt = HOOK.indexOf('[ "${SYNAP_HOOK_SKIP:-}" = "1" ] && skip');
    expect(skipAt).toBeGreaterThan(-1);
    expect(skipAt).toBeLessThan(HOOK.indexOf("refs=$(cat)"));
  });
});
