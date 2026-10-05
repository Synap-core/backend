/**
 * RULE RUNS in Happening — the pure fold behind `readHappening`'s second
 * population (`routers/signals.ts`).
 *
 * WHY. Happening read sessions only, so a rule whose THEN opens no session
 * (notify, update an entity, propose a playbook) left NO row on Home or Work
 * while it ran — the rule could fire 300 times on a Gmail sync and the lens
 * said "nothing is happening". A run that DID open a session is already the
 * live-session row and is excluded upstream (one unit of work, one row).
 *
 * THE FOLD. One row per RULE per window, never one per run: 300 runs of one
 * rule are ONE row "×300", grouped under `rule:<automationId>` so a surface
 * draws repeats as a count. A failure inside the window marks the row failed
 * (silence is expensive: a failed run outranks the healthy ones beside it) and
 * says how many failed; the row's door is the rule.
 *
 * Skipped runs (dedup, daily cap, precondition) are not work and never reach
 * here; the caller filters them in SQL.
 */
import { unitStateInputOfRunStatus } from "@synap-core/types/units";
import type { Signal } from "./needs-you-union.js";
import { ageBucketOf } from "./needs-you-union.js";

/** One automation run row, as the Happening read selects it. */
export interface RuleRunRow {
  automationId: string;
  automationName: string | null;
  status: string;
  startedAt: Date;
}

/** The rule-run facts a `rule-run` signal carries (`Signal.ruleRun`). */
export interface RuleRunFacts {
  automationId: string;
  /** Runs of this rule inside the window (incl. in flight). */
  runs: number;
  /** Of those, how many failed. */
  failed: number;
  /** At least one run is still in flight (the run-status door says running). */
  running: boolean;
  /** The newest run's status — a quiet row's mark is read from it. */
  latestStatus: string;
}

/** The fold key every surface groups a rule's repeats under. */
export function ruleRunGroupKey(automationId: string): string {
  return `rule:${automationId}`;
}

/** Fold runs into one Happening row per rule, newest rule activity first. */
export function foldRuleRuns(rows: readonly RuleRunRow[], now: Date): Signal[] {
  const byRule = new Map<
    string,
    { name: string | null; newest: Date; facts: RuleRunFacts }
  >();
  for (const r of rows) {
    const at =
      r.startedAt instanceof Date ? r.startedAt : new Date(r.startedAt);
    const cur = byRule.get(r.automationId) ?? {
      name: r.automationName,
      newest: at,
      facts: {
        automationId: r.automationId,
        runs: 0,
        failed: 0,
        running: false,
        latestStatus: r.status,
      },
    };
    cur.facts.runs += 1;
    if (r.status === "failed") cur.facts.failed += 1;
    if (unitStateInputOfRunStatus(r.status).running) cur.facts.running = true;
    if (at >= cur.newest) {
      cur.newest = at;
      cur.facts.latestStatus = r.status;
    }
    byRule.set(r.automationId, cur);
  }
  const out: Signal[] = [];
  for (const { name, newest, facts } of byRule.values()) {
    out.push({
      id: `rule-run:${facts.automationId}`,
      kind: "rule-run",
      title: name?.trim() || "Untitled rule",
      count: facts.runs,
      occurredAt: newest,
      target: { kind: "automation", id: facts.automationId },
      category: "system",
      ruleRun: facts,
      groupKey: ruleRunGroupKey(facts.automationId),
      ageBucket: ageBucketOf(newest, now),
      repeatCount: facts.runs,
    });
  }
  out.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  return out;
}
