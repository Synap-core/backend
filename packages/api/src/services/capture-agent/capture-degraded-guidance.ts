/**
 * capture-degraded-guidance — what an AGENT is told when structuring degraded.
 *
 * ── THE INCIDENT ────────────────────────────────────────────────────────────
 * On any structuring failure the Intelligence Service returns HTTP 200 carrying
 * the user's raw text as a single note entity, flagged `degraded: true` +
 * `degradedReason`; the pod builds its own equivalent after bounded retry
 * (`buildDegradedCaptureFallback`). Relay, the CLI and Raycast all SURVIVE this
 * because they render that payload. Every AGENT door dropped it: the Hub REST
 * 200 returned the payload with no `status` and no `nextStep`, and the
 * `message.interpret` verb returned `{ status:"no_proposal", entityCount: 0 }`
 * while holding the note in its hand. A live agent read that as "nothing was
 * written" and stopped. It behaved correctly given what it was told.
 *
 * ── WHY THIS IS NOT A THIRD COPY TABLE ──────────────────────────────────────
 * `@synap-core/capture-pipeline`'s `describeDegradedReason` is the canonical
 * table of USER-FACING copy (title + detail), and `synap-cli` carries a
 * verbatim-pinned mirror of its `title` half because the CLI is a separate pnpm
 * workspace. `synap-backend` can reach NEITHER — both live outside this repo.
 *
 * The answer is NOT to copy the prose a third time. This module holds no
 * per-reason sentence at all: it maps each reason to its PERMANENCE CLASS and
 * builds the message from the class plus the raw reason token, echoed verbatim.
 * There is nothing here that can drift from the app's copy, because there is
 * nothing here that restates it. An agent needs the machine token and whether
 * retrying can possibly help; a human needs the sentence. Different audiences,
 * different artifacts.
 *
 * ── WHY PERMANENCE IS THE AXIS ──────────────────────────────────────────────
 * `vision_provider_not_configured` reported as "temporarily unavailable" is the
 * exact defect `__tripwires__/capture-degraded-reason-door-parity.test.ts` was
 * written for: a PERMANENT configuration state told to a caller as an outage
 * tells it to retry forever. So no message on any branch may say "temporarily"
 * unless the class actually is transient — and an UNKNOWN reason must never be
 * guessed into the transient bucket, which is where a hardcoded string puts it.
 */

/**
 * How a degraded reason behaves under retry.
 *
 * - `configuration` — the pod is missing a capability or a credential. A
 *   permanent state until an operator changes it; retrying never helps.
 * - `input` — the input itself could not be read (a scan with no text layer, a
 *   type nothing handles, bytes that never arrived). Retrying the SAME input
 *   never helps; a different input may.
 * - `transient` — a genuine hiccup upstream. Retrying may succeed.
 * - `budget` — the Intelligence Service refused the call because its monthly
 *   LLM token budget is spent. Retrying NOW never helps, but it is not
 *   permanent either: it frees when the month rolls over or an operator raises
 *   the budget. Folding it into `unknown` told an agent "may be permanent"
 *   about a state with a named cause and a named fix.
 * - `unknown` — the reason is not one this pod has been taught, or the IS said
 *   nothing at all. Explicitly NOT a synonym for `transient`: claiming a
 *   reason we do not understand is temporary is the defect this module exists
 *   to prevent.
 */
export type DegradedPermanence =
  "configuration" | "input" | "transient" | "budget" | "unknown";

/** Missing capability or credential — an operator must act. */
const CONFIGURATION_REASONS = new Set([
  "vision_provider_not_configured",
  "transcription_provider_not_configured",
  "is_auth_error",
]);

/** The input could not be read. Retrying the same bytes changes nothing. */
const INPUT_REASONS = new Set([
  "pdf_scanned_needs_ocr",
  "pdf_missing_binary",
  "image_missing_binary",
  "audio_missing_binary",
  "docx_missing_binary",
  "docx_empty",
  "html_empty",
  "unsupported_type",
]);

/** Reachable but did not return a usable structure — worth another attempt. */
const TRANSIENT_REASONS = new Set([
  "is_invalid_response",
  // A CONFIGURED vision provider failed (bad key, unfunded, outage) — not the
  // configuration state `vision_provider_not_configured`.
  "vision_provider_failed",
]);

/**
 * The IS token budget refused the call. `llm_budget_exceeded` is the named
 * token; `extraction_error: BudgetExceededError` is what every IS build since
 * the spend guard landed emits for the same refusal, so both are taught.
 */
const BUDGET_REASONS = new Set([
  "llm_budget_exceeded",
  "extraction_error: BudgetExceededError",
]);

/**
 * Classify a degraded reason.
 *
 * `is_empty_result` is deliberately absent from every set above: it is the
 * pod's LAST-RESORT label meaning "we don't know why" (see
 * `resolveEmptyResultDegradedReason`), so it classifies `unknown` — as does any
 * reason the IS adds that this pod has not been taught. The IS owns that
 * vocabulary and may extend it at any time; an unrecognised token must degrade
 * to "we don't know", never to "try again later".
 */
export function classifyDegradedReason(
  reason: string | undefined | null
): DegradedPermanence {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (CONFIGURATION_REASONS.has(trimmed)) return "configuration";
  if (INPUT_REASONS.has(trimmed)) return "input";
  if (TRANSIENT_REASONS.has(trimmed)) return "transient";
  if (BUDGET_REASONS.has(trimmed)) return "budget";
  return "unknown";
}

/** `true` only when retrying the identical call could plausibly succeed. */
export function isDegradedReasonRetryable(
  reason: string | undefined | null
): boolean {
  return classifyDegradedReason(reason) === "transient";
}

/**
 * The agent-facing sentence. Built from the CLASS, with the raw reason token
 * echoed verbatim so the agent can report or branch on the real value — never
 * a per-reason sentence, and never the word "temporarily" outside the one
 * class that has earned it.
 */
export function describeDegradedForAgent(
  reason: string | undefined | null
): string {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  const token = trimmed.length > 0 ? trimmed : "unspecified";
  switch (classifyDegradedReason(trimmed)) {
    case "configuration":
      return (
        `AI structuring could not run because this pod is not configured for it ` +
        `(${token}). This is a CONFIGURATION state, not an outage — retrying will ` +
        `not change it until an operator configures the pod.`
      );
    case "input":
      return (
        `AI structuring could not read this input (${token}). Retrying the same ` +
        `input will not change the outcome.`
      );
    case "transient":
      return (
        `AI structuring failed upstream (${token}). This one is transient — ` +
        `retrying the same call may succeed.`
      );
    case "budget":
      return (
        `AI structuring was refused because the Intelligence Service's monthly ` +
        `LLM token budget is spent (${token}). Retrying now will not help. It is ` +
        `NOT permanent: it frees when the monthly budget window resets, or as soon ` +
        `as an operator raises the budget (TOKEN_ALERT_THRESHOLD / ` +
        `LLM_BUDGET_STOP_STRUCTURE) or exempts this pod's owner.`
      );
    case "unknown":
      return (
        `AI structuring produced no plan and did not say why (${token}). Do not ` +
        `assume this is temporary — it may be a permanent configuration or input ` +
        `state this pod has not been taught to name.`
      );
  }
}

/**
 * The re-call protocol, spelled out — the counterpart to the `followUp`
 * branch's `nextStep`, which teaches the identical loop for a clarifying
 * question. Names the ONE governed door so nothing routes around
 * `submitCaptureGraph` (see `__tripwires__/capture-graph-governance-linkage`).
 *
 * `salvageField` differs per door only in what the salvaged note is CALLED in
 * that door's own payload — the instruction itself is shared.
 */
export function buildDegradedNextStep(salvageField: string): string {
  return (
    `NOT captured — nothing was written and no plan was persisted, but YOUR TEXT IS NOT LOST: ` +
    `it is echoed as a single unstructured note in \`${salvageField}\`. ` +
    `To file it, call the governed capture door with that note passed as an EXPLICIT ` +
    `\`entities\` array — \`synap_capture\` (MCP) or POST /capture/execute — which writes it ` +
    `through the same governance path as any other capture. ` +
    `Do NOT re-run structuring first unless \`degradedRetryable\` is true. ` +
    `Report \`degradedMessage\` to the user rather than inventing a cause.`
  );
}
