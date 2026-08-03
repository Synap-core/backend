/**
 * AI usage/finish-reason capture across the pod↔IS seam.
 *
 * WHY THIS EXISTS — on 2026-08-03 an `ai.generate` step ran 24.5s, returned
 * `""`, and was recorded `completed`. `synap diagnose` could print `out (empty)`
 * and NOTHING MORE, because the pod stores what the IS returned and has no idea
 * why. Learning the cause meant SSH-ing to the IS container and grepping
 * unstructured logs by wall-clock timestamp. `finishReason` is the one field
 * that answers it — `length` (truncated at maxTokens), `content-filter`,
 * `error`, or `stop` (the model genuinely emitted nothing).
 *
 * WHY AsyncLocalStorage and not a return value — the `ai.generate` verb has a
 * PUBLISHED output contract: the handler returns the IS `output` VALUE directly
 * and the engine stores it flat, so a template reads `steps.<id>.output.<field>`
 * (see builtin-verbs.ts "OUTPUT CONTRACT"). Wrapping the return in an envelope
 * to carry telemetry would silently break every author's templates. The value
 * also crosses four hops that each rebuild it (generateViaIS → verb handler →
 * executeCapability → dispatch result → node output), and this repo has already
 * been bitten by a field dropped at exactly such a rebuild. ALS keeps every
 * signature and return type untouched, keeps the collector's LIFETIME at the
 * step boundary (created and drained by the automation executor, mirroring
 * `unresolved-references.ts`), and cannot cross-contaminate two runs executing
 * concurrently in the same worker process.
 *
 * Recording only. Nothing here may fail or skip a step.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** One IS generation's telemetry. Every field optional — an older IS build that
 *  predates the seam change returns only `output`, and a provider may not report
 *  usage at all. Absent stays NULL rather than a fabricated 0. */
export interface AiUsageSample {
  /** `stop` | `length` | `content-filter` | `tool-calls` | `error` | `other` … */
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Accumulated telemetry for ONE step. A step may make several IS calls (a
 *  loop body, a retry) — tokens SUM, finish reasons collapse to the most
 *  diagnostic one. */
export interface AiUsageTotals {
  finishReason: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensTotal: number | null;
}

/**
 * Which finish reason survives when a step made several calls. `stop` is the
 * boring one; anything else is the finding. So a step that made three calls of
 * which one hit `length` reports `length`, not `stop`.
 */
function moreDiagnostic(a: string | null, b: string): string {
  if (a === null || a === "stop") return b;
  return a;
}

export class AiUsageCollector {
  private finishReason: string | null = null;
  private promptTokens: number | null = null;
  private completionTokens: number | null = null;
  private totalTokens: number | null = null;
  private samples = 0;

  record(sample: AiUsageSample): void {
    this.samples += 1;
    if (typeof sample.finishReason === "string" && sample.finishReason) {
      this.finishReason = moreDiagnostic(
        this.finishReason,
        sample.finishReason
      );
    }
    if (Number.isFinite(sample.promptTokens)) {
      this.promptTokens = (this.promptTokens ?? 0) + (sample.promptTokens ?? 0);
    }
    if (Number.isFinite(sample.completionTokens)) {
      this.completionTokens =
        (this.completionTokens ?? 0) + (sample.completionTokens ?? 0);
    }
    if (Number.isFinite(sample.totalTokens)) {
      this.totalTokens = (this.totalTokens ?? 0) + (sample.totalTokens ?? 0);
    }
  }

  /** How many IS generations this step made. 0 = no AI call, so nothing to write. */
  get size(): number {
    return this.samples;
  }

  totals(): AiUsageTotals {
    // Derive the total when the provider reported the parts but not the sum —
    // the step ledger's existing `tokens_used` column is a TOTAL.
    const total =
      this.totalTokens ??
      (this.promptTokens !== null || this.completionTokens !== null
        ? (this.promptTokens ?? 0) + (this.completionTokens ?? 0)
        : null);
    return {
      finishReason: this.finishReason,
      tokensIn: this.promptTokens,
      tokensOut: this.completionTokens,
      tokensTotal: total,
    };
  }
}

const storage = new AsyncLocalStorage<AiUsageCollector>();

/**
 * Open an AI-usage scope for ONE step and return its collector.
 *
 * `enterWith` (not `run`) for the same reason as `beginStepDiagnostics`: the
 * executor's node walk needs a single statement per node instead of wrapping
 * its switch in a callback. The store binds to the current async context and
 * every awaited descendant of this node's execution — until the next node
 * replaces it.
 */
export function beginAiUsageCapture(): AiUsageCollector {
  const collector = new AiUsageCollector();
  storage.enterWith(collector);
  return collector;
}

/** Explicit scoping — used by tests and by any caller that wants containment. */
export function withAiUsageCapture<T>(
  collector: AiUsageCollector,
  fn: () => T
): T {
  return storage.run(collector, fn);
}

/**
 * Record one IS generation's telemetry. A NO-OP outside a step scope — the IS
 * callers are exported functions used by MCP, tRPC and tests, and telemetry
 * must never be a reason for those to behave differently.
 */
export function recordAiUsage(sample: AiUsageSample): void {
  storage.getStore()?.record(sample);
}

/** The collector for the step currently executing, if any. */
export function currentAiUsage(): AiUsageCollector | undefined {
  return storage.getStore();
}
