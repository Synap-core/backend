/**
 * Mail triage — the AI classification step shared by the mail-feed runner and the
 * `ai.triage` builtin verb.
 *
 * Extracted into its own module (no `execute-capability` dependency) so the
 * builtin-verb handler can import it without the cycle
 * `builtin-verbs → run-mail-feed → execute-capability → builtin-verbs`.
 *
 * `mail_triage` is a normal backend→IS AI op: it authenticates with the pod's
 * PER-CONNECTION key resolved from the DB (`getDefaultActiveService`), NEVER from
 * env, and NEVER the CP↔IS internal key.
 */
import { getDefaultActiveService } from "../../utils/intelligence-routing.js";
import {
  isCallBudgetMs,
  describeISFailure,
  describeISHttpError,
  type ISCallContext,
} from "@synap/intelligence-client";

/** One gmail_search hit (metadata + snippet — no body). */
export interface EmailHit {
  id: string;
  subject?: string;
  from?: string;
  date?: string;
  snippet?: string;
}

export interface TriagedEmail {
  id: string;
  relevant: boolean;
  category: string;
  summary: string;
  suggestedAction: string;
}

/**
 * Score a batch of emails for relevance + category + summary via the IS
 * `mail_triage` tool. `mutedCategories` are passed through so the IS can factor
 * them into relevance. Returns [] on a malformed IS response (fail-soft).
 *
 * Shares `generate`'s budget + attribution (is-call-budget.ts): this is the same
 * one-shot-model shape and it carried the same hardcoded 60s ceiling — and it
 * scales with the BATCH size, so it is exposed to the exact failure that took
 * down the 2026-07-31 report run.
 */
export async function triageEmails(
  emails: EmailHit[],
  mutedCategories: string[] = []
): Promise<TriagedEmail[]> {
  const { endpoint: isUrl, apiKey } = await getDefaultActiveService();
  const endpoint = `${isUrl}/v1/tools/mail_triage`;
  const budgetMs = isCallBudgetMs("generation");
  const body = JSON.stringify({
    emails: emails.map((e) => ({
      id: e.id,
      from: e.from ?? "",
      subject: e.subject ?? "",
      snippet: e.snippet ?? "",
    })),
    mutedCategories,
  });
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
  const data = (await res.json()) as { results?: TriagedEmail[] };
  return Array.isArray(data.results) ? data.results : [];
}
