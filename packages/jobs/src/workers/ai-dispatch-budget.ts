/**
 * The AI dispatch budget of ONE automation run — the executor-side enforcement
 * of `AI_DISPATCH_GUARDRAILS` (`@synap-core/types/automations`).
 *
 * Enforced here, in the executor, because this is the one place every trigger
 * origin passes through: the cron path never reached the matcher's
 * `maxRunsPerDay`, which is how a cron rule ran ~200 AI calls a day for weeks.
 *
 * Two limits, checked on every reservation:
 *   - per run  — `maxAiDispatchesPerRun`, counted across loop iterations;
 *   - per day  — `triggerConfig.maxAiDispatchesPerDay` (default in the
 *     guardrails), summed over this automation's runs in a rolling 24h from
 *     `automation_runs.ai_dispatch_count`.
 *
 * Each reservation bumps `ai_dispatch_count` on the run row as it happens, so a
 * run that dies midway still counts what it spent, and a delay-resumed run
 * picks up its own count. A reservation that turned out to dispatch nothing
 * (a playbook run that was skipped, reused or only proposed) is released.
 *
 * Lazy: a run that never reaches an AI node issues no query at all.
 *
 * Concurrency: the daily reservation is ATOMIC. `reserve()` takes a
 * transaction-scoped advisory lock keyed by the automation id, re-reads the
 * rolling-24h sum inside it, and bumps this run's count before releasing — so
 * two concurrent runs of one automation can never both pass the cap. (A plain
 * conditional UPDATE would not do: under READ COMMITTED each run would still
 * sum a snapshot that misses the other's bump.) The per-run cap is exact too.
 */
import { db, and, eq, ne, drizzleSql, automationRuns } from "@synap/database";
import {
  AI_DISPATCH_GUARDRAILS,
  AUTOMATION_SKIP_REASONS,
  readMaxAiDispatchesPerDay,
} from "@synap-core/types/automations";
import { PolicyBlockedError } from "../utils/automation-governance.js";
import { logger } from "./automation-executor-logger.js";

export type AiCapReason =
  | typeof AUTOMATION_SKIP_REASONS.aiDispatchCapReached
  | typeof AUTOMATION_SKIP_REASONS.aiDailyCapReached;

/**
 * A guardrail refusal. A `PolicyBlockedError`, so the step and run read the
 * calm `blocked_by_policy` outcome (not a red transport error) and the step is
 * never retried — the same refusal would come back every attempt. The message
 * starts with the reason token so the run row says why without a lookup.
 */
export class AiDispatchCapError extends PolicyBlockedError {
  constructor(
    public readonly reason: AiCapReason,
    message: string
  ) {
    super("deny", message);
    this.name = "AiDispatchCapError";
  }
}

export type AiReservation =
  { ok: true } | { ok: false; reason: AiCapReason; message: string };

export interface AiDispatchBudget {
  /** Take one dispatch, or say which cap refused it. Persists the count. */
  reserve(): Promise<AiReservation>;
  /** Give back the last reservation: it dispatched nothing. */
  release(): Promise<void>;
  /** Dispatches this run has spent so far (after the first reserve). */
  readonly usedThisRun: number;
  /** This automation's dispatches in the rolling 24h, this run included. */
  readonly usedToday: number;
  readonly perRun: number;
  readonly perDay: number;
}

/** Sentence for a refusal, reason token first. */
export function aiCapMessage(input: {
  reason: AiCapReason;
  perRun: number;
  perDay: number;
  usedToday: number;
  skippedItems?: number;
  totalItems?: number;
}): string {
  const limit =
    input.reason === AUTOMATION_SKIP_REASONS.aiDispatchCapReached
      ? `this run already started ${input.perRun} AI dispatches (the per-run cap)`
      : `this automation already started ${input.usedToday} of its ${input.perDay} AI dispatches in the last 24 hours`;
  const skipped =
    input.skippedItems !== undefined && input.totalItems !== undefined
      ? ` ${input.skippedItems} of ${input.totalItems} items were skipped and did not run.`
      : " The remaining AI steps were skipped and did not run.";
  return `${input.reason}: ${limit}.${skipped}`;
}

/** Step outputs that mean "no agent was started". */
export function dispatchedNothing(output: unknown): boolean {
  const status = (output as { status?: unknown } | null)?.status;
  return (
    status === "skipped" ||
    status === "reused" ||
    status === "scheduled" ||
    status === "proposed"
  );
}

export function openAiDispatchBudget(input: {
  runId: string;
  automationId: string;
  triggerConfig: unknown;
  perRun?: number;
}): AiDispatchBudget {
  const perRun = input.perRun ?? AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerRun;
  const dayRead = readMaxAiDispatchesPerDay(input.triggerConfig);
  if (!dayRead.ok) {
    logger.warn(
      { automationId: input.automationId, error: dayRead.error },
      "Ignoring malformed maxAiDispatchesPerDay on a stored automation — using the default"
    );
  }
  const perDay = dayRead.ok
    ? dayRead.value
    : AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerDayDefault;

  let loaded = false;
  let usedThisRun = 0;
  let usedTodayByOthers = 0;

  const load = async (): Promise<void> => {
    if (loaded) return;
    const [own] = await db
      .select({ count: automationRuns.aiDispatchCount })
      .from(automationRuns)
      .where(eq(automationRuns.id, input.runId))
      .limit(1);
    usedThisRun = own?.count ?? 0;
    loaded = true;
  };

  /** Rolling-24h sum of the automation's OTHER runs. Call inside the lock. */
  const sumOthers = async (tx: Pick<typeof db, "select">): Promise<number> => {
    const [others] = await tx
      .select({
        total: drizzleSql<number>`COALESCE(SUM(${automationRuns.aiDispatchCount}), 0)::int`,
      })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, input.automationId),
          ne(automationRuns.id, input.runId),
          // Interval arithmetic in SQL: postgres.js on the pod image crashes
          // on a bound Date (same constraint the reapers document).
          drizzleSql`${automationRuns.startedAt} > now() - interval '24 hours'`
        )
      );
    return Number(others?.total ?? 0);
  };

  const bump = (delta: 1 | -1) =>
    db
      .update(automationRuns)
      .set({
        aiDispatchCount: drizzleSql`GREATEST(${automationRuns.aiDispatchCount} + ${delta}, 0)`,
      })
      .where(eq(automationRuns.id, input.runId));

  return {
    perRun,
    perDay,
    get usedThisRun() {
      return usedThisRun;
    },
    get usedToday() {
      return usedTodayByOthers + usedThisRun;
    },
    async reserve() {
      await load();
      if (usedThisRun >= perRun) {
        const reason = AUTOMATION_SKIP_REASONS.aiDispatchCapReached;
        return {
          ok: false,
          reason,
          message: aiCapMessage({
            reason,
            perRun,
            perDay,
            usedToday: usedTodayByOthers + usedThisRun,
          }),
        };
      }
      return db.transaction(async (tx): Promise<AiReservation> => {
        await tx.execute(
          drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${input.automationId}::text))`
        );
        usedTodayByOthers = await sumOthers(tx);
        const usedToday = usedTodayByOthers + usedThisRun;
        if (usedToday >= perDay) {
          const reason = AUTOMATION_SKIP_REASONS.aiDailyCapReached;
          return {
            ok: false,
            reason,
            message: aiCapMessage({ reason, perRun, perDay, usedToday }),
          };
        }
        await tx
          .update(automationRuns)
          .set({
            aiDispatchCount: drizzleSql`${automationRuns.aiDispatchCount} + 1`,
          })
          .where(eq(automationRuns.id, input.runId));
        usedThisRun += 1;
        return { ok: true };
      });
    },
    async release() {
      if (usedThisRun === 0) return;
      usedThisRun -= 1;
      await bump(-1);
    },
  };
}
