/**
 * The meter of ONE direct capability run: who billed it, what it bought, and
 * what it cost. Written by `recordDirectCapabilityRun` onto the run's own
 * `capability_run` event (the `provider` / `cost_usd` / `latency_ms` columns of
 * 0131, plus `data.meter`), so the run record IS the receipt: no second table,
 * no second door.
 *
 * A run is metered only when its verb DECLARES `metadata.metering`
 * (`declaredMetering`). The price is, in this order:
 *   1. INGESTED: the number the provider reported, at the declared `costPath`
 *      of the run result (`costSource: "provider"`);
 *   2. a declared PRICE TABLE: `metering.costUsd` per run
 *      (`costSource: "price_table"`);
 *   3. UNKNOWN: `costUsd: null`. Never 0: a run nobody priced is not free, and
 *      the readers count it as unpriced (their sum is then a floor).
 * A failed run is unpriced: whether the provider billed it is not known here.
 */

import { readPath } from "../../connectors/session-auth.js";
import { declaredMetering } from "./capability-drift.js";

export interface CapabilityRunMeter {
  provider: string;
  unit: string;
  /** Units bought by this run: one call. */
  quantity: number;
  /** USD, or `null` when nobody reported or declared a price. */
  costUsd: number | null;
  costSource: "provider" | "price_table" | null;
  latencyMs: number;
}

export function meterCapabilityRun(
  metadata: unknown,
  run: { result: unknown; failed: boolean; latencyMs: number }
): CapabilityRunMeter | undefined {
  const declared = declaredMetering(
    metadata as Record<string, unknown> | null | undefined
  );
  if (!declared) return undefined;
  const reported =
    !run.failed && declared.costPath
      ? readPath(run.result, declared.costPath)
      : undefined;
  const priced =
    typeof reported === "number" && Number.isFinite(reported) && reported >= 0
      ? { costUsd: reported, costSource: "provider" as const }
      : !run.failed && typeof declared.costUsd === "number"
        ? { costUsd: declared.costUsd, costSource: "price_table" as const }
        : { costUsd: 0, costSource: null };
  return {
    provider: declared.provider,
    unit: declared.unit,
    quantity: 1,
    ...priced,
    latencyMs: Math.max(0, Math.round(run.latencyMs)),
  };
}
