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
 * so the caller (a builtin verb inside an automation) fails loudly, not silently.
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
  const data = (await res.json()) as { output?: unknown };
  return data.output;
}
