/**
 * The roll workflow is DRY-RUN ONLY (.github/workflows/roll-siblings.yml, plan
 * b5820982 section 2 build step 3). Pins: dry_run defaults true; the file holds
 * no write permission and no write token; no step pushes, opens a PR or calls
 * a write API; the only roll.mjs command it runs is `plan`; every `uses:` is
 * pinned by a full sha; it runs on schedule and workflow_dispatch only.
 * Read as text on purpose (a parsed YAML would hide a commented-out trap).
 * NOT COVERED: that GitHub honours these settings at run time.
 * Named `*.tripwire.test.ts` so `pnpm tripwires` (CI) runs it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const FILE = fileURLToPath(
  new URL("../../.github/workflows/roll-siblings.yml", import.meta.url)
);
/** Pure checks over a workflow's text; each returns its problems. */
export function rollWorkflowProblems(text: string): string[] {
  const problems: string[] = [];
  const wf = parse(text) as {
    on: Record<string, any>;
    permissions?: Record<string, string>;
    jobs: Record<
      string,
      { permissions?: Record<string, string>; steps: any[] }
    >;
  };
  const code = text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

  if (wf.on.workflow_dispatch?.inputs?.dry_run?.default !== true)
    problems.push("dry_run must default to true");
  for (const trigger of Object.keys(wf.on))
    if (!["schedule", "workflow_dispatch"].includes(trigger))
      problems.push(`trigger ${trigger} is not schedule or workflow_dispatch`);

  const perms = [
    wf.permissions,
    ...Object.values(wf.jobs).map((j) => j.permissions),
  ];
  for (const p of perms)
    for (const [k, v] of Object.entries(p ?? {}))
      if (v !== "read") problems.push(`permission ${k}: ${v} (only read)`);
  if (wf.permissions?.contents !== "read")
    problems.push("top-level permissions must be contents: read");
  if (/permission-[a-z-]+:\s*(write|admin)/.test(code))
    problems.push("a minted token asks for write");

  if (
    /\b(git\s+(push|commit|tag)|gh\s+(pr|api|workflow|release)|createCommitOnBranch|gh-pr|pull-requests|git-auto-commit|create-pull-request|peter-evans)\b/.test(
      code
    )
  )
    problems.push("a step pushes, commits or opens a PR");
  if (/\bSYNAP_MERGE_BOT|ci-bots|REVERT_TOKEN/.test(code))
    problems.push(
      "the dry run must not hold the Merge Bot App's write secrets"
    );

  const rolls = [...code.matchAll(/roll\.mjs\s+(\S+)/g)].map((m) => m[1]);
  if (!rolls.length) problems.push("no roll.mjs call at all");
  for (const sub of rolls)
    if (sub !== "plan") problems.push(`roll.mjs ${sub}: only plan is allowed`);

  for (const m of code.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm))
    if (!m[1].startsWith("./") && !/@[0-9a-f]{40}$/.test(m[1]))
      problems.push(`${m[1]} is not pinned by a full sha`);
  return problems;
}

describe("roll-siblings.yml is dry-run only", () => {
  const text = readFileSync(FILE, "utf8");

  it("has no problem as committed", () => {
    expect(rollWorkflowProblems(text)).toEqual([]);
  });

  it("actually runs plan and checks out nothing but this repo", () => {
    expect(text).toMatch(/node scripts\/ci\/roll\.mjs plan/);
    expect(text.match(/actions\/checkout@/g)).toHaveLength(1);
  });

  // The guard is only worth having if it goes red: each mutation is one a
  // careless edit could make.
  const mutations: Array<[string, (t: string) => string, string]> = [
    [
      "contents: write",
      (t) =>
        t.replace(
          "permissions:\n  contents: read",
          "permissions:\n  contents: write"
        ),
      "permission contents: write",
    ],
    [
      "a push step",
      (t) => `${t}      - run: git push origin HEAD:roll/x\n`,
      "pushes, commits or opens a PR",
    ],
    [
      "a PR step",
      (t) => `${t}      - run: gh pr create --fill\n`,
      "pushes, commits or opens a PR",
    ],
    [
      "dry_run default false",
      (t) => t.replace("default: true", "default: false"),
      "dry_run must default to true",
    ],
    [
      "an unpinned action",
      (t) =>
        t.replace(
          /actions\/setup-node@[0-9a-f]{40}( # v[\d.]+)?/,
          "actions/setup-node@v4"
        ),
      "not pinned by a full sha",
    ],
    [
      "the apply command",
      (t) => t.replace("roll.mjs plan", "roll.mjs apply"),
      "only plan is allowed",
    ],
    [
      "a push trigger",
      (t) => t.replace("on:\n", "on:\n  push:\n    branches: [main]\n"),
      "is not schedule or workflow_dispatch",
    ],
    [
      "the merge bot's write secret",
      (t) =>
        t.replace(
          "CP_READ_TOKEN: ${{ steps.reader-token.outputs.token }}",
          "CP_READ_TOKEN: ${{ secrets.SYNAP_MERGE_BOT_KEY }}"
        ),
      "Merge Bot",
    ],
  ];
  for (const [name, mutate, expected] of mutations)
    it(`goes red on ${name}`, () => {
      const mutated = mutate(text);
      expect(mutated).not.toBe(text); // the mutation really changed the file
      expect(rollWorkflowProblems(mutated).join("\n")).toContain(expected);
    });
});
