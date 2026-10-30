/**
 * The daily "widen lane" filer is RETIRED (structural plan S3, founder Q3,
 * 29 Oct). It filed a pending `governance.widen_lane` proposal once an agent
 * passed 30+ decisions at 95%: one more card in the queue it meant to shrink,
 * granted pod-wide, past the ladder's reversibility and kind guards, through a
 * second rule-writing path. The offer is now the earned streak on the card the
 * person is already looking at (`@synap-core/types/trust-ladder` `earnedStreak`,
 * read by `governanceRules.nextRungs` / `.alwaysApproved`), and a grant goes
 * through the ladder's one back half (`fileRuleGrant`).
 *
 * pg-boss never prunes a schedule whose code is gone, so the queue stays in
 * RETIRED_QUEUES (unscheduled + deleted at boot).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).map((p) => ({
  path: relative(SRC, p),
  code: stripComments(readFileSync(p, "utf8"), "ts"),
}));

describe("the widen-lane filer is retired", () => {
  it("non-vacuity: the walk sees the jobs package", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((f) => f.path === "cron.ts")).toBe(true);
  });

  it("no jobs source files a governance.widen_lane proposal", () => {
    const offenders = FILES.filter((f) =>
      /["']governance\.widen_lane["']/.test(f.code)
    ).map((f) => f.path);
    expect(
      offenders,
      "A job files governance.widen_lane again. The offer is the earned streak on the card (S3); see this file's header."
    ).toEqual([]);
  });

  it("the lane-scan queue is unscheduled at boot, never worked or scheduled", () => {
    const workersIdx = FILES.find(
      (f) => f.path === join("workers", "index.ts")
    )!;
    const cron = FILES.find((f) => f.path === "cron.ts")!;
    const retired =
      /const RETIRED_QUEUES: string\[\] = \[([\s\S]*?)\n\];/.exec(
        workersIdx.code
      )?.[1] ?? "";
    expect(retired).toContain('"governance.lane-scan"');
    expect(workersIdx.code).toMatch(
      /for \(const name of RETIRED_QUEUES\)[\s\S]{0,80}boss\.unschedule\(name\)/
    );
    expect(cron.code).not.toMatch(
      /governance\.lane-scan|GOVERNANCE_LANE_SCANNER|governance-lane-scanner/
    );
    expect(workersIdx.code.replace(retired, "")).not.toMatch(
      /governance\.lane-scan|GOVERNANCE_LANE_SCANNER|governance-lane-scanner/
    );
  });
});
