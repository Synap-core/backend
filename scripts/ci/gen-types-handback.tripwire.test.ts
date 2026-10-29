/**
 * F10 (29 Oct, pod document 9ca0c96b): on a red "Verify generated API types"
 * step, CI uploads the file the generator produced and prints the command
 * that applies it. The two ways that command breaks for real:
 *   - it downloads an artifact name the upload step does not use;
 *   - it downloads straight over the committed file, which gh refuses
 *     (gh 2.87: "error extracting …: file exists", reproduced 29 Oct).
 * Read from ci.yml's text (the repo has no YAML parser at its root). Not
 * covered: the upload and `gh run download` themselves on a real red run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const CI = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
const FILE = "packages/api-types/src/generated.d.ts";

/** One step's text, from its `- name:` line to the next step. */
function step(name: string) {
  const i = CI.indexOf(`      - name: ${name}\n`);
  if (i < 0) return "";
  const j = CI.indexOf("\n      - name: ", i + 1);
  return CI.slice(i, j < 0 ? undefined : j + 1);
}

describe("ci.yml: the printed fix applies the uploaded API types (F10)", () => {
  const upload = step("Upload the regenerated API types");
  const how = step("How to apply the regenerated API types");
  const uploaded = /\n {10}name: ([\w-]+)\n/.exec(upload)?.[1];
  const fix = /\n {10}FIX: (.+)\n/.exec(how)?.[1] ?? "";

  it("finds both steps, the uploaded name and the command", () => {
    expect(upload).toContain(`path: ${FILE}\n`);
    expect(uploaded).toBeTruthy();
    expect(fix).toContain("gh run download ");
  });

  it("the command downloads the artifact the upload step names", () => {
    expect(/ -n ([\w-]+) /.exec(fix)?.[1]).toBe(uploaded);
  });

  it("the command downloads beside the file, then moves it over the committed one", () => {
    const dir = / -D (\S+(?: \S+ \}\})?) /.exec(fix)?.[1] ?? "";
    expect(dir).not.toBe("");
    expect(dir.startsWith("packages/")).toBe(false);
    expect(fix.endsWith(`&& mv ${dir}/generated.d.ts ${FILE}`)).toBe(true);
  });
});
