/**
 * ai.generate caller — the synchronous LLM completion step shared by the
 * `ai.generate` builtin verb (and any future in-process AI step).
 *
 * Mirrors `triage.ts`: a normal backend→IS AI op that authenticates with the
 * pod's PER-CONNECTION key resolved from the DB (`getDefaultActiveService`),
 * NEVER from env, and NEVER the CP↔IS internal key. It POSTs to the IS
 * `/v1/tools/generate` endpoint and returns the response's `output` VALUE — the
 * raw completion text, or (when `json:true`) the parsed JSON object.
 */
import { getDefaultActiveService } from "../../utils/intelligence-routing.js";
import {
  isCallBudgetMs,
  describeISFailure,
  describeISHttpError,
  describeISEmptyGeneration,
  recordAiUsage,
  type ISCallContext,
} from "@synap/intelligence-client";

export interface GenerateArgs {
  system?: string;
  prompt: string;
  /** When true, the IS parses the model output as JSON and `output` is that object. */
  json?: boolean;
  maxTokens?: number;
}

/**
 * Run a single-shot LLM completion via the IS `generate` tool. Returns the IS
 * `output` field directly (text or parsed JSON). Throws on a non-2xx IS response
 * — AND on an EMPTY completion — so the caller (a builtin verb inside an
 * automation) fails loudly, not silently.
 *
 * THIS IS THE CALL THAT BLEW UP ON 2026-07-31: a report `analyze` step died at
 * exactly 60.011s against a hardcoded `AbortSignal.timeout(60_000)` with a ~6KB
 * prompt, and reported only "The operation was aborted due to timeout" — no
 * side, no elapsed, no size. The budget now comes from `isCallBudgetMs
 * ("generation")` (env-overridable) and every failure is attributed.
 */
export async function generateViaIS(args: GenerateArgs): Promise<unknown> {
  const { endpoint: isUrl, apiKey } = await getDefaultActiveService();
  const endpoint = `${isUrl}/v1/tools/generate`;
  const budgetMs = isCallBudgetMs("generation");
  const body = JSON.stringify({
    ...(args.system !== undefined ? { system: args.system } : {}),
    prompt: args.prompt,
    json: args.json ?? false,
    ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
  });
  // For a `generate` the body IS the prompt (+ a few dozen chars of envelope) —
  // this is the number that predicts whether the budget will hold.
  const ctx: ISCallContext = {
    kind: "generation",
    endpoint,
    payloadChars: body.length,
    startedAt: Date.now(),
    budgetMs,
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body,
      signal: AbortSignal.timeout(budgetMs),
    });
  } catch (err) {
    throw describeISFailure(ctx, err);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw describeISHttpError(ctx, res.status, res.statusText, text);
  }
  // The IS returns `{ output, finishReason?, usage? }`. We still return `output`
  // and ONLY `output` — the `ai.generate` verb's published output contract is
  // that the node's output IS the IS output value, so an envelope here would
  // break every `steps.<id>.output.<field>` template an author has written. The
  // telemetry rides the AsyncLocalStorage side channel instead, where the
  // automation executor drains it onto the step-run row (ai-usage-collector.ts).
  //
  // `finishReason`/`usage` are OPTIONAL BY CONSTRUCTION: an IS build that
  // predates the seam change returns only `output`, and some providers do not
  // report usage. Absent stays NULL — never a fabricated 0.
  const data = (await res.json()) as {
    output?: unknown;
    finishReason?: unknown;
    usage?: {
      promptTokens?: unknown;
      completionTokens?: unknown;
      totalTokens?: unknown;
    };
  };
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const finishReason =
    typeof data.finishReason === "string" && data.finishReason
      ? data.finishReason
      : undefined;
  // Record BEFORE the empty-completion throw below: an empty generation is
  // EXACTLY the case whose finish reason we need, so the telemetry must survive
  // the failure path. The executor writes it on the failed step row too.
  recordAiUsage({
    finishReason,
    promptTokens: num(data.usage?.promptTokens),
    completionTokens: num(data.usage?.completionTokens),
    totalTokens: num(data.usage?.totalTokens),
  });
  // AN EMPTY GENERATION IS A FAILURE, NOT AN EMPTY RESULT (run 92fb258a,
  // 2026-08-03). A 200 OK carrying `""` used to be returned as the step output,
  // recorded `completed`, and fed downstream — see describeISEmptyGeneration for
  // the incident. Throwing here makes the step record `failed` with a debuggable
  // message, lets `continueOnError` mark that round failed HONESTLY, hands the
  // assembler an `{error}` object its prompt already renders as a `status="failed"`
  // section, and turns the run's terminal verdict into `failed` (stepsFailed > 0).
  //
  // Deliberately NARROW: only null/undefined and a whitespace-only STRING. A
  // `json:true` call returns a parsed object, and an object with no keys is a
  // shape question for the caller's schema, not "the model said nothing".
  if (
    data.output === null ||
    data.output === undefined ||
    (typeof data.output === "string" && data.output.trim() === "")
  ) {
    throw describeISEmptyGeneration(ctx, {
      outputType: data.output === null ? "null" : typeof data.output,
      maxTokens: args.maxTokens,
      // The one field that EXPLAINS the emptiness — `length` means the budget
      // truncated it, `content-filter` means it was refused, `stop` means the
      // model genuinely emitted nothing. Undefined on a pre-seam IS build.
      finishReason,
      completionTokens: num(data.usage?.completionTokens),
    });
  }
  return data.output;
}
