/**
 * release-gate-wait.mjs decides whether a pod may get a commit (founder,
 * 2026-10-29, "One trunk, three CI tiers": only a main commit whose
 * POST-MERGE run was all green). A wrong "pass" ships a commit main's full
 * run never cleared, the very gap the PR tier opens; a wrong "fail" makes
 * someone re-run the release by hand (runs 40760093657, 40704054177). This
 * pins the verdict for every state GitHub reports, the wait loop, the
 * nightly's one-read exit codes, and the red-main culprit range.
 * Named `*.tripwire.test.ts` so `pnpm tripwires` (CI) runs it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_CHECKS,
  culpritRange,
  decide,
  runState,
  waitForReleaseGate,
  // @ts-expect-error — plain ESM script, no declarations
} from "./release-gate-wait.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

type Check = { name: string; status: string; conclusion: string | null };
const check = (name: string, conclusion: string | null = "success"): Check => ({
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
});
const green = () => REQUIRED_CHECKS.map((n: string) => check(n));
const run = (
  checks: Check[],
  status = "completed",
  conclusion: string | null = "success"
) => ({
  status,
  conclusion,
  html_url: "https://github.com/x/y/actions/runs/1",
  checks,
});
const withCheck = (name: string, conclusion: string | null) =>
  green().map((c: Check) => (c.name === name ? check(name, conclusion) : c));

describe("release-gate-wait: the rule", () => {
  it("the required checks are the ruleset's, all four", () => {
    const sh = readFileSync(
      join(REPO, "scripts/apply-main-protection.sh"),
      "utf8"
    );
    const required = [
      ...(/^REQUIRED_CHECKS=\((.+)\)$/m.exec(sh)?.[1] ?? "").matchAll(
        /"([^"]+)"/g
      ),
    ].map((m) => m[1]);
    expect(required.length).toBe(4);
    expect([...REQUIRED_CHECKS].sort()).toEqual([...required].sort());
  });
});

describe("release-gate-wait: the verdict for one read", () => {
  it("no post-merge run: fails at once (a commit never on main never reaches a pod)", () => {
    const d = decide({ pushRuns: [] });
    expect(d.verdict).toBe("fail");
    expect(d.reason).toContain("No post-merge CI run");
  });

  it("all four required checks success on one push run: passes", () => {
    expect(decide({ pushRuns: [run(green())] }).verdict).toBe("pass");
  });

  // Until 2026-10-29 a green Release gate alone passed. Each row rules that
  // rule out: the gate is green and one of the other three is not.
  it.each(["Full suite", "API e2e", "Reference docs are current"])(
    "a green Release gate with a red %s is never a pass",
    (name) => {
      const d = decide({ pushRuns: [run(withCheck(name, "failure"))] });
      expect(d.verdict).toBe("fail");
      expect(d.reason).toContain(`${name}: failure`);
    }
  );

  it("any ending but success is not a pass (skipped, neutral, cancelled...)", () => {
    for (const c of [
      "failure",
      "skipped",
      "cancelled",
      "neutral",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
    ])
      expect(
        decide({ pushRuns: [run(withCheck("Full suite", c))] }).verdict,
        c
      ).toBe("fail");
  });

  it("a finished run missing a required check: fails (it never ran there)", () => {
    expect(decide({ pushRuns: [run(green().slice(1))] }).verdict).toBe("fail");
  });

  it("a run in progress, nothing red yet: waits; a required check not created yet: waits", () => {
    const partial = [check("Release gate"), check("Full suite", null)];
    expect(
      decide({ pushRuns: [run(partial, "in_progress", null)] }).verdict
    ).toBe("wait");
    expect(decide({ pushRuns: [run([], "queued", null)] }).verdict).toBe(
      "wait"
    );
  });

  it("a red required check fails at once, even while its run is still going", () => {
    const checks = [
      check("Release gate", "failure"),
      check("Full suite", null),
    ];
    expect(
      decide({ pushRuns: [run(checks, "in_progress", null)] }).verdict
    ).toBe("fail");
  });

  it("an old red run and a re-run in progress: waits; any all-green run: passes", () => {
    const red = run(withCheck("API e2e", "failure"));
    expect(
      decide({ pushRuns: [run([], "in_progress", null), red] }).verdict
    ).toBe("wait");
    expect(decide({ pushRuns: [red, run(green())] }).verdict).toBe("pass");
  });

  it("runState names each check", () => {
    expect(runState(run(withCheck("Full suite", "failure"))).lines).toEqual([
      "Release gate: success",
      "Full suite: failure",
      "API e2e: success",
      "Reference docs are current: success",
    ]);
  });
});

describe("release-gate-wait: the wait loop", () => {
  const clock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };
  const sequence = (reads: object[]) => {
    let i = 0;
    return () => reads[Math.min(i++, reads.length - 1)];
  };

  it("queued, then in progress, then all green: passes", async () => {
    const c = clock();
    const r = await waitForReleaseGate({
      read: sequence([
        { pushRuns: [run([], "queued", null)] },
        { pushRuns: [run([check("Release gate", null)], "in_progress", null)] },
        { pushRuns: [run(green())] },
      ]),
      ...c,
      intervalMs: 60_000,
      timeoutMs: 90 * 60_000,
    });
    expect(r.ok).toBe(true);
    expect(c.now()).toBe(2 * 60_000);
  });

  it("still running after the timeout: fails, saying it timed out", async () => {
    const c = clock();
    const r = await waitForReleaseGate({
      read: () => ({ pushRuns: [run([], "in_progress", null)] }),
      ...c,
      intervalMs: 60_000,
      timeoutMs: 90 * 60_000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Waited 90 min");
    expect(c.now()).toBeLessThanOrEqual(90 * 60_000);
  });

  it("a failed GitHub read fails the step and is never taken for 'no run'", async () => {
    const r = await waitForReleaseGate({
      read: () => {
        throw new Error("HTTP 502");
      },
      ...clock(),
      intervalMs: 60_000,
      timeoutMs: 90 * 60_000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("GitHub read failed");
    expect(r.reason).toContain("HTTP 502");
  });
});

describe("release-gate-wait: the culprit range", () => {
  it("walks back to the last all-green commit; every commit before it is a suspect", () => {
    const verdicts: Record<string, string> = {
      c: "fail",
      b: "wait",
      a: "pass",
    };
    expect(
      culpritRange(["c", "b", "a", "z"], (s: string) => ({
        verdict: verdicts[s],
      }))
    ).toEqual({ lastGreen: "a", suspects: ["c", "b"] });
    expect(culpritRange(["c"], () => ({ verdict: "fail" }))).toEqual({
      lastGreen: null,
      suspects: ["c"],
    });
  });
});

/**
 * The seam: the real script, run as the workflows run it, reading the real
 * GitHub wire shape through a fake `gh` on PATH. The fake answers the n-th
 * read of each endpoint (one per commit's runs, one per check suite) from a
 * list, so a run can move queued → green.
 */
describe("release-gate-wait: the script, end to end, through `gh api`", () => {
  const SCRIPT = fileURLToPath(
    new URL("./release-gate-wait.mjs", import.meta.url)
  );
  const SHA = "08a02a9f3fc0c2e5e8a1d6f0c9b8a7e6d5c4b3a2";

  // Shapes copied from GET .../actions/workflows/ci.yml/runs and
  // .../check-suites/<id>/check-runs.
  const wireRun = (suite: number, status: string) => ({
    id: 40759997284 + suite,
    name: "CI",
    event: "push",
    status,
    conclusion: status === "completed" ? "success" : null,
    check_suite_id: suite,
    html_url: `https://github.com/Synap-core/backend/actions/runs/${40759997284 + suite}`,
  });
  const wireCheck = (name: string, conclusion: string | null = "success") => ({
    id: 123069139778,
    name,
    status: conclusion ? "completed" : "in_progress",
    conclusion,
    app: { slug: "github-actions" },
  });
  const wireGreen = () => REQUIRED_CHECKS.map((n: string) => wireCheck(n));

  /** runs: sha → reads of its push runs; suites: id → reads of its checks. */
  function gh(
    runs: Record<string, object[][]>,
    suites: Record<string, object[][]>,
    args: string[],
    {
      cwd = REPO,
      failReads = false,
      command,
    }: { cwd?: string; failReads?: boolean; command?: string[] } = {}
  ) {
    const dir = mkdtempSync(join(tmpdir(), "release-gate-wait-"));
    try {
      writeFileSync(
        join(dir, "data.json"),
        JSON.stringify({ runs, suites, failReads })
      );
      const fake = join(dir, "gh");
      writeFileSync(
        fake,
        `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const [, , sub, url] = process.argv;
if (sub !== "api") process.exit(2);
const D = ${JSON.stringify(dir)};
const data = JSON.parse(fs.readFileSync(path.join(D, "data.json"), "utf8"));
if (data.failReads) { console.error("gh: HTTP 502"); process.exit(1); }
let key, list, wrap;
let m = /actions\\/workflows\\/ci\\.yml\\/runs\\?head_sha=([0-9a-f]{40})&event=push&/.exec(url);
if (m) { key = "runs-" + m[1]; list = data.runs[m[1]] ?? [[]]; wrap = (b) => ({ total_count: b.length, workflow_runs: b }); }
else if ((m = /check-suites\\/(\\d+)\\/check-runs\\?filter=latest&/.exec(url))) { key = "suite-" + m[1]; list = data.suites[m[1]] ?? [[]]; wrap = (b) => ({ total_count: b.length, check_runs: b }); }
else if (url.includes("/releases/tags/")) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
else { console.error("unexpected path " + url); process.exit(3); }
const n = path.join(D, key + ".n");
const i = fs.existsSync(n) ? Number(fs.readFileSync(n, "utf8")) : 0;
fs.writeFileSync(n, String(i + 1));
fs.appendFileSync(path.join(D, "calls"), url + "\\n");
process.stdout.write(JSON.stringify(wrap(list[Math.min(i, list.length - 1)])));
`
      );
      chmodSync(fake, 0o755);
      const summary = join(dir, "summary.md");
      const [bin, ...argv] = command ?? [process.execPath, SCRIPT, ...args];
      const r = spawnSync(bin, argv, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          RELEASE_GATE_POLL_SECONDS: "0",
          // 3 s: bounds a regression that keeps waiting.
          RELEASE_GATE_TIMEOUT_MINUTES: "0.05",
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      const read = (f: string) => {
        try {
          return readFileSync(join(dir, f), "utf8");
        } catch {
          return "";
        }
      };
      return {
        status: r.status,
        out: r.stdout + r.stderr,
        calls: read("calls"),
        summary: read("summary.md"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a post-merge run starting, then all green: exits 0 after waiting", () => {
    const r = gh(
      {
        [SHA]: [
          [wireRun(1, "queued")],
          [wireRun(1, "in_progress")],
          [wireRun(1, "completed")],
        ],
      },
      { 1: [[], [wireCheck("Release gate", null)], wireGreen()] },
      ["Synap-core/backend", SHA]
    );
    expect(r.out).toContain("waiting:");
    expect(r.out).toContain(`Post-merge run all green on ${SHA}`);
    expect(r.status).toBe(0);
    // Only the push run's own check suite is read: a merge-queue run of the
    // same sha (its checks may pass by reuse) never stands in for it.
    expect(r.calls).toContain(
      `repos/Synap-core/backend/actions/workflows/ci.yml/runs?head_sha=${SHA}&event=push&per_page=100`
    );
    expect(r.calls).toContain(
      "repos/Synap-core/backend/check-suites/1/check-runs?filter=latest&per_page=100"
    );
    expect(r.calls).not.toContain(`/commits/${SHA}/check-runs`);
  });

  it("a green Release gate and a red Full suite: exits 1 with an error annotation", () => {
    const r = gh(
      { [SHA]: [[wireRun(1, "completed")]] },
      {
        1: [
          REQUIRED_CHECKS.map((n: string) =>
            wireCheck(n, n === "Full suite" ? "failure" : "success")
          ),
        ],
      },
      ["Synap-core/backend", SHA]
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("::error::");
    expect(r.out).toContain("Full suite: failure");
  });

  it("no post-merge run: exits 1 on the first read", () => {
    const r = gh({}, {}, ["Synap-core/backend", SHA]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("No post-merge CI run");
    expect(r.calls.trim().split("\n")).toHaveLength(1);
  });

  it("--once (the nightly's pick): 0 green, 1 red, 3 still running, 2 a failed read", () => {
    const once = (runs: object[][], checks: object[][]) =>
      gh({ [SHA]: runs }, { 1: checks }, ["--once", "Synap-core/backend", SHA])
        .status;
    expect(once([[wireRun(1, "completed")]], [wireGreen()])).toBe(0);
    expect(
      once(
        [[wireRun(1, "completed")]],
        [[wireCheck("Release gate", "failure")]]
      )
    ).toBe(1);
    expect(once([[wireRun(1, "in_progress")]], [[]])).toBe(3);
    // gh exits non-zero (HTTP 502): 2, never taken for "not green".
    const r = gh({}, {}, ["--once", "Synap-core/backend", SHA], {
      failReads: true,
    });
    expect(r.status).toBe(2);
    expect(r.out).toContain("GitHub read failed");
  });

  it("--culprits names the commits since the last all-green main, in the step summary", () => {
    const repo = mkdtempSync(join(tmpdir(), "culprits-repo-"));
    try {
      const git = (...a: string[]) =>
        execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      const shas: string[] = [];
      for (const s of ["green base", "suspect one", "red head"]) {
        git("commit", "-q", "--allow-empty", "-m", s);
        shas.push(git("rev-parse", "HEAD"));
      }
      const [base, suspect, head] = shas;
      const r = gh(
        {
          [base]: [[wireRun(1, "completed")]],
          [suspect]: [[wireRun(2, "completed")]],
          [head]: [[wireRun(3, "completed")]],
        },
        {
          1: [wireGreen()],
          2: [[wireCheck("Release gate", "cancelled")]],
          3: [[wireCheck("Full suite", "failure")]],
        },
        ["--culprits", "Synap-core/backend", head],
        { cwd: repo }
      );
      expect(r.status).toBe(0);
      expect(r.summary).toContain(
        `The red is in \`${base.slice(0, 9)}..${head.slice(0, 9)}\``
      );
      expect(r.summary).toContain("suspect one");
      expect(r.summary).toContain("red head");
      expect(r.summary).not.toContain("green base (its own");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("the nightly (deploy/release/nightly-fast-pick.sh) skips a newer red commit and builds the newest all-green one", () => {
    const repo = mkdtempSync(join(tmpdir(), "nightly-repo-"));
    try {
      const git = (...a: string[]) =>
        execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      const shas: string[] = [];
      for (const s of [
        "older green",
        "newest green",
        "red head",
        "running head",
      ]) {
        git("commit", "-q", "--allow-empty", "-m", s);
        shas.push(git("rev-parse", "HEAD"));
      }
      const [older, newest, red, running] = shas;
      // The same fake gh, through the real wait script it calls per commit.
      const r = gh(
        {
          [older]: [[wireRun(1, "completed")]],
          [newest]: [[wireRun(2, "completed")]],
          [red]: [[wireRun(3, "completed")]],
          [running]: [[wireRun(4, "in_progress")]],
        },
        {
          1: [wireGreen()],
          2: [wireGreen()],
          // The Release gate green, the Full suite red: until 2026-10-29
          // the nightly would have built this one.
          3: [
            REQUIRED_CHECKS.map((n: string) =>
              wireCheck(n, n === "Full suite" ? "failure" : "success")
            ),
          ],
          4: [[wireCheck("Release gate")]],
        },
        [],
        {
          cwd: repo,
          command: [
            "bash",
            join(REPO, "deploy/release/nightly-fast-pick.sh"),
            "Synap-core/backend",
            "10",
          ],
        }
      );
      expect(r.out).toContain(`sha=${newest}`);
      expect(r.out).toContain("build=true");
      expect(r.out).toContain(`skip ${running.slice(0, 7)}`);
      expect(r.out).toContain(`skip ${red.slice(0, 7)}`);
      expect(r.status).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a short sha (the reads would name the wrong commit)", () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "Synap-core/backend", "08a02a9"],
      {
        encoding: "utf8",
      }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("usage:");
  });
});
