/**
 * Bounded retry for the IS `structure()` call.
 *
 * WHY this exists (measured incident, 2026-08-01): `POST /api/hub/capture/
 * structure` was intermittently returning `is_invalid_response` for ~60% of
 * calls with no retry — the same input succeeded alone and produced nothing in
 * a batch. The IS later went fully down (502) and the failure rate was
 * invisible because nothing logged the transient rate.
 *
 * WHAT COUNTS AS RETRYABLE — `IntelligenceHubClient.structure()` has exactly
 * two failure signals:
 *   - it RETURNS `null` for every non-auth failure: 5xx, 502 from the proxy,
 *     network error, abort/timeout, malformed body. → retryable, EXCEPT a
 *     timeout (see below).
 *   - it THROWS `IntelligenceAuthError` for 401/403 only. → NEVER retried: a
 *     bad credential will never succeed and each attempt is an expensive LLM
 *     call. This helper catches nothing, so an auth throw propagates on the
 *     first attempt.
 *
 * FAST-NULL vs SLOW-NULL. A `null` is ambiguous: transient error (worth a
 * retry) or a genuine timeout that burned the whole budget (never worth one —
 * a long input that crossed the budget crosses it again, doubling latency and
 * cost for near-zero gain). We classify by elapsed time: a null returned in
 * less than `fastNullRatio` of the per-call timeout is transient; anything
 * slower is a timeout and stops the loop immediately.
 *
 * NOT HANDLED HERE: `is_empty_result` — a well-formed 200 carrying zero
 * entities. That is a SUCCESSFUL call whose extraction was honestly empty
 * (input with nothing to extract) or model-degraded; the two are
 * indistinguishable from the response, so retrying would double the LLM cost
 * of every genuinely-empty capture. The caller degrades it without a retry.
 *
 * Dependency-free by design (no db, no logger) so the policy is unit-testable
 * without a database — the caller supplies logging via `onRetry`.
 */

/** Why an attempt did not yield a usable structure. */
export type StructureRetryReason =
  /** Fast null — transient IS/network/proxy failure. Retryable. */
  | "transient_null"
  /** Slow null — the call burned the timeout budget. NOT retryable. */
  | "timeout_null";

export interface StructureRetryOptions {
  /** Per-call abort budget in ms — the same value passed to `structure()`. */
  timeoutMs: number;
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Delay before the 2nd attempt; doubled for each later one. Default 300. */
  initialBackoffMs?: number;
  /** Backoff growth factor. Default 2. */
  backoffMultiplier?: number;
  /** Elapsed fraction of `timeoutMs` under which a null counts as transient. Default 0.7. */
  fastNullRatio?: number;
  /** Observability hook — called once per retry, BEFORE the backoff sleep. */
  onRetry?: (info: {
    /** 1-based index of the attempt that just failed. */
    attempt: number;
    maxAttempts: number;
    reason: StructureRetryReason;
    elapsedMs: number;
    backoffMs: number;
  }) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. */
  now?: () => number;
}

export interface StructureRetryOutcome<T> {
  /** The structure result, or null if every attempt failed. */
  result: T | null;
  /** How many attempts were actually made (1..maxAttempts). */
  attempts: number;
  /** Why the last attempt failed. Undefined when `result` is non-null. */
  lastReason?: StructureRetryReason;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call `structure` with a bounded retry on transient (fast-null) failures.
 *
 * Never swallows a throw: `IntelligenceAuthError` (and any other throw)
 * propagates from the first attempt, un-retried.
 */
export async function callStructureWithRetry<T>(
  call: () => Promise<T | null>,
  options: StructureRetryOptions
): Promise<StructureRetryOutcome<T>> {
  const {
    timeoutMs,
    maxAttempts = 3,
    initialBackoffMs = 300,
    backoffMultiplier = 2,
    fastNullRatio = 0.7,
    onRetry,
    sleep = defaultSleep,
    now = Date.now,
  } = options;

  const attemptCap = Math.max(1, maxAttempts);
  let lastReason: StructureRetryReason | undefined;

  for (let attempt = 1; attempt <= attemptCap; attempt++) {
    const t0 = now();
    const result = await call();
    if (result) return { result, attempts: attempt };

    const elapsedMs = now() - t0;
    lastReason =
      elapsedMs < timeoutMs * fastNullRatio ? "transient_null" : "timeout_null";

    // A timeout is not transient — stop rather than burn another full budget.
    if (lastReason === "timeout_null") {
      return { result: null, attempts: attempt, lastReason };
    }
    if (attempt >= attemptCap) break;

    const backoffMs = Math.round(
      initialBackoffMs * Math.pow(backoffMultiplier, attempt - 1)
    );
    onRetry?.({
      attempt,
      maxAttempts: attemptCap,
      reason: lastReason,
      elapsedMs,
      backoffMs,
    });
    await sleep(backoffMs);
  }

  return { result: null, attempts: attemptCap, lastReason };
}
