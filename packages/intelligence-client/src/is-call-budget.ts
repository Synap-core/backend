/**
 * IS call budgets + attributed failures — the SSOT for "how long may a
 * backend→IS HTTP call take, and what do we say when it doesn't finish".
 *
 * WHY THIS EXISTS (the 2026-07-31 incident): a report run's `analyze` step
 * failed after exactly 60.011s with `errorMessage: "The operation was aborted
 * due to timeout"` and `output: {}`. Three things were wrong at once:
 *
 *   1. The 60s ceiling was a copy-pasted literal with no owner and no way to
 *      raise it without a deploy. It had never been exercised while the upstream
 *      gather was returning nothing; the moment a data bug was fixed the prompt
 *      grew to ~6KB and the ceiling bit.
 *
 *      An earlier revision of this comment claimed the literal lived in "THREE
 *      places" and that all three were migrated. That was wrong, and the wrong
 *      number is worth preserving as a lesson: a review found TWO more IS call
 *      sites still on hardcoded ceilings — proactive-intelligence.ts (the same
 *      bare 60_000, with its failure swallowed into a logger.warn that named
 *      neither side nor elapsed) and automation-pattern-detector.ts (30_000, on
 *      a generation-shaped call whose prompt grows with workspace activity).
 *      Both took a budget; the pattern detector has since been DELETED (it
 *      guessed via the IS and wrote draft automations with no proposal row).
 *      Nothing replaces its IS call today, so this list is one site shorter —
 *      do not go looking for a successor entry.
 *      If you add an IS call site, add it here — grep
 *      `AbortSignal.timeout` and `setTimeout(.*abort` across jobs + api before
 *      claiming this list is complete.
 *   2. 60s is simply the wrong number for a reasoning model. A reasoning model
 *      emits hidden reasoning tokens BEFORE the visible completion, and the IS
 *      FairSemaphore may queue the request behind interactive traffic. The
 *      budget has to cover queue-wait + reasoning + emission, not emission.
 *   3. The error named neither side, nor the elapsed time, nor the payload
 *      size — the one variable that actually predicts this failure. An operator
 *      reading `errorMessage` could not tell a pod-side abort from an IS crash
 *      from a network drop without grepping two packages.
 *
 * This module owns (1) and (2) as env-overridable named budgets, and (3) as a
 * single failure-describer every IS call site funnels through.
 *
 * It lives in `@synap/intelligence-client` because that package already owns IS
 * transport (the headless fetches + the ONE SSE parser). `@synap/api` and
 * `@synap/jobs` both depend on it, so there is no new edge and no cycle.
 */

/**
 * The three IS workload shapes. These are NOT one number because they are not
 * one kind of work:
 *
 *  - `generation`  — ONE model call (`/v1/tools/generate`, `/v1/tools/mail_triage`).
 *                    Latency = queue wait + prompt processing + token emission.
 *  - `agentTurn`   — a FULL agent turn (`/api/chat/stream`): a loop of N model
 *                    calls interleaved with tool round-trips. Strictly more work
 *                    than a generation, so a strictly larger budget.
 *  - `command`     — a bounded IS task action (`/api/tasks/execute`). One
 *                    action, may invoke a model, does not loop.
 *
 * Collapsing these to one constant would either starve the agent turn or leave
 * a wedged one-shot generate holding an automation step open far too long.
 */
export type ISCallKind = "generation" | "agentTurn" | "command";

/**
 * Defaults, each with its reasoning — do NOT change one without stating why.
 *
 * `generation` = 180_000 (3 min)
 *   The observed failure was at 60s on a ~6KB prompt asking for 700 visible
 *   tokens from a reasoning model. 3× that ceiling covers the hidden-reasoning
 *   phase plus FairSemaphore queue-wait, while still bounding a wedged IS: an
 *   automation step can stall for at most 3 minutes, not forever.
 *
 * `agentTurn` = 240_000 (4 min)
 *   HARD UPPER BOUND: the a2ai-response-trigger pg-boss job declares
 *   `expireInSeconds: 300` (a2ai-response-trigger.ts). A fetch budget at or
 *   above 300s is worthless — pg-boss reclaims the job while the request is
 *   still in flight and the work is done twice. 240s leaves 60s of headroom for
 *   the surrounding work (drain the SSE, persist the assistant reply).
 *
 * `command` = 120_000 (2 min)
 *   A bounded action, not an agent loop; but it may still invoke a model, so
 *   the old 60s had the same reasoning-model exposure. Doubling clears that
 *   without pretending a command needs an agent-turn budget.
 */
const DEFAULT_BUDGET_MS: Record<ISCallKind, number> = {
  generation: 180_000,
  agentTurn: 240_000,
  command: 120_000,
};

/** Per-kind env override. Read per call (not at import) so ops can't be defeated
 *  by module load order, and so tests can set one without re-importing. */
const ENV_KEY: Record<ISCallKind, string> = {
  generation: "SYNAP_IS_GENERATION_TIMEOUT_MS",
  agentTurn: "SYNAP_IS_AGENT_TURN_TIMEOUT_MS",
  command: "SYNAP_IS_COMMAND_TIMEOUT_MS",
};

/**
 * The configured budget in ms for an IS call kind. A non-numeric or
 * non-positive env value is IGNORED (falls back to the default) rather than
 * producing an instant-abort `AbortSignal.timeout(0)` — a typo in an env var
 * must not silently break every AI step.
 */
export function isCallBudgetMs(kind: ISCallKind): number {
  const raw = process.env[ENV_KEY[kind]];
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULT_BUDGET_MS[kind];
}

/**
 * ── RETRYABILITY (2026-08-03 incident) ───────────────────────────────────────
 *
 * The automation executor's per-node retry loop (`errorHandling.maxRetries`) is
 * ERROR-TYPE BLIND: it re-attempts every failure identically. That is fine for a
 * pod-side abort or an IS 5xx, and actively harmful for a DETERMINISTIC failure
 * — the same prompt at the same `maxTokens` truncates the same way every time,
 * so a retry buys 3× the tokens and 3× the latency for the identical error.
 *
 * The shape is the one every durable-execution engine converged on (Temporal
 * `nonRetryableErrorTypes`, Restate `TerminalError`, Inngest `NonRetriableError`):
 * **retry is the DEFAULT, and the PRODUCER of the error declares the opt-out.**
 * `isRetryableError` therefore returns `true` for anything it does not recognise
 * — an unknown failure is assumed transient, never silently made terminal.
 *
 * WHY A MARKER PROPERTY + A MESSAGE FALLBACK, and not an Error subclass:
 *   · `@synap/jobs` already depends on `@synap/intelligence-client` (and NOT on
 *     `@synap/api`), so this module is the only place both the producer
 *     (`generateViaIS`, api-side) and the consumer (the executor, jobs-side) can
 *     share. No new package edge, no cycle.
 *   · A subclass would not survive the hops. `instanceof` breaks across a dual
 *     package instance, and — verified — `executeCapabilityNode`
 *     (automation-executor.ts) REBUILDS a `kind:"error"` dispatch verdict as
 *     `new Error(\`Capability ${verbId} failed: ${message}\`)`. The builtin tier
 *     (`ai.generate`) rethrows the original object, so the marker carries; the
 *     declarative/code-skill tiers survive only as a message. Reading BOTH costs
 *     three lines and covers both tiers.
 * This is ONE predicate with ONE call site — deliberately not a taxonomy.
 */
const NON_RETRYABLE_MARKER = "synapNonRetryable";

/**
 * The message signature of the one non-retryable IS failure, used when only the
 * message survived a rebuild hop. Both halves are asserted so a plain empty
 * completion (retryable — the model may well answer on a second pass) is not
 * caught by the `length` case.
 */
const NON_RETRYABLE_MESSAGE_SIGNATURE = [
  "[empty completion]",
  "finishReason=length",
];

/** Stamp an error as terminal. Non-enumerable so it never leaks into a JSON
 *  serialisation of the error or a log line's field soup. */
function markNonRetryable<E extends Error>(err: E): E {
  Object.defineProperty(err, NON_RETRYABLE_MARKER, {
    value: true,
    enumerable: false,
  });
  return err;
}

/**
 * Should a failed attempt be tried again? **Defaults to `true`** — only an error
 * this module has explicitly marked terminal (or whose attributed message
 * survived a rebuild) is non-retryable.
 *
 * Non-retryable today: an empty generation caused by `finishReason=length`. That
 * is a deterministic truncation — same prompt, same ceiling, same result. The
 * fix is `maxTokens` (or a shorter prompt), never another attempt.
 *
 * Retryable: everything else — a pod-side abort (the IS may finish under a less
 * loaded FairSemaphore), a transport failure, an IS 5xx, and an empty completion
 * with any OTHER finish reason (`stop`/`content-filter` can differ run to run).
 */
export function isRetryableError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return true;
  if ((err as Record<string, unknown>)[NON_RETRYABLE_MARKER] === true)
    return false;
  const message = (err as { message?: unknown }).message;
  if (
    typeof message === "string" &&
    NON_RETRYABLE_MESSAGE_SIGNATURE.every((part) => message.includes(part))
  )
    return false;
  return true;
}

/** What the caller knows about the in-flight request, for attribution. */
export interface ISCallContext {
  kind: ISCallKind;
  /** Full request URL — which IS, which endpoint. No secrets ride in the URL. */
  endpoint: string;
  /**
   * Size of the serialized request body in characters. Uniform across call
   * sites on purpose: for a `generation` the body IS essentially the prompt, so
   * one field covers every site without each one guessing which of its args is
   * "the prompt". This is the variable that predicts the timeout.
   */
  payloadChars: number;
  /** `Date.now()` captured immediately before `fetch`. */
  startedAt: number;
  /** The budget handed to the abort signal, for the "of a Nms budget" phrase. */
  budgetMs: number;
}

/** True for the two ways an AbortSignal surfaces (`AbortSignal.timeout` yields
 *  `TimeoutError`; `controller.abort()` yields `AbortError`). */
function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Build the ONE attributed failure message. Deliberately a plain `Error` (no
 * class hierarchy): the only consumer that matters is a human reading the
 * `error_message` TEXT column of `automation_step_runs`, where the executor
 * writes `lastError.message` verbatim.
 *
 * Shape — one line, ` · `-separated so it stays greppable:
 *
 *   IS generation call failed [pod-side abort] — gave up after 60011ms of a
 *   180000ms budget · endpoint=https://is.example/v1/tools/generate ·
 *   payloadChars=6144 · cause=TimeoutError: The operation was aborted due to timeout
 *
 * `side` answers the question that cost a real debugging hour:
 *   - `pod-side abort`     — WE hung up. The IS may well have finished a second
 *                            later. Raise the budget / shrink the prompt.
 *   - `IS error`           — the IS answered, with a non-2xx. Its problem.
 *   - `transport failure`  — neither: DNS/TLS/connection-reset. Network/deploy.
 */
export function describeISFailure(ctx: ISCallContext, err: unknown): Error {
  const elapsedMs = Date.now() - ctx.startedAt;
  const side = isAbort(err) ? "pod-side abort" : "transport failure";
  const name = (err as { name?: unknown } | null)?.name;
  const message =
    err instanceof Error ? err.message : String(err ?? "unknown error");
  return new Error(
    `IS ${ctx.kind} call failed [${side}] — gave up after ${elapsedMs}ms of a ${ctx.budgetMs}ms budget` +
      ` · endpoint=${ctx.endpoint}` +
      ` · payloadChars=${ctx.payloadChars}` +
      ` · cause=${typeof name === "string" && name ? `${name}: ` : ""}${message}`
  );
}

/**
 * The `empty completion` half: the IS answered 200 OK and produced NOTHING —
 * no text, or whitespace only. Same envelope as the other two so an operator
 * reads ONE format regardless of which way the call failed.
 *
 * WHY THIS IS A FAILURE (run 92fb258a, 2026-08-03): a report run's `analyze`
 * step ran 24.5s, returned `""`, and was recorded `completed`; `relate` did the
 * same in 9.9s. The assembler then honestly wrote "No analysis material was
 * produced", the body cleared the 200-char guard because an apology is long,
 * and the run reported `completed` with a report entity created. Three
 * independent safety mechanisms all said "success" about a report carrying zero
 * information — because nothing on the path treated an empty generation as an
 * error. A GENERATION that produced nothing is never valid data (unlike a query
 * returning zero rows), so it throws here, at the one call site that owns the
 * IS `generate` response.
 *
 * `maxTokens` rides in the message because it is the variable that predicts
 * this failure: `ai.generate` is served by a reasoning model that spends its
 * budget on hidden reasoning tokens BEFORE the first visible one, so a ceiling
 * set too low yields an empty string rather than a short answer (dogfooded
 * 2026-07-26: empty at 20 and 120, degraded at 300, correct at 500).
 */
export function describeISEmptyGeneration(
  ctx: ISCallContext,
  details: {
    outputType: string;
    maxTokens?: number;
    /** The IS/provider's own reason the generation ended — `length`,
     *  `content-filter`, `error`, `stop`. THE field that explains an empty
     *  completion. Undefined against an IS build that predates the seam
     *  telemetry change (it returned only `output`). */
    finishReason?: string;
    /** How many tokens the model actually emitted. `0` alongside
     *  `finishReason=stop` is the signature of a model that said nothing. */
    completionTokens?: number;
  }
): Error {
  const elapsedMs = Date.now() - ctx.startedAt;
  const err = new Error(
    `IS ${ctx.kind} call failed [empty completion] — the IS answered 200 OK but produced no content` +
      ` after ${elapsedMs}ms of a ${ctx.budgetMs}ms budget` +
      ` · endpoint=${ctx.endpoint}` +
      ` · payloadChars=${ctx.payloadChars}` +
      ` · outputType=${details.outputType}` +
      ` · maxTokens=${details.maxTokens ?? "default"}` +
      (details.finishReason ? ` · finishReason=${details.finishReason}` : "") +
      (details.completionTokens !== undefined
        ? ` · completionTokens=${details.completionTokens}`
        : "") +
      ` · An empty generation is a FAILURE, not an empty result — raise maxTokens` +
      ` or shorten the prompt.`
  );
  // TERMINAL when the budget truncated it. `finishReason=length` means the model
  // spent every token it was allowed on hidden reasoning before emitting one
  // visible token — a pure function of (prompt, maxTokens), both of which are
  // identical on the next attempt. Retrying is 3× the tokens for the same error.
  // Every other finish reason stays retryable (the default).
  return details.finishReason === "length" ? markNonRetryable(err) : err;
}

/**
 * The `IS error` half: the IS answered with a non-2xx. Same envelope so an
 * operator reads ONE format regardless of which side failed. `body` is
 * truncated because an IS stack trace can be megabytes and this string lands in
 * a column a human reads in a table cell.
 */
export function describeISHttpError(
  ctx: ISCallContext,
  status: number,
  statusText: string,
  body?: string
): Error {
  const elapsedMs = Date.now() - ctx.startedAt;
  const trimmed = (body ?? "").trim().slice(0, 300);
  return new Error(
    `IS ${ctx.kind} call failed [IS error] — HTTP ${status}${statusText ? ` ${statusText}` : ""}` +
      ` after ${elapsedMs}ms of a ${ctx.budgetMs}ms budget` +
      ` · endpoint=${ctx.endpoint}` +
      ` · payloadChars=${ctx.payloadChars}` +
      (trimmed ? ` · body=${trimmed}` : "")
  );
}
