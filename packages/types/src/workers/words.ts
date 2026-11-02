/**
 * `@synap-core/types/workers/words` — a stage worker in WORDS and as a MARK,
 * for every surface (browser, relay, web kit). Moved from browser's
 * `apps/playbooks/playbookTrigger.ts` (surfaces W2.6) so the phone and the
 * web kit's `WorkerRow` read the same sentence the playbook header reads.
 *
 * A separate subpath on purpose: `@synap-core/types/workers` is the leaf
 * vocabulary the pod's rule policy imports; this module reads the vocabulary
 * and the rule words, which import that leaf.
 *
 *   workerWhen(w)          → "When a post enters Briefed" (null: unsayable)
 *   workerSentence(w)      → { when, then } — "…, propose running Produce Content"
 *   workerUnitInput(w)     → the shared unit-state input (one mark rule)
 *   playbookTriggerFact()  → what STARTS a playbook, for its header
 *   goalRhythmWords(ws)    → a goal's rhythm, from its running workers
 */
import { cronWords } from "../automations/cron-recurrence.js";
import { withArticle } from "../automations/stored-rule-words.js";
import type { UnitStateInput } from "../units/state.js";
import {
  resolveObjectNoun,
  resolveObjectNounPlural,
  resolveStatusLabel,
} from "../vocabulary/index.js";
import type { WorkerActivatorTrigger } from "./index.js";

/** The fields of an enabled worker (`workers.list`) the words read. */
export interface TriggerWorker {
  state: "running" | "paused";
  profileSlug: string | null;
  activator: {
    on: WorkerActivatorTrigger;
    status?: string;
    cron?: string;
    min?: number;
  } | null;
}

/** …plus what the worker does, for the whole sentence and its mark. */
export interface SentenceWorker extends TriggerWorker {
  playbookName: string;
  mode: "run" | "propose";
  /** Its runs waiting on a person (`workers.list`); > 0 = your turn. */
  pendingApprovals?: number;
}

/** A schedule `cronWords` cannot phrase — the same words the Rules page says. */
const CUSTOM_SCHEDULE = "On a custom schedule";

/** WHEN the worker fires, in words — null when the activator cannot be said. */
export function workerWhen(w: TriggerWorker): string | null {
  const a = w.activator;
  if (!a) return null;
  const noun = resolveObjectNoun(w.profileSlug ?? "thing").toLowerCase();
  const status = a.status ? resolveStatusLabel(a.status) : null;
  switch (a.on) {
    case "created":
      return `When ${withArticle(noun)} is created`;
    case "enters_status":
      return status ? `When ${withArticle(noun)} enters ${status}` : null;
    case "count":
      return status && a.min
        ? `When ${a.min} ${resolveObjectNounPlural(w.profileSlug ?? "thing").toLowerCase()} are in ${status}`
        : null;
    case "schedule":
      // Through `cronWords`, never the raw expression (D3): an expression it
      // cannot phrase says so in words instead of leaking `*/15 * * * *`.
      return a.cron ? (cronWords(a.cron) ?? CUSTOM_SCHEDULE) : null;
    default:
      return null;
  }
}

/**
 * The worker as ONE sentence: WHEN (null for a manual worker, or one the
 * activator no longer declares) and THEN — what it does, in its mode.
 */
export function workerSentence(w: SentenceWorker): {
  when: string | null;
  then: string;
} {
  return {
    when: workerWhen(w),
    then:
      w.mode === "propose"
        ? `propose running ${w.playbookName}`
        : `run ${w.playbookName}`,
  };
}

/**
 * The worker's state as the SHARED unit input (`resolveUnitState`), never a
 * local mark: runs waiting on approval → your turn (`needs_review`); an
 * enabled worker waits for its trigger → `scheduled`; paused → `paused`.
 * (The schedule arm reads only `enabled`; the cron is not a state.)
 */
export function workerUnitInput(w: SentenceWorker): UnitStateInput {
  return {
    pendingDecisions: w.pendingApprovals ?? 0,
    schedule: { cron: w.activator?.cron ?? "", enabled: w.state === "running" },
  };
}

export type PlaybookTriggerFact =
  { state: "known"; text: string } | { state: "failed" } | null;

/**
 * What STARTS a playbook, for its dashboard's header fact — derived from the
 * worker read (`workers.list({ playbookId })`), never from the playbook row's
 * own trigger field alone (dogfood 2026-10-12: "Manual / on demand" beside a
 * live worker that had run an hour earlier).
 *
 *   running workers → "When a post enters Briefed" (+ "+N more")
 *   the row's own cron → the cron
 *   neither         → "Manual / on demand"
 *   read in flight  → null (claim nothing yet); read failed → a failed fact.
 */
export function playbookTriggerFact(input: {
  workers: readonly TriggerWorker[] | undefined;
  workersFailed: boolean;
  schedule: { cron: string; enabled: boolean } | null | undefined;
}): PlaybookTriggerFact {
  const { workers, workersFailed, schedule } = input;
  if (workersFailed) return { state: "failed" };
  if (!workers) return null;
  const whens = workers
    .filter((w) => w.state === "running")
    .map(workerWhen)
    .filter((t): t is string => t !== null);
  if (whens.length > 0) {
    return {
      state: "known",
      text:
        whens.length > 1 ? `${whens[0]} +${whens.length - 1} more` : whens[0]!,
    };
  }
  if (schedule) {
    return {
      state: "known",
      text: `${cronWords(schedule.cron) ?? CUSTOM_SCHEDULE}${schedule.enabled ? "" : " (disabled)"}`,
    };
  }
  return { state: "known", text: "Manual / on demand" };
}

/**
 * A GOAL's rhythm in words, derived from its running workers — never a
 * schedule field on the goal (goals that run, decision 1): "Every Monday at
 * 09:00 UTC · when an issue is created". Paused workers and workers whose
 * trigger cannot be said are left out; the same words twice are said once.
 * Null when nothing wakes the goal.
 */
export function goalRhythmWords(
  workers: readonly TriggerWorker[]
): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const w of workers) {
    if (w.state !== "running") continue;
    const when = workerWhen(w);
    if (!when) continue;
    const key = when.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(
      parts.length === 0 ? when : when.charAt(0).toLowerCase() + when.slice(1)
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
