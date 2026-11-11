import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

/**
 * TRIPWIRE — a playbook step STARTS in one function: `enterStage`
 * (`services/playbooks/stage-runner.ts`; runner engine spec 7111934d §3.1).
 *
 * ── The defect it prevents ─────────────────────────────────────────────────
 * The stage runner writes the step's `session_stage_runs` row and hands the
 * step to whoever works it. A place where a step starts WITHOUT calling it
 * leaves that step with no row (the screens say nobody is on it), never
 * hands it over (the agent the step names is never told) and never checks
 * its tools. A second hand-rolled copy forks the rule.
 *
 * ── How ────────────────────────────────────────────────────────────────────
 * Derives the CALLERS by scanning `packages/api/src` and `packages/jobs/src`
 * for `enterStage(` (comments blanked) and pins the set: a new caller must be
 * added here on purpose, a removed one fails. Derives the BIRTH places too:
 * every file that writes a `playbook_runs` ledger row (`.insert(playbookRuns)`)
 * starts a run on its first stage, so each must be a caller.
 *
 * ── What it cannot see (measured) ──────────────────────────────────────────
 * - Granularity is the FILE: a file that calls `enterStage` at one place and
 *   starts a step without it at another stays green (verified by reading;
 *   the behavioural tests in `stage-runner.pglite.test.ts` cover the doors).
 * - A gate that passes somewhere other than the two pinned files: the
 *   current-stage-one-door tripwire pins who writes the stage; this one pins
 *   who starts it.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const API_SRC = join(HERE, "..");
const JOBS_SRC = join(HERE, "..", "..", "..", "jobs", "src");

const THE_FUNCTION = "api:services/playbooks/stage-runner.ts";

/** Every place a step starts, and why it is one. */
const CALLERS: Record<string, string> = {
  "api:services/focus-sessions/advance-stage.ts":
    "THE advance door: a stage that stands with no gate holding it (ungated, or a check gate that passed)",
  "api:routers/proposals/executors/playbook-stage-gate.ts":
    "a human gate approved later: the held stage starts",
  "api:services/focus-sessions/evaluations/evaluate.ts":
    "resumeCheckGateIfMet: a check gate that passes later",
  "api:services/playbooks/run-playbook.ts":
    "birth: runPlaybook writes the run row on stage 0",
  "api:services/focus-sessions/create-session.ts":
    "birth: a session started on a playbook writes its run row on stage 0",
  "api:services/focus-sessions/follow-playbook.ts":
    "birth: following a playbook writes a run row on the stage the work is already in",
};

/**
 * Writers of a `playbook_runs` row that start NO step, and why. Pinned like
 * the callers: a new one is added here on purpose.
 */
const RUN_ROWS_WITH_NO_STEP: Record<string, string> = {
  "api:services/playbooks/generate-run.ts":
    "a one-shot (executor generate) run: one model call, no session (`session_id` NULL), so no step to start",
};

const CALL = /\benterStage\(/;
const RUN_ROW_WRITE = /\.insert\(\s*playbookRuns\s*\)/;

function tsFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, acc);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts") &&
      !p.includes("__tests__") &&
      !p.includes("__tripwires__")
    )
      acc.push(p);
  }
  return acc;
}

function scan(): { callers: string[]; runRowWriters: string[]; files: number } {
  const callers: string[] = [];
  const runRowWriters: string[] = [];
  let files = 0;
  for (const [prefix, root] of [
    ["api", API_SRC],
    ["jobs", JOBS_SRC],
  ] as const) {
    for (const file of tsFiles(root)) {
      files += 1;
      const code = stripComments(readFileSync(file, "utf8"), "ts");
      const key = `${prefix}:${relative(root, file).split("\\").join("/")}`;
      if (CALL.test(code) && key !== THE_FUNCTION) callers.push(key);
      if (RUN_ROW_WRITE.test(code)) runRowWriters.push(key);
    }
  }
  return {
    callers: callers.sort(),
    runRowWriters: runRowWriters.sort(),
    files,
  };
}

describe("tripwire: a playbook step starts in enterStage", () => {
  const found = scan();

  it("the scan is non-vacuous and can still see a call", () => {
    expect(found.files).toBeGreaterThan(500);
    expect(found.runRowWriters.length).toBeGreaterThanOrEqual(3);
    expect(CALL.test("await enterStage({ sessionId })")).toBe(true);
    expect(
      CALL.test(stripComments("/** enterStage(x) in prose */", "ts"))
    ).toBe(false);
    expect(
      readFileSync(join(API_SRC, "services/playbooks/stage-runner.ts"), "utf8")
    ).toMatch(/export async function enterStage\(/);
  });

  it("the callers are exactly the pinned places a step starts", () => {
    expect(found.callers).toEqual(Object.keys(CALLERS).sort());
  });

  it("every writer of a playbook_runs row starts its first step", () => {
    const missing = found.runRowWriters.filter(
      (k) => !(k in CALLERS) && !(k in RUN_ROWS_WITH_NO_STEP)
    );
    expect(missing).toEqual([]);
    // An exemption that no longer writes a run row is stale: drop it.
    expect(
      Object.keys(RUN_ROWS_WITH_NO_STEP).filter(
        (k) => !found.runRowWriters.includes(k)
      )
    ).toEqual([]);
  });
});
