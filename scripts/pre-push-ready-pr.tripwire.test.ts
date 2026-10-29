/**
 * F9 (29 Oct, pod document 9ca0c96b): a ready PR is never pushed without
 * preflight. These run the REAL hook (.husky/pre-push, as Husky runs it:
 * `sh -e <hook> <remote> <url>` from the pushing tree, ref lines on stdin)
 * in a throwaway git repo, with a fake `gh` (SYNAP_PRE_PUSH_GH) and a fake
 * scripts/preflight.mjs that records it ran and exits as told.
 *
 * Not covered: the real preflight's checks (scripts/preflight.tripwire.test.ts),
 * the real GitHub answer shape beyond the fields asked for, and Husky's own
 * runner (.husky/_/h: HUSKY=0 exits before this hook; the hook checks it too).
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import {
  isBackendRemote,
  pushedBranches,
  readyPr,
} from "./pre-push-ready-pr.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const HOOK = join(REPO, ".husky", "pre-push");
const ZERO = "0".repeat(40);
const BACKEND_SSH = "git@github.com:Synap-core/backend.git";

let dir: string;
let head: string;
const git = (...args: string[]) =>
  spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pre-push-"));
  git("init", "-q", "-b", "feat");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "scripts"));
  // The pushing tree's preflight: records its run and PR_BODY, exits as told.
  writeFileSync(
    join(dir, "scripts", "preflight.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "preflight-ran"))}, process.env.PR_BODY ?? "");
console.log("fake preflight: " + (process.env.FAKE_PREFLIGHT_EXIT ?? "0"));
process.exit(Number(process.env.FAKE_PREFLIGHT_EXIT ?? "0"));
`
  );
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "a");
  head = git("rev-parse", "HEAD");
  // The fake gh: answers `gh pr list` by FAKE_GH_MODE, logs each call.
  mkdirSync(join(dir, "bin"));
  writeFileSync(
    join(dir, "bin", "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(join(dir, "gh-calls"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = process.env.FAKE_GH_MODE;
const pr = (isDraft) => [{ number: 42, isDraft, state: "OPEN", body: "Pod session: x\\nDepends-On: control-plane-api#9" }];
if (mode === "fail") { console.error("error connecting to api.github.com"); process.exit(1); }
if (mode === "slow") { setTimeout(() => {}, 20000); return; }
process.stdout.write(JSON.stringify(mode === "ready" ? pr(false) : mode === "draft" ? pr(true) : []));
`
  );
  chmodSync(join(dir, "bin", "gh"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function push(
  opts: {
    gh?: string;
    preflightExit?: number;
    refs?: string;
    url?: string;
    env?: Record<string, string>;
  } = {}
) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "HUSKY" && k !== "SYNAP_HOOK_SKIP") env[k] = v;
  Object.assign(env, {
    SYNAP_PRE_PUSH_GH:
      opts.gh === "missing" ? join(dir, "no-such-gh") : join(dir, "bin", "gh"),
    FAKE_GH_MODE: opts.gh ?? "none",
    FAKE_PREFLIGHT_EXIT: String(opts.preflightExit ?? 0),
    // 1 s only for the hanging fake. The others get 20 s: on a loaded box
    // the node fake took over 8 s to start (29 Oct), read as "gh hanging".
    SYNAP_PRE_PUSH_GH_TIMEOUT_MS: opts.gh === "slow" ? "1000" : "20000",
    ...opts.env,
  });
  const r = spawnSync("sh", ["-e", HOOK, "origin", opts.url ?? BACKEND_SSH], {
    cwd: dir,
    env,
    encoding: "utf8",
    input: opts.refs ?? `refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`,
    timeout: 30_000,
  });
  const read = (f: string) =>
    existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null;
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    preflightBody: read("preflight-ran"),
    ghCalls: (read("gh-calls") ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]),
  };
}

// Each case spawns sh, git and three node processes: 30 s, not 5, on a loaded box.
describe(
  "pre-push: a ready PR is not pushed without preflight (F9)",
  { timeout: 30_000 },
  () => {
    it("ready PR, preflight green: pushes, after running the tree's preflight with the PR body", () => {
      const r = push({ gh: "ready" });
      expect(r.out).toContain("#42 is open and ready: running preflight");
      expect(r.status).toBe(0);
      expect(r.preflightBody).toContain("Depends-On: control-plane-api#9");
      expect(r.out).toMatch(/preflight green in [\d.]+s/);
    });

    it("ready PR, preflight red: REFUSES the push and names the bypass", () => {
      const r = push({ gh: "ready", preflightExit: 1 });
      expect(r.status).not.toBe(0);
      expect(r.preflightBody).not.toBeNull();
      expect(r.out).toContain("REFUSED: preflight is red for ready PR #42");
      expect(r.out).toContain("SYNAP_HOOK_SKIP=1 git push");
    });

    it("asks GitHub once, for this branch's open PRs on Synap-core/backend", () => {
      const r = push({ gh: "ready" });
      expect(r.ghCalls).toHaveLength(1);
      const argv = r.ghCalls[0];
      expect(argv.slice(0, 2)).toEqual(["pr", "list"]);
      expect(argv[argv.indexOf("-R") + 1]).toBe("Synap-core/backend");
      expect(argv[argv.indexOf("--head") + 1]).toBe("feat");
      expect(argv[argv.indexOf("--state") + 1]).toBe("open");
      expect(argv[argv.indexOf("--json") + 1].split(",")).toEqual(
        expect.arrayContaining(["isDraft", "state", "number", "body"])
      );
    });

    it.each([
      ["a draft PR", "draft", /draft PR #42: no preflight needed/],
      ["no PR", "none", /has no open PR: no preflight needed/],
    ])("%s: pushes without preflight", (_, gh, line) => {
      const r = push({ gh });
      expect(r.status).toBe(0);
      expect(r.out).toMatch(line);
      expect(r.preflightBody).toBeNull();
    });

    it.each([
      ["gh offline", "fail", /error connecting/],
      ["gh missing", "missing", /gh is not installed/],
      ["gh hanging", "slow", /more than 1 s/],
    ])(
      "%s: fail-open, with a warning",
      (_, gh, why) => {
        const r = push({ gh });
        expect(r.status).toBe(0);
        expect(r.out).toContain("WARNING: could not ask GitHub");
        expect(r.out).toMatch(why);
        expect(r.preflightBody).toBeNull();
      },
      15_000
    );

    it("preflight that cannot finish (a crash) is fail-open, never a refusal", () => {
      const r = push({ gh: "ready", preflightExit: 3 });
      expect(r.status).toBe(0);
      expect(r.out).toContain("WARNING: preflight did not finish (exit 3");
    });

    it("a tree with no scripts/preflight.mjs (an older branch): warns, pushes", () => {
      rmSync(join(dir, "scripts", "preflight.mjs"));
      const r = push({ gh: "ready" });
      expect(r.status).toBe(0);
      expect(r.out).toContain("has no scripts/preflight.mjs");
    });

    // The shared-tree plumbing flow: a commit pushed by sha while HEAD is
    // elsewhere. Preflight would check the wrong tree, so it warns and pushes
    // (a refusal would only teach SYNAP_HOOK_SKIP=1). preflightExit 1 proves
    // the red tree was not consulted.
    it("a ready PR pushed from another sha than the checked-out tree: WARNS, pushes, no preflight", () => {
      writeFileSync(join(dir, "b.txt"), "b\n");
      git("add", ".");
      git("commit", "-q", "-m", "b");
      const r = push({
        gh: "ready",
        preflightExit: 1,
        refs: `refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`, // HEAD~1
      });
      expect(r.status).toBe(0);
      expect(r.out).toContain("Preflight checks the tree, not that commit");
      expect(r.out).toContain("WITHOUT preflight");
      expect(r.preflightBody).toBeNull();
    });

    it.each([
      [
        "SYNAP_HOOK_SKIP=1",
        { SYNAP_HOOK_SKIP: "1" },
        "skipped, SYNAP_HOOK_SKIP=1",
      ],
      ["HUSKY=0", { HUSKY: "0" }, "skipped, HUSKY=0"],
    ])("%s skips everything, GitHub is not asked", (_, env, line) => {
      const r = push({ gh: "ready", preflightExit: 1, env });
      expect(r.status).toBe(0);
      expect(r.out).toContain(line);
      expect(r.ghCalls).toHaveLength(0);
    });

    it.each([
      ["another remote", { url: "git@github.com:someone/fork.git" }],
      [
        "a branch delete",
        { refs: `(delete) ${ZERO} refs/heads/feat ${head}\n` },
      ],
      ["a tag", { refs: `refs/tags/v1 ${head} refs/tags/v1 ${ZERO}\n` }],
    ])("%s: not this firewall's, GitHub is not asked", (_, o) => {
      const r = push({ gh: "ready", preflightExit: 1, ...o });
      expect(r.status).toBe(0);
      expect(r.ghCalls).toHaveLength(0);
    });

    it("a push to main keeps its own path (no PR lookup; no install → skipped)", () => {
      const r = push({
        gh: "ready",
        preflightExit: 1,
        refs: `refs/heads/main ${head} refs/heads/main ${ZERO}\n`,
      });
      expect(r.ghCalls).toHaveLength(0);
      expect(r.status).toBe(0);
      expect(r.out).toContain("skipped, no node_modules");
    });

    it("a feature branch still skips the main typecheck after its preflight", () => {
      const r = push({ gh: "none" });
      expect(r.out).toContain("skipped, not a push to main");
    });
  }
);

describe("pre-push-ready-pr: the pure parts", () => {
  it("reads git's ref lines: branches created or updated, main and deletes excluded", () => {
    const a = "a".repeat(40);
    expect(
      pushedBranches(
        [
          `refs/heads/x ${a} refs/heads/fix/y ${ZERO}`,
          `refs/heads/main ${a} refs/heads/main ${ZERO}`,
          `(delete) ${ZERO} refs/heads/old ${a}`,
          `refs/tags/v1 ${a} refs/tags/v1 ${ZERO}`,
          "",
        ].join("\n")
      )
    ).toEqual([{ branch: "fix/y", sha: a, localRef: "refs/heads/x" }]);
  });

  it("knows the backend remote in its spellings, and nothing else", () => {
    for (const u of [
      "git@github.com:Synap-core/backend.git",
      "https://github.com/Synap-core/backend.git",
      "https://github.com/synap-core/backend",
      "ssh://git@github.com/Synap-core/backend.git",
    ])
      expect(isBackendRemote(u), u).toBe(true);
    for (const u of [
      "git@github.com:Synap-core/backend-fork.git",
      "git@github.com:Synap-core/app-bases.git",
      "",
      undefined,
    ])
      expect(isBackendRemote(u), String(u)).toBe(false);
  });

  it("only an open, non-draft PR is ready", () => {
    expect(readyPr([{ number: 1, isDraft: true, state: "OPEN" }])).toBeNull();
    expect(
      readyPr([{ number: 2, isDraft: false, state: "CLOSED" }])
    ).toBeNull();
    expect(
      readyPr([{ number: 3, isDraft: false, state: "OPEN" }])?.number
    ).toBe(3);
    expect(readyPr([])).toBeNull();
  });
});
