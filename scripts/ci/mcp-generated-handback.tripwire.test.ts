/**
 * F11 (26 Nov 2026): a PR that changes an MCP tool goes red on the manifest
 * and the token budget. CI regenerates the two files and
 * uploads them as the `mcp-generated` artifact; `scripts/ci/apply-ci-artifacts.sh`
 * applies it. What breaks for real:
 *   - the upload step names an artifact the apply script does not download;
 *   - a file is regenerated but not collected, so the artifact misses it;
 *   - the apply script copies a file name the artifact does not hold;
 *   - the regenerate step runs a script that no longer exists (the door tool
 *     names are derived from the tool definitions since the defineTool
 *     registry, so their generator was deleted).
 * Read from ci.yml's text (no YAML parser at the root). Not covered: the upload
 * and the download on a real red run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const CI = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
const APPLY = readFileSync(
  join(REPO, "scripts/ci/apply-ci-artifacts.sh"),
  "utf8"
);

/** The files the artifact must carry: the committed generated MCP files. */
const FILES = ["mcp-tools.manifest.json", "token-budget.baseline.json"];

function step(name: string) {
  const i = CI.indexOf(`      - name: ${name}\n`);
  if (i < 0) return "";
  const j = CI.indexOf("\n      - name: ", i + 1);
  return CI.slice(i, j < 0 ? undefined : j + 1);
}

describe("ci.yml: the MCP generated files are handed back (F11)", () => {
  const regen = step("Regenerate the MCP generated files (PRs)");
  const collect = step("Collect the regenerated MCP files");
  const upload = step("Upload the regenerated MCP files");

  it("the three steps exist (non-vacuity)", () => {
    expect(regen).not.toBe("");
    expect(collect).not.toBe("");
    expect(upload).not.toBe("");
  });

  it("regenerates both files", () => {
    expect(regen).toContain("gen-manifest.ts");
    expect(regen).toContain("token-budget.test.ts");
    expect(regen).toMatch(/UPDATE_TOKEN_BUDGET:\s*"1"/);
  });

  it("every script the regenerate step runs exists (packages/api)", () => {
    const scripts = [...regen.matchAll(/\bsrc\/[\w./-]+\.ts\b/g)].map(
      (m) => m[0]
    );
    // Non-vacuity: the generator and the budget test at least.
    expect(scripts.length).toBeGreaterThanOrEqual(2);
    for (const s of scripts)
      expect(existsSync(join(REPO, "packages/api", s)), s).toBe(true);
  });

  it("collects each of the files by its committed path", () => {
    for (const f of FILES) expect(collect, f).toContain(f);
    // The committed paths exist in the repo, so a rename cannot orphan a name.
    for (const f of FILES) {
      expect(
        readFileSync(
          join(REPO, "packages/api/src/routers/mcp/tools", f),
          "utf8"
        ).length,
        f
      ).toBeGreaterThan(0);
    }
  });

  it("uploads the artifact the apply script downloads, and runs on a red too", () => {
    // The WHOLE name, to the end of the line: a `\b` also matches `mcp-generated-x`.
    expect(upload).toMatch(/^\s+name:\s*mcp-generated\s*$/m);
    expect(upload).toMatch(/if:\s*always\(\)/);
    expect(APPLY).toContain("grep -qx mcp-generated");
    expect(APPLY).toContain("fetch mcp-generated");
  });

  it("the apply script puts back every file the artifact holds", () => {
    for (const f of FILES) expect(APPLY, f).toContain(f);
  });
});
