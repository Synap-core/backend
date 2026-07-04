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
 */
export async function generateViaIS(args: GenerateArgs): Promise<unknown> {
  const { endpoint: isUrl, apiKey } = await getDefaultActiveService();
  const res = await fetch(`${isUrl}/v1/tools/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      ...(args.system !== undefined ? { system: args.system } : {}),
      prompt: args.prompt,
      json: args.json ?? false,
      ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`generate IS call failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { output?: unknown };
  return data.output;
}
