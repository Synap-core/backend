/**
 * The automation-health warden's PURE detection tier — finding #1, "zero-run
 * automation": an automation that is enabled, is old enough to have had a fair
 * chance, and has NEVER produced a single run row.
 *
 * ZERO IMPORTS, ZERO I/O — deliberately. The DB tier lives in
 * `automation-health.ts`; everything decidable is decided here so the whole
 * qualification rule is provable without Postgres.
 *
 * ── WHY THIS FINDING AND NOT "SILENT FAILURE" ────────────────────────────────
 * The obvious sibling findings ("it runs but always fails", "it runs but does
 * nothing") both read a REPORTED TERMINAL STATUS. This project has already paid
 * for trusting one of those: a mid-stream agent-turn death was logged as SUCCESS
 * because `finishReason` stayed `"stop"`, which blinded the very health check
 * built to catch it. A warden whose evidence is a status field under-reports
 * exactly the failures it exists to catch, and then certifies the system healthy
 * — the same shape as a reconcile stamping a convergence hash it never earned.
 *
 * Zero-run is EFFECT-BASED: its evidence is the ABSENCE of rows in the
 * `automation_runs` ledger. There is no status to lie. Nothing in this module
 * may ever assert on a run's reported outcome — the run COUNT is the only run
 * fact it is allowed to read, and a run of any status (`completed`, `failed`,
 * `skipped`, `blocked_by_policy`, even a stuck `running`) counts as "it fired".
 * That asymmetry is the safety property: the detector can only ever go QUIET on
 * evidence that something happened, never LOUD on a claim that it succeeded.
 *
 * Row absence is durable here: `automation_runs.automation_id` is
 * `ON DELETE CASCADE` from `automations`, and `automation-run-reaper.ts`
 * finalizes stuck runs rather than pruning rows (verified: the reaper contains
 * no DELETE). If a retention pruner is ever added, THIS COMMENT IS THE CONTRACT
 * IT BREAKS — a pruned ledger would make a busy automation look never-fired.
 *
 * ── WHAT IT CATCHES ──────────────────────────────────────────────────────────
 * The "built with zero producers" class, which has recurred repeatedly here: a
 * trigger the authoring grammar advertises that nothing downstream ever emits
 * (a `.requested` rule where only `.completed` is hardcoded in the side-effect
 * spine), a cron whose queue was never registered, a webhook whose URL nobody
 * ever wired. Every one of those presents identically: enabled, configured,
 * plausible — and zero rows in the ledger.
 */

/**
 * The FULL `automations.status` vocabulary, mirrored from the drizzle column
 * (`packages/database/src/schema/automations.ts`, the `status` text enum).
 *
 * Mirrored rather than imported because this module must stay import-free; the
 * copy is PINNED to the real column by
 * `automation-health-predicate.status-parity.test.ts`, which reads
 * `automations.status.enumValues` off the schema and fails if the two drift. A
 * new status therefore cannot silently land on the wrong side of
 * {@link FIRING_STATUSES} — the parity test goes red and forces a decision.
 */
export const AUTOMATION_STATUSES = [
  "draft",
  "active",
  "paused",
  "error",
  "archived",
] as const;

export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

/**
 * The statuses under which an automation is actually WIRED UP TO FIRE — the
 * warden's definition of "enabled", derived from the vocabulary above rather
 * than spelled as a bare literal at the query site.
 *
 * Only `active` qualifies, and each exclusion is a real one, not an oversight:
 *   - `draft`    — never scheduled or matched; zero runs is the DEFINITION of a
 *                  draft, not a defect. (Three CP cron seeds ship `status:
 *                  "draft"` today, which is a genuine bug — but it is a bug
 *                  about the SEED, and the warden must not restate it as a
 *                  health finding, or every draft in the pod becomes noise.)
 *   - `paused`   — a human deliberately turned it off. Not firing is compliance.
 *   - `error`    — already flagged by its own `errorMessage`; a second, weaker
 *                  finding on the same row is duplicate noise.
 *   - `archived` — terminal soft-delete (0230); excluded from scheduling AND
 *                  matching, so it CANNOT fire by construction.
 */
export const FIRING_STATUSES = [
  "active",
] as const satisfies readonly AutomationStatus[];

/**
 * The FULL `automations.trigger_type` vocabulary, mirrored from the drizzle
 * column and pinned by the same parity test as {@link AUTOMATION_STATUSES}.
 */
export const AUTOMATION_TRIGGER_TYPES = [
  "event",
  "cron",
  "webhook",
  "manual",
] as const;

export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

/**
 * Trigger types whose firing depends on a PRODUCER the automation's author does
 * not personally operate — and therefore the only ones where "never fired" is
 * evidence of a broken wire.
 *
 * `manual` is excluded ON PURPOSE. A manual automation fires when a human clicks
 * it; its producer is the human, and "nobody has clicked it yet" is a usage
 * fact, not a health defect. Including it would flood the finding with every
 * button a user has ever authored and not yet pressed — which is precisely how
 * a review queue trains its reader to ignore it. This is a judgment call, not a
 * technical constraint: widening it back is a one-line change here plus a
 * fixture in the tests.
 */
export const PRODUCER_BACKED_TRIGGERS = [
  "event",
  "cron",
  "webhook",
] as const satisfies readonly AutomationTriggerType[];

/**
 * DEFAULT grace period. An automation younger than this has not yet had a fair
 * chance to fire — a weekly cron authored yesterday is not broken. 14 days
 * clears every trigger cadence the product ships by default (hourly, daily,
 * weekly) with a full period to spare.
 */
export const DEFAULT_MIN_AGE_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The automation columns the predicate reads. A row shape, not the DB row. */
export interface AutomationHealthRow {
  id: string;
  name: string;
  status: string;
  triggerType: string;
  workspaceId: string | null;
  /** Row author — the human the finding is filed FOR. */
  createdBy: string;
  createdAt: Date;
}

/**
 * ONE zero-run finding: everything a reviewer needs to act WITHOUT opening
 * another tab. The brief on evidence is literal — a finding that says only "this
 * is stale" makes the human do the investigation the warden was supposed to do.
 */
export interface ZeroRunFinding {
  /** Stable per-item ref — the key `proposals.rejectItem` writes dispositions under. */
  ref: string;
  automationId: string;
  name: string;
  /** Always one of {@link PRODUCER_BACKED_TRIGGERS}. */
  triggerType: string;
  status: string;
  workspaceId: string | null;
  createdBy: string;
  /** ISO — when it was authored. */
  createdAt: string;
  /** Whole days between `createdAt` and the scan instant. */
  ageDays: number;
  /**
   * ALWAYS 0. Carried explicitly so the stored evidence states the measurement
   * rather than implying it, and so a future non-zero finding class can share
   * this shape without the reader having to infer which one they are reading.
   */
  runCount: 0;
  /** One human sentence naming WHY this fired. */
  why: string;
}

export interface DetectZeroRunArgs {
  /** Candidate rows. The caller may pre-filter; the predicate re-checks anyway. */
  automations: readonly AutomationHealthRow[];
  /**
   * automationId → total rows in `automation_runs`, ANY status. A missing key
   * means zero — but see the note in `automation-health.ts`: the caller must
   * derive this from a ledger query over the SAME id set it passes here, never
   * from `automations.run_count` (a denormalized counter, not the ledger).
   */
  runCountsByAutomationId: ReadonlyMap<string, number>;
  /** Scan instant — injected so age is testable without faking the clock. */
  now: Date;
  minAgeDays?: number;
  /**
   * Automations the RE-NAG GUARD has suppressed this scan (already carrying an
   * open finding, or one decided inside the cooldown). Applied here rather than
   * in the query so the guard is provable in the same DB-free test as the rest.
   */
  suppressedAutomationIds?: ReadonlySet<string>;
}

/** Stable per-item ref. Keyed on the automation id so the same row keeps the
 *  same ref across scans, which is what makes a persisted disposition mean
 *  anything at all. */
export function zeroRunItemRef(automationId: string): string {
  return `automation:${automationId}`;
}

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

const WHY_BY_TRIGGER: Record<string, string> = {
  event:
    "no event matching its trigger has ever been emitted — the event key it listens for may have no producer",
  cron: "its schedule has never produced a run — the cron may never have been registered",
  webhook:
    "no inbound webhook has ever reached it — the endpoint may never have been wired to a sender",
};

/**
 * THE PREDICATE. Given automations + their ledger run counts, return the
 * zero-run findings.
 *
 * Pure: same inputs → same outputs, no clock, no I/O, no DB. Order is stable
 * (oldest first) so a reviewer reads the most-established dead wire first and so
 * the stored payload is diffable across scans.
 */
export function detectZeroRunAutomations(
  args: DetectZeroRunArgs
): ZeroRunFinding[] {
  const {
    automations,
    runCountsByAutomationId,
    now,
    minAgeDays = DEFAULT_MIN_AGE_DAYS,
    suppressedAutomationIds,
  } = args;

  const findings: ZeroRunFinding[] = [];

  for (const row of automations) {
    // ENABLED — derived from the vocabulary, never a bare "active" literal.
    if (!(FIRING_STATUSES as readonly string[]).includes(row.status)) continue;

    // A trigger whose producer is somebody else's code. `manual` never fires
    // itself and is deliberately not a health finding.
    if (
      !(PRODUCER_BACKED_TRIGGERS as readonly string[]).includes(row.triggerType)
    )
      continue;

    const ageDays = wholeDaysBetween(row.createdAt, now);
    if (ageDays < minAgeDays) continue;

    // THE EFFECT-BASED TEST. A run of ANY status counts as "it fired": this
    // predicate must never be the thing that decides a run went well.
    if ((runCountsByAutomationId.get(row.id) ?? 0) > 0) continue;

    if (suppressedAutomationIds?.has(row.id)) continue;

    findings.push({
      ref: zeroRunItemRef(row.id),
      automationId: row.id,
      name: row.name,
      triggerType: row.triggerType,
      status: row.status,
      workspaceId: row.workspaceId,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      ageDays,
      runCount: 0,
      why:
        `Enabled ${ageDays} days ago and has never run: ` +
        (WHY_BY_TRIGGER[row.triggerType] ?? "nothing has ever triggered it"),
    });
  }

  // Oldest first — the longest-dead wire is the most certain finding.
  findings.sort((a, b) => b.ageDays - a.ageDays);
  return findings;
}
