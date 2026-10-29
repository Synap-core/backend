/**
 * F10 (29 Oct, pod document 9ca0c96b): on a red "Verify generated API types"
 * step, CI hands back the file the generator produced, so the fix is one
 * download and no local build. CI never commits to a branch.
 *
 * Read from ci.yml's text (the repo has no YAML parser at its root): the
 * steps between "Verify generated API types are up to date" and the next
 * step of that job. The drift step's own shell runs for real in a throwaway
 * git repo. Not covered: GitHub's artifact upload and `gh run download`
 * themselves (checked by hand on 29 Oct: gh 2.87 refuses to overwrite an
 * existing file, hence the download-beside-then-move command).
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const CI = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
const FILE = "packages/api-types/src/generated.d.ts";

const start = CI.indexOf(
  "      - name: Verify generated API types are up to date\n"
);
const end = CI.indexOf("      - name: Validate migrations\n", start);
const steps = CI.slice(start, end);
/** One step's text, from its `- name:` line to the next step. */
const step = (name: string) => {
  const i = steps.indexOf(`      - name: ${name}\n`);
  if (i < 0) return "";
  const j = steps.indexOf("\n      - name: ", i + 1);
  return steps.slice(i, j < 0 ? undefined : j + 1);
};
const VERIFY = step("Verify generated API types are up to date");
const DRIFT = step("Hand back the regenerated API types (on a red)");
const UPLOAD = step("Upload the regenerated API types");
const HOW = step("How to apply the regenerated API types");

describe("ci.yml hands back the regenerated API types on a red (F10)", () => {
  it("finds the verify step and the three hand-back steps after it, in one job", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // no job boundary inside the slice
    expect(steps).not.toMatch(/\n {2}[a-z][\w-]*:\n/);
    for (const s of [VERIFY, DRIFT, UPLOAD, HOW]) expect(s).not.toBe("");
    expect(VERIFY).toContain("run: pnpm --filter @synap/api gen-types:check");
  });

  it("each hand-back step runs only after THAT step went red, and only on a real drift", () => {
    const id = /\n {8}id: ([\w-]+)\n/.exec(VERIFY)?.[1];
    const driftId = /\n {8}id: ([\w-]+)\n/.exec(DRIFT)?.[1];
    expect(id).toBeTruthy();
    expect(driftId).toBeTruthy();
    expect(DRIFT).toContain(
      `if: failure() && steps.${id}.outcome == 'failure'`
    );
    for (const s of [UPLOAD, HOW])
      expect(s).toContain(
        `if: failure() && steps.${driftId}.outputs.drift == 'true'`
      );
  });

  it("uploads the generated file under the name the printed command downloads", () => {
    const name = /\n {10}name: ([\w-]+)\n/.exec(UPLOAD)?.[1];
    expect(UPLOAD).toContain(`path: ${FILE}\n`);
    expect(UPLOAD).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} /);
    const fix = /\n {10}FIX: (.+)\n/.exec(HOW)?.[1] ?? "";
    expect(fix).toContain(`gh run download \${{ github.run_id }} `);
    expect(fix).toContain(` -n ${name} `);
    // never straight into the source dir: gh refuses to overwrite the file
    expect(fix).not.toMatch(/-D packages\/api-types\/src\b/);
    // downloads beside, into the same dir it then moves from
    const dir = / -D (\S+(?: \S+ \}\})?) /.exec(fix)?.[1];
    expect(dir).toBeTruthy();
    expect(fix.endsWith(`&& mv ${dir}/generated.d.ts ${FILE}`)).toBe(true);
    expect(HOW).toContain("${FIX}");
  });

  // 20 s, not vitest's 5: each case spawns git and bash, slow on a loaded box.
  describe("the drift step's shell", { timeout: 20_000 }, () => {
    const script = (() => {
      const m = /\n {8}run: \|\n((?: {10}.*\n)+)/.exec(DRIFT);
      return (m?.[1] ?? "").replace(/^ {10}/gm, "");
    })();
    const runIn = (mutate: boolean) => {
      const dir = mkdtempSync(join(tmpdir(), "gen-types-drift-"));
      try {
        const git = (...a: string[]) =>
          spawnSync("git", a, { cwd: dir, encoding: "utf8" });
        git("init", "-q");
        git("config", "user.email", "t@example.com");
        git("config", "user.name", "t");
        mkdirSync(join(dir, "packages/api-types/src"), { recursive: true });
        writeFileSync(join(dir, FILE), "export type A = 1;\n");
        git("add", ".");
        git("commit", "-q", "-m", "a");
        if (mutate) writeFileSync(join(dir, FILE), "export type A = 2;\n");
        const out = join(dir, "out");
        writeFileSync(out, "");
        const r = spawnSync("bash", ["-e", "-c", script], {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, GITHUB_OUTPUT: out },
        });
        return { status: r.status, output: readFileSync(out, "utf8") };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("is the step's real script", () => {
      expect(script).toContain(`git diff --quiet -- ${FILE}`);
    });
    it("a regenerated file that differs: drift=true", () => {
      expect(runIn(true)).toEqual({ status: 0, output: "drift=true\n" });
    });
    it("a generation that failed before writing: drift=false, nothing uploaded", () => {
      expect(runIn(false)).toEqual({ status: 0, output: "drift=false\n" });
    });
  });
});
