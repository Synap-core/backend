import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TRIPWIRE — every `playbook_runs` TERMINAL writer settles the parent
 * automation run (`settleParentAutomationRunFromChild`, @synap/jobs).
 *
 * The incident (2026-10): an automation started a playbook run per company;
 * every child failed (most of them in the reaper), and the parent run kept the
 * `completed` it settled with while the children were still running. 78
 * "successes", 0 working runs — and the breakers, which read the PARENT's
 * outcome, never fired. A parent can only settle from its children if EVERY
 * door that ends a child tells it so; one writer that forgets reopens the hole
 * for exactly the runs that die through it.
 *
 * ── WHAT IT SCANS ───────────────────────────────────────────────────────────
 * Derived, never hand-listed: every non-test `.ts` under api/src and jobs/src.
 * A TERMINAL STAMP is `.update(playbookRuns).set({ … status: X … })` where X is
 * a terminal literal ("completed" | "failed" | "cancelled" | "proposed") or any
 * NON-literal expression (a door forwarding a caller-supplied status can write
 * a terminal one). The two live, non-terminal literals ("running",
 * "waiting_on_you") are not stamps.
 *
 * A file passes when it calls the helper at least as many times as it stamps.
 *
 * ── WHAT IT DOES NOT SEE (measured) ─────────────────────────────────────────
 *   - Granularity is a COUNT per file, not the call site: a file with two
 *     stamps and two calls passes even if both calls sit beside one stamp.
 *   - A `.set({...})` whose object contains a nested `{` before `status:` is
 *     cut at that brace and read as "no status write" — under-reports, never
 *     invents a violation. No current writer has that shape.
 *   - A raw-SQL `UPDATE playbook_runs` is not parsed (none exists today; the
 *     second test asserts that, so one appearing fails loudly).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, "..");
const JOBS_SRC = join(API_SRC, "../../jobs/src");

const HELPER_CALL =
  /\b(settleParentAutomationRunFromChild|resettleAutomationRunFromChildren)\(/g;
const NON_TERMINAL = new Set(['"running"', '"waiting_on_you"']);
const SET_ON_RUNS =
  /\.update\(\s*playbookRuns\s*\)\s*\.set\(\s*\{([^{}]*?)\}\s*\)/g;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(p, out);
      continue;
    }
    if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
    out.push(p);
  }
  return out;
}

const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p) => p);

/** Count terminal stamps in a (comment-stripped) source. */
function terminalStamps(src: string): string[] {
  const found: string[] = [];
  SET_ON_RUNS.lastIndex = 0;
  for (const m of src.matchAll(SET_ON_RUNS)) {
    const status = /\bstatus\s*:\s*([^,\n}]+)/.exec(m[1]!);
    if (!status) continue;
    const value = status[1]!.trim();
    if (NON_TERMINAL.has(value)) continue;
    found.push(value);
  }
  return found;
}

function scan(): Array<{ file: string; stamps: string[]; calls: number }> {
  const out: Array<{ file: string; stamps: string[]; calls: number }> = [];
  for (const root of [API_SRC, JOBS_SRC]) {
    for (const file of walk(root)) {
      const src = stripComments(readFileSync(file, "utf8"));
      const stamps = terminalStamps(src);
      if (stamps.length === 0) continue;
      out.push({
        file: relative(join(API_SRC, "../.."), file).replace(/\\/g, "/"),
        stamps,
        calls: [...src.matchAll(HELPER_CALL)].length,
      });
    }
  }
  return out;
}

describe("tripwire: a playbook_runs terminal writer settles the parent automation run", () => {
  it("scan roots exist and the corpus is non-trivial", () => {
    expect(existsSync(API_SRC)).toBe(true);
    expect(existsSync(JOBS_SRC)).toBe(true);
    expect(walk(API_SRC).length + walk(JOBS_SRC).length).toBeGreaterThan(200);
  });

  it("SELF-GUARD: the detector reads terminal, dynamic and live stamps correctly", () => {
    const BAD = `
      await db
        .update(playbookRuns)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(playbookRuns.id, id));
      await db.update(playbookRuns).set({ status: nextStatus }).where(x);
    `;
    expect(terminalStamps(BAD)).toEqual(['"failed"', "nextStatus"]);
    const LIVE = `await db.update(playbookRuns).set({ status: "running" }).where(x);
      await db.update(playbookRuns).set({ status: "waiting_on_you" }).where(x);
      await db.update(playbookRuns).set({ summary: "x" }).where(x);`;
    expect(terminalStamps(LIVE)).toEqual([]);
  });

  it("finds every known terminal writer (non-vacuity) and no raw-SQL writer", () => {
    const files = scan().map((s) => s.file);
    // The writers known when this guard was written. New ones join the scan
    // by existing; this floor only proves the scan still SEES the old ones.
    for (const known of [
      // The capture write moved out of the Hub route into the ONE applier it
      // now shares with the external-agent status poll (2026-10-08).
      "api/src/services/runs/apply-run-capture.ts",
      "api/src/routers/hub-protocol/rest/focus-sessions.ts",
      "api/src/routers/proposals/executors/playbook.ts",
      "api/src/services/focus-sessions/follow-playbook.ts",
      "api/src/services/focus-sessions/complete-session.ts",
      "api/src/services/playbooks/run-playbook.ts",
      "jobs/src/workers/playbook-run-reaper.ts",
    ]) {
      expect(files, `the scan no longer sees ${known}`).toContain(known);
    }
    for (const root of [API_SRC, JOBS_SRC]) {
      for (const file of walk(root)) {
        expect(
          /UPDATE\s+playbook_runs\b/i.test(
            stripComments(readFileSync(file, "utf8"))
          ),
          `${file} writes playbook_runs with raw SQL — this guard cannot parse it`
        ).toBe(false);
      }
    }
  });

  it("every terminal writer calls the settle helper at least once per stamp", () => {
    const offenders = scan()
      .filter((s) => s.calls < s.stamps.length)
      .map(
        (s) =>
          `${s.file} — ${s.stamps.length} terminal stamp(s) [${s.stamps.join(", ")}], ${s.calls} settle call(s)`
      );
    expect(
      offenders,
      "These end a playbook run without settling its parent automation run. " +
        "Call settleParentAutomationRunFromChild({ playbookRunId }) right after the write."
    ).toEqual([]);
  });
});
