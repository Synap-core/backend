import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import {
  AUTOMATION_RUN_STATUSES,
  CHAT_TURN_STATUSES,
  PLAYBOOK_RUN_STATUSES,
  STAGE_RUN_STATUSES,
} from "@synap-core/types/units";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

/**
 * TRIPWIRE — a set of session or run statuses is READ OFF THE DECLARATION,
 * never written out by hand.
 *
 * `SESSION_STATUS_DECLARATION` (`@synap-core/types/focus-sessions`) and
 * `RUN_STATUS_DECLARATION` (`@synap-core/types/units`) map every stored
 * status to one of five categories. A reader that needs "the open ones" or
 * "the ended ones" calls `sessionStatusesIn([...categories])` /
 * `runStatusesIn(...)` (or a named set derived there), and names any
 * deliberate exception beside the derivation (`.filter((s) => s !==
 * "stale")`).
 *
 * ── WHAT IT SEES ────────────────────────────────────────────────────────────
 * After comments are stripped (`scripts/strip-comments.mjs`): an array
 * literal of TWO OR MORE quoted strings, EVERY one a stored session or
 * playbook-run status, or a run-like machine's (automation run, stage run,
 * chat turn): the vocabulary is DERIVED from the declarations, so a new stored
 * word joins the scan by existing.
 * A category argument (`sessionStatusesIn(["active", "paused"])`) is not a
 * hand list — `active` and `paused` are also category names — and is skipped.
 *
 * ── WHAT IT DOES NOT SEE (measured by reading, not claimed) ─────────────────
 * - A one-word list (`["closed"]`), a `Set` built from spreads, an enum
 *   object (`FocusSessionStatus.ACTIVE`), a `case` label, an SQL literal
 *   `in ('active', 'paused')`.
 * - A list mixing a status word with any other word (`["active", "paused",
 *   "error"]`): it is another machine's vocabulary or a mixed one.
 * - The granularity is the FILE: a baselined file may swap one hand list for
 *   another at the same count.
 *
 * ── THE BASELINE ────────────────────────────────────────────────────────────
 * A ratchet: each file still holding hand lists, with its count, and why it
 * is not derived yet. A NEW file, or a higher count, is red. A LOWER count is
 * red too (lower the entry): the baseline only shrinks. Most remaining
 * entries are transition `from:` guards (status axis W2 gives each machine
 * one transition table) or another machine's vocabulary that happens to share
 * the words (automations, rules, workers, command runs).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "../../..");

/** The declarations themselves (and the column enums they mirror). */
const DECLARATIONS = new Set([
  "types/src/focus-sessions/statuses.ts",
  "types/src/units/run-status.ts",
  "types/src/units/machines.ts",
  "database/src/schema/focus-sessions.ts",
  "database/src/schema/playbook-runs.ts",
]);

const BASELINE: Record<string, { count: number; why: string }> = {
  "api/src/notifications/session-criteria-unmet-reactor.ts": {
    count: 1,
    why: "mixes session (closed, failed) and run (completed) words: one set over two machines",
  },
  "api/src/routers/hub-protocol/rest/rules.ts": {
    count: 1,
    why: "a rule's own status vocabulary (active, proposed)",
  },
  "api/src/routers/hub-protocol/rest/runs.ts": {
    count: 1,
    why: "the run-capture wire's status enum (what an IS capture may report)",
  },
  "api/src/routers/mcp/tools/index.ts": {
    count: 1,
    why: "update_session's MCP status enum (active | paused, the agent-settable moves)",
  },
  "api/src/routers/proposals/executors/playbook-stage-gate.ts": {
    count: 1,
    why: "a transition `from:` guard (W2: one transition table per machine)",
  },
  "api/src/routers/workers.ts": {
    count: 1,
    why: "a worker's own status vocabulary (running, paused)",
  },
  "api/src/services/focus-sessions/advance-stage.ts": {
    count: 1,
    why: "SUBJECT_LEADS (active, forming) differs from IN_FLIGHT_SESSION_STATUSES on `paused`; needs a decision, not a guess",
  },
  "api/src/services/focus-sessions/session-status-filter.ts": {
    count: 1,
    why: "WINDOWED (stale, closed): admitted by recency, a deliberate pair across categories",
  },
  "api/src/services/focus-sessions/stale-stopped-session.ts": {
    count: 1,
    why: "a transition `from:` guard (W2)",
  },
  "api/src/services/morning-brief/morning-brief.ts": {
    count: 1,
    why: "an inline filter (closed, failed): cancelled left out on purpose",
  },
  "api/src/services/playbooks/stage-child.ts": {
    count: 1,
    why: "a transition `from:` guard (W2)",
  },
  "api/src/services/playbooks/stage-for-each.ts": {
    count: 2,
    why: "a session transition `from:` guard, and ENTERABLE_STATUSES (running, waiting_tools): the step statuses a fan-out may claim",
  },
  "api/src/services/playbooks/stage-runner.ts": {
    count: 2,
    why: "a session transition `from:` guard, and the open steps a new step closes (OPEN_STAGE_RUN_STATUSES minus waiting_child, whose child settles it)",
  },
  "api/src/services/pod-hygiene/cleanup-pack.ts": {
    count: 1,
    why: "an inline filter (closed, failed): cancelled left out on purpose",
  },
  "api/src/services/proposals/approval-runs.ts": {
    count: 1,
    why: "an approval run's own vocabulary (queued, running), not a playbook run's",
  },
  "api/src/services/signal/channel-stack.ts": {
    count: 1,
    why: "automations.status (active, paused): the switched-on rules, a filter over AUTOMATION_STATUS_DECLARATION's active + paused minus error",
  },
  "database/src/schema/command-runs.ts": {
    count: 1,
    why: "the command_runs column enum: another machine's declaration",
  },
  "jobs/src/workers/automation-breaker.ts": {
    count: 1,
    why: "STREAK_STATUSES (completed, failed): the settled runs a streak counts; a skip or a policy block neither breaks nor heals it",
  },
  "jobs/src/utils/automation-parent-settle.ts": {
    count: 1,
    why: "RESETTLEABLE (completed, blocked_by_policy): the settled parents a child's failure re-settles, AUTOMATION_RUN_TRANSITIONS' moves into failed",
  },
  "jobs/src/workers/steps/ledger-query.ts": {
    count: 1,
    why: "the ledger query step's accepted run filter values (a wire vocabulary)",
  },
  "api/src/services/runs/types.ts": {
    count: 1,
    why: "RUN_STATUSES: the run feed's wire vocabulary over two machines (playbook and automation runs)",
  },
  "api/src/services/focus-sessions/session-lifecycle-sweep.ts": {
    count: 1,
    why: "AUTOMATION_RUN_ENDED: done + lost plus blocked_by_policy (paused on a rule, but the run is over for the sweep)",
  },
  "api/src/routers/hub-protocol/rest/messaging.ts": {
    count: 1,
    why: "a messaging sync's own status enum (running, paused, done): another machine",
  },
  "database/src/utils/stage-run-waiting.ts": {
    count: 1,
    why: "WAITING_STAGE_RUN_STATUSES: the paused step statuses that wait on something (unreached is a failed delivery, not a wait)",
  },
  "jobs/src/workers/focus-session-reaper.ts": {
    count: 2,
    why: "transition `from:` guards (W2)",
  },
  "jobs/src/workers/playbook-run-reaper.ts": {
    count: 1,
    why: "a transition `from:` guard (W2)",
  },
  "types/src/focus-sessions/verbs.ts": {
    count: 3,
    why: "the session verbs' `from:` table: the transition table W2 derives",
  },
  "types/src/units/session.ts": {
    count: 2,
    why: "the session mark's own sets (running, cadence): W2's statusMark",
  },
  "types/src/units/track-step.ts": {
    count: 1,
    why: "NOT_EVIDENCE (cancelled, failed): the lost category for one reader, W2",
  },
};

// The run-like machines' words join; automations', playbooks' and
// installations' do not: draft / active / paused / archived are also the words
// of projects, feeds, sources and a dozen other columns this scan cannot tell
// apart (adding them flagged 30+ files of other machines).
const STATUS_WORDS = new Set<string>([
  ...SESSION_STATUSES,
  ...PLAYBOOK_RUN_STATUSES,
  ...AUTOMATION_RUN_STATUSES,
  ...STAGE_RUN_STATUSES,
  ...CHAT_TURN_STATUSES,
]);
const ARRAY = /\[([^[\]]*)\]/g;
const QUOTED = /^(["'])([a-z_]+)\1$/;
/** A category argument to a derivation, not a hand list. */
const DERIVATION_ARG =
  /(?:StatusesIn|statusesInCategories)\(\s*$|statusesInCategories\([^()]*,\s*$/;

/** How many hand status lists `src` (comments stripped) holds. */
function countHandLists(src: string): number {
  let n = 0;
  for (const m of src.matchAll(ARRAY)) {
    const items = m[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length < 2) continue;
    const words = items.map((i) => QUOTED.exec(i)?.[2]);
    if (!words.every((w) => w !== undefined && STATUS_WORDS.has(w))) continue;
    const before = src.slice(Math.max(0, m.index! - 80), m.index!);
    if (DERIVATION_ARG.test(before)) continue;
    n++;
  }
  return n;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "__tripwires__") continue;
      walk(p, out);
      continue;
    }
    if (!p.endsWith(".ts") || p.endsWith(".d.ts")) continue;
    if (/\.(test|spec)\.ts$/.test(p)) continue;
    out.push(p);
  }
  return out;
}

function scan(): Map<string, number> {
  const out = new Map<string, number>();
  for (const pkg of readdirSync(PACKAGES)) {
    for (const file of walk(join(PACKAGES, pkg, "src"))) {
      const rel = relative(PACKAGES, file).replace(/\\/g, "/");
      const n = countHandLists(stripComments(readFileSync(file, "utf8"), "ts"));
      if (n > 0) out.set(rel, n);
    }
  }
  return out;
}

describe("tripwire: session and run status sets are derived from the declaration", () => {
  const found = scan();

  it("the scan reads a real corpus, and sees the declarations it exempts", () => {
    // Non-vacuity: a moved root must fail, never scan nothing and pass.
    let files = 0;
    for (const pkg of readdirSync(PACKAGES))
      files += walk(join(PACKAGES, pkg, "src")).length;
    expect(files).toBeGreaterThan(1000);
    // The column enums ARE hand lists: the scan must still see them.
    expect(found.get("database/src/schema/focus-sessions.ts")).toBe(1);
    expect(found.get("database/src/schema/playbook-runs.ts")).toBe(1);
  });

  it("SELF-GUARD: it counts a hand list and skips a category argument", () => {
    expect(
      countHandLists(`const OPEN = ["active", "paused", "stale"] as const;`)
    ).toBe(1);
    expect(countHandLists(`inArray(s.status, ['closed', 'failed'])`)).toBe(1);
    expect(
      countHandLists(`const OPEN = sessionStatusesIn(["active", "paused"]);`)
    ).toBe(0);
    expect(
      countHandLists(`const ENDED = runStatusesIn([\n  "done",\n  "lost",\n]);`)
    ).toBe(0);
    expect(countHandLists(`const FEED = ["active", "paused", "error"];`)).toBe(
      0
    );
    expect(countHandLists(`const ONE = ["closed"];`)).toBe(0);
  });

  it("no NEW hand-written status list outside the declarations", () => {
    const over: string[] = [];
    for (const [file, n] of found) {
      if (DECLARATIONS.has(file)) continue;
      const allowed = BASELINE[file]?.count ?? 0;
      if (n > allowed)
        over.push(`${file}: ${n} hand list(s), baseline ${allowed}`);
    }
    expect(
      over,
      "Derive the set from the declaration: sessionStatusesIn([...categories]) " +
        "or runStatusesIn(...) (or OPEN_SESSION_STATUSES / TERMINAL_SESSION_STATUSES / " +
        "LIVE_RUN_SESSION_STATUSES / LIVE_RUN_STATUSES), and name a deliberate " +
        "exception with a .filter beside it."
    ).toEqual([]);
  });

  it("the baseline only shrinks (a fixed file lowers or drops its entry)", () => {
    const stale: string[] = [];
    for (const [file, { count }] of Object.entries(BASELINE)) {
      const n = found.get(file) ?? 0;
      if (n < count) stale.push(`${file}: now ${n}, baseline ${count}`);
    }
    expect(stale).toEqual([]);
  });
});
