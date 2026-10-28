/**
 * release-gate-wait.mjs decides whether a release may build a commit. A wrong
 * "pass" ships a commit CI never cleared; a wrong "fail" makes someone re-run
 * the release by hand (runs 40760093657, 40704054177). This pins the verdict
 * for every check-run state GitHub reports, and the wait loop's timeout.
 * Named `*.tripwire.test.ts` so `pnpm tripwires` (CI) runs it.
 */
import { spawnSync } from "node:child_process";
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
// @ts-expect-error — plain ESM script, no declarations
import { decide, waitForReleaseGate } from "./release-gate-wait.mjs";

type Run = { status: string; conclusion: string | null; suite?: number };
const gate = ({ status, conclusion, suite = 1 }: Run) => ({
  status,
  conclusion,
  check_suite: { id: suite },
  html_url: "https://github.com/x/y/actions/runs/1/job/2",
});
const ci = (status: string, suite = 1) => ({
  status,
  check_suite_id: suite,
  html_url: "https://github.com/x/y/actions/runs/1",
});
const done = (conclusion: string, suite = 1) =>
  gate({ status: "completed", conclusion, suite });

describe("release-gate-wait: the verdict for one read", () => {
  it("no gate and no CI run: fails at once (a commit that never ran CI never releases)", () => {
    const d = decide({ gateRuns: [], ciRuns: [] });
    expect(d.verdict).toBe("fail");
    expect(d.reason).toContain('No "Release gate" ran');
  });

  it("no gate and only finished CI runs: fails at once", () => {
    expect(decide({ gateRuns: [], ciRuns: [ci("completed")] }).verdict).toBe(
      "fail"
    );
  });

  it("a CI run queued or running that has not created its gate yet: waits", () => {
    for (const s of [
      "queued",
      "in_progress",
      "pending",
      "waiting",
      "requested",
    ]) {
      expect(decide({ gateRuns: [], ciRuns: [ci(s)] }).verdict).toBe("wait");
    }
  });

  it("a gate queued or in progress: waits", () => {
    for (const status of ["queued", "in_progress"]) {
      const d = decide({
        gateRuns: [gate({ status, conclusion: null })],
        ciRuns: [ci("in_progress")],
      });
      expect(d.verdict).toBe("wait");
      expect(d.reason).toContain(status);
    }
  });

  it("a gate that succeeded: passes", () => {
    expect(
      decide({ gateRuns: [done("success")], ciRuns: [ci("completed")] }).verdict
    ).toBe("pass");
  });

  it("a gate that ended in anything but success is never a pass", () => {
    for (const c of [
      "failure",
      "skipped",
      "cancelled",
      "neutral",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
    ]) {
      const d = decide({ gateRuns: [done(c)], ciRuns: [ci("completed")] });
      expect(d.verdict, c).toBe("fail");
      expect(d.reason).toContain(c);
    }
  });

  it("a red gate fails at once even while the rest of its CI run is still going", () => {
    expect(
      decide({ gateRuns: [done("failure")], ciRuns: [ci("in_progress")] })
        .verdict
    ).toBe("fail");
  });

  it("an older red gate and a re-run in progress: waits for the re-run", () => {
    expect(
      decide({
        gateRuns: [
          done("failure", 1),
          gate({ status: "in_progress", conclusion: null, suite: 1 }),
        ],
        ciRuns: [ci("in_progress", 1)],
      }).verdict
    ).toBe("wait");
  });

  it("an older cancelled gate and a new CI run that has not created its gate: waits", () => {
    expect(
      decide({
        gateRuns: [done("cancelled", 1)],
        ciRuns: [ci("completed", 1), ci("queued", 2)],
      }).verdict
    ).toBe("wait");
  });

  it("any success among several gate runs: passes", () => {
    expect(
      decide({
        gateRuns: [done("cancelled", 1), done("success", 2)],
        ciRuns: [],
      }).verdict
    ).toBe("pass");
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
  const sequence = (
    reads: Array<{ gateRuns: unknown[]; ciRuns: unknown[] }>
  ) => {
    let i = 0;
    return () => reads[Math.min(i++, reads.length - 1)];
  };

  it("queued, then in progress, then success: passes (the 2026-10-28 case)", async () => {
    const c = clock();
    const r = await waitForReleaseGate({
      read: sequence([
        { gateRuns: [], ciRuns: [ci("in_progress")] },
        {
          gateRuns: [gate({ status: "queued", conclusion: null })],
          ciRuns: [ci("in_progress")],
        },
        {
          gateRuns: [gate({ status: "in_progress", conclusion: null })],
          ciRuns: [ci("in_progress")],
        },
        { gateRuns: [done("success")], ciRuns: [ci("in_progress")] },
      ]),
      ...c,
      intervalMs: 60_000,
      timeoutMs: 45 * 60_000,
    });
    expect(r.ok).toBe(true);
    expect(c.now()).toBe(3 * 60_000);
  });

  it("in progress, then failure: fails with the conclusion", async () => {
    const r = await waitForReleaseGate({
      read: sequence([
        {
          gateRuns: [gate({ status: "in_progress", conclusion: null })],
          ciRuns: [],
        },
        { gateRuns: [done("failure")], ciRuns: [] },
      ]),
      ...clock(),
      intervalMs: 60_000,
      timeoutMs: 45 * 60_000,
    });
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toContain("failure");
  });

  it("still running after the timeout: fails, saying it timed out", async () => {
    const c = clock();
    const r = await waitForReleaseGate({
      read: () => ({
        gateRuns: [gate({ status: "in_progress", conclusion: null })],
        ciRuns: [],
      }),
      ...c,
      intervalMs: 60_000,
      timeoutMs: 45 * 60_000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Waited 45 min");
    expect(c.now()).toBeLessThanOrEqual(45 * 60_000);
  });

  it("no gate at all: fails on the first read, without waiting", async () => {
    const c = clock();
    const r = await waitForReleaseGate({
      read: () => ({ gateRuns: [], ciRuns: [] }),
      ...c,
      intervalMs: 60_000,
      timeoutMs: 45 * 60_000,
    });
    expect(r.ok).toBe(false);
    expect(c.now()).toBe(0);
  });

  it("a failed GitHub read fails the step and is never taken for 'no gate'", async () => {
    const r = await waitForReleaseGate({
      read: () => {
        throw new Error("HTTP 502");
      },
      ...clock(),
      intervalMs: 60_000,
      timeoutMs: 45 * 60_000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("GitHub read failed");
    expect(r.reason).toContain("HTTP 502");
  });
});

/**
 * The seam: the real script, run as the workflow runs it, reading the real
 * GitHub wire shape through a fake `gh` on PATH. The fake answers the n-th
 * read of each endpoint from a list, so a gate can move queued → success.
 */
describe("release-gate-wait: the script, end to end, through `gh api`", () => {
  const SCRIPT = fileURLToPath(
    new URL("./release-gate-wait.mjs", import.meta.url)
  );
  const SHA = "08a02a9f3fc0c2e5e8a1d6f0c9b8a7e6d5c4b3a2";

  function run(checkRuns: object[][], workflowRuns: object[][]) {
    const dir = mkdtempSync(join(tmpdir(), "release-gate-wait-"));
    try {
      writeFileSync(join(dir, "checks.json"), JSON.stringify(checkRuns));
      writeFileSync(join(dir, "runs.json"), JSON.stringify(workflowRuns));
      // A node `gh`: `gh api <path>` → the next canned body for that endpoint.
      const gh = join(dir, "gh");
      writeFileSync(
        gh,
        `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const [, , sub, url] = process.argv;
if (sub !== "api") process.exit(2);
const kind = url.includes("/check-runs?") ? "checks" : url.includes("/actions/workflows/ci.yml/runs?") ? "runs" : null;
if (!kind) { console.error("unexpected path " + url); process.exit(3); }
const n = path.join(${JSON.stringify(dir)}, kind + ".n");
const i = fs.existsSync(n) ? Number(fs.readFileSync(n, "utf8")) : 0;
fs.writeFileSync(n, String(i + 1));
fs.appendFileSync(path.join(${JSON.stringify(dir)}, "calls"), url + "\\n");
const list = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(dir)}, kind + ".json"), "utf8"));
const body = list[Math.min(i, list.length - 1)];
process.stdout.write(JSON.stringify(kind === "checks" ? { total_count: body.length, check_runs: body } : { total_count: body.length, workflow_runs: body }));
`
      );
      chmodSync(gh, 0o755);
      const r = spawnSync(
        process.execPath,
        [SCRIPT, "Synap-core/backend", SHA],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            RELEASE_GATE_POLL_SECONDS: "0",
            // 3 s: bounds a regression that keeps waiting (it would poll ~busily).
            RELEASE_GATE_TIMEOUT_MINUTES: "0.05",
          },
        }
      );
      let calls = "";
      try {
        calls = readFileSync(join(dir, "calls"), "utf8");
      } catch {
        /* no call was made */
      }
      return { status: r.status, out: r.stdout + r.stderr, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Shapes copied from GET .../check-runs and .../actions/workflows/ci.yml/runs.
  const wireGate = (status: string, conclusion: string | null) => ({
    id: 123069139778,
    name: "Release gate",
    status,
    conclusion,
    check_suite: { id: 110486210232 },
    html_url:
      "https://github.com/Synap-core/backend/actions/runs/40759997284/job/123069139778",
    app: { slug: "github-actions" },
  });
  const wireCi = (status: string) => ({
    id: 40759997284,
    name: "CI",
    event: "push",
    status,
    conclusion: status === "completed" ? "success" : null,
    check_suite_id: 110486210232,
    html_url: "https://github.com/Synap-core/backend/actions/runs/40759997284",
  });

  it("CI starting, gate in progress, gate green: exits 0 after waiting", () => {
    const r = run(
      [[], [wireGate("in_progress", null)], [wireGate("completed", "success")]],
      [
        [wireCi("in_progress")],
        [wireCi("in_progress")],
        [wireCi("in_progress")],
      ]
    );
    expect(r.out).toContain("waiting:");
    expect(r.out).toContain(`Release gate passed on ${SHA}`);
    expect(r.status).toBe(0);
    expect(r.calls).toContain(
      `repos/Synap-core/backend/commits/${SHA}/check-runs?check_name=Release%20gate&per_page=100`
    );
    expect(r.calls).toContain(
      `repos/Synap-core/backend/actions/workflows/ci.yml/runs?head_sha=${SHA}&per_page=100`
    );
  });

  it("gate in progress, then red: exits 1 with an error annotation", () => {
    const r = run(
      [[wireGate("in_progress", null)], [wireGate("completed", "failure")]],
      [[wireCi("in_progress")]]
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("::error::");
    expect(r.out).toContain("failure");
  });

  it("no gate, no CI run: exits 1 on the first read", () => {
    const r = run([[]], [[]]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('No "Release gate" ran');
    expect(r.calls.trim().split("\n")).toHaveLength(2);
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
