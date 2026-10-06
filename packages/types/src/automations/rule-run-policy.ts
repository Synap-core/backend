/**
 * RULE RUN POLICY — how a rule acts, how often, and why a run did not act.
 *
 * Three small vocabularies the engine (`@synap/jobs`), the rule doors
 * (`@synap/api`) and the Rules surfaces (browser / relay) must agree on, kept
 * here ONCE because every one of those consumers already depends on this
 * package and none of them may depend on each other.
 *
 *   1. MODE of a `playbook_run` THEN — what the node materializes:
 *        run          an unattended run (session + channel + agent kickoff)
 *        appointment  a `scheduled` session waiting for the human
 *        propose      a governed `playbook/run` PROPOSAL; nothing starts until
 *                     a person approves it, and approval replays the ONE run
 *                     door (`playbooks.run` → `runPlaybook`).
 *      Absent / unknown ⇒ `run` — every node authored before the field existed.
 *
 *   2. DAILY CAP — `triggerConfig.maxRunsPerDay`, optional. Enforced by the
 *      trigger matcher over a rolling 24h window of runs that actually ran
 *      (skipped runs do not consume it).
 *
 *   3. SKIP REASONS — the token an `automation_runs` row (status `skipped`,
 *      reason in `error_message`) or a step output (`{ status: "skipped",
 *      reason }`) carries. Render through `humanizeToken`, never a local map.
 *
 * Pure + zero-dep — safe in browser, Electron, React Native, Node and CLI.
 */

import type { PlaybookRunNodeDef } from "@synap/database";

// ── 1. Mode ─────────────────────────────────────────────────────────────────

export const PLAYBOOK_RUN_MODES = ["run", "appointment", "propose"] as const;
export type PlaybookRunMode = (typeof PLAYBOOK_RUN_MODES)[number];

// The node's declared `mode` and this list must be the same set, both ways.
type AssertExact<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _modesInSync: AssertExact<
  PlaybookRunMode,
  NonNullable<PlaybookRunNodeDef["data"]["mode"]>
> = true;
void _modesInSync;

/**
 * The ONE read normalizer for a stored node's `mode`. Unknown / absent ⇒
 * `run`, exactly what the executor did before `propose` existed.
 */
export function readPlaybookRunMode(raw: unknown): PlaybookRunMode {
  return typeof raw === "string" &&
    (PLAYBOOK_RUN_MODES as readonly string[]).includes(raw)
    ? (raw as PlaybookRunMode)
    : "run";
}

/**
 * How a WHOLE rule acts, for grouping and marks on a Rules surface:
 * `propose` when any `playbook_run` node in its flow proposes, else `auto`.
 * A flow-shaped value is read defensively — this is called on stored JSON.
 */
export type RuleActMode = "propose" | "auto";

export function ruleActMode(flowDefinition: unknown): RuleActMode {
  const nodes = (flowDefinition as { nodes?: unknown } | null | undefined)
    ?.nodes;
  if (!Array.isArray(nodes)) return "auto";
  return nodes.some(
    (n) =>
      (n as { type?: unknown })?.type === "playbook_run" &&
      readPlaybookRunMode((n as { data?: { mode?: unknown } }).data?.mode) ===
        "propose"
  )
    ? "propose"
    : "auto";
}

// ── 2. Daily cap ────────────────────────────────────────────────────────────

export const MAX_RUNS_PER_DAY_KEY = "maxRunsPerDay" as const;
/** Upper bound accepted at the door — a cap above it is not a cap. */
export const MAX_RUNS_PER_DAY_CEILING = 10_000;

export type MaxRunsPerDayRead =
  { ok: true; value: number | null } | { ok: false; error: string };

/**
 * Read + validate `triggerConfig.maxRunsPerDay`. Absent / null ⇒ no cap.
 * Present ⇒ a positive whole number ≤ {@link MAX_RUNS_PER_DAY_CEILING}, or an
 * error the create/update doors return verbatim.
 */
export function readMaxRunsPerDay(triggerConfig: unknown): MaxRunsPerDayRead {
  const raw = (triggerConfig as Record<string, unknown> | null | undefined)?.[
    MAX_RUNS_PER_DAY_KEY
  ];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > MAX_RUNS_PER_DAY_CEILING
  ) {
    return {
      ok: false,
      error: `triggerConfig.${MAX_RUNS_PER_DAY_KEY} must be a whole number from 1 to ${MAX_RUNS_PER_DAY_CEILING} (got ${JSON.stringify(raw)}).`,
    };
  }
  return { ok: true, value: raw };
}

/** The cap window, in milliseconds: a rolling day. */
export const DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── 3. Skip reasons ─────────────────────────────────────────────────────────

/**
 * Why a rule fired and did nothing. Tokens, not sentences: a surface renders
 * them through `humanizeToken` ("Daily cap reached", "Already proposed").
 */
export const AUTOMATION_SKIP_REASONS = {
  /** Another run already claimed this exact event (dedup). Run row. */
  eventClaimAlreadyHeld: "event_claim_already_held",
  /** The rule hit `maxRunsPerDay` in the last 24h. Run row. */
  dailyCapReached: "daily_cap_reached",
  /** A propose-mode THEN found its pending proposal for the same subject.
   *  Step output (`{ status: "skipped", reason, proposalId }`). */
  alreadyProposed: "already_proposed",
  /** The flow's precondition read false for this event, so it did nothing.
   *  Run row (the executor's precondition gate). */
  conditionNotMet: "condition_not_met",
  /** The run used its `maxAiDispatchesPerRun`; the remaining items did not
   *  run. Step + run `error_message` (see `ai-dispatch-guardrails.ts`). */
  aiDispatchCapReached: "ai_dispatch_cap_reached",
  /** The automation used its rolling-24h `maxAiDispatchesPerDay`. Same rows. */
  aiDailyCapReached: "ai_daily_cap_reached",
  /** The subject's latest run of this playbook failed recently, so the
   *  subject-idempotent path did not start another one. Step output. */
  coolingDown: "cooling_down",
} as const;
export type AutomationSkipReason =
  (typeof AUTOMATION_SKIP_REASONS)[keyof typeof AUTOMATION_SKIP_REASONS];
