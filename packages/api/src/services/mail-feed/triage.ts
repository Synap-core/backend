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
 */
export async function triageEmails(
  emails: EmailHit[],
  mutedCategories: string[] = []
): Promise<TriagedEmail[]> {
  const { endpoint: isUrl, apiKey } = await getDefaultActiveService();
  const res = await fetch(`${isUrl}/v1/tools/mail_triage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      emails: emails.map((e) => ({
        id: e.id,
        from: e.from ?? "",
        subject: e.subject ?? "",
        snippet: e.snippet ?? "",
      })),
      mutedCategories,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`mail_triage IS call failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { results?: TriagedEmail[] };
  return Array.isArray(data.results) ? data.results : [];
}
