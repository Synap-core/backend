/**
 * Does Nango's error answer to `GET /connection/:id` say the connection's
 * credential is dead, so that only the user reconnecting it will help?
 *
 * ONE rule, two copies, byte for byte: this file (the source) and the control
 * plane's `src/lib/nango-dead-credential.ts`. Each repo pins this file's
 * sha256 in a test that runs in its own CI (`NANGO_DEAD_CREDENTIAL_SHA256`):
 * an edit to either copy goes red until the other copy and both pins are
 * updated. The CP reads the connection for a CP-brokered pod and relays the
 * verdict as `reason: "needs_reauth"`; a pod holding its own Nango key reads
 * it here.
 *
 * Nango 0.70.9 answers every failed refresh-or-test of a connection as
 * `{error: {code: "invalid_credentials", message}}` (server
 * `controllers/connection/connectionId/getConnection.ts` L106-118). The code is
 * the same for every cause; the message is the underlying NangoError's (shared
 * `utils/error.ts`), the one field that names the cause:
 *  - `connection_refresh_exhausted` (424, error.ts L377-380). DEAD. Nango's
 *    own verdict: refreshes failed on 4 distinct days
 *    (`connection.service.ts` `setRefreshFailure` L502-526,
 *    `MAX_CONSECUTIVE_DAYS_FAILED_REFRESH = 4`), or it marked the auth failed
 *    (`markConnectionAuthFailed` L491-500).
 *  - `connection_refresh_backoff` (424, error.ts L382-385): a refresh failed
 *    under 30s ago (`credentials/refresh.ts` L98-102). NOT dead: the next read
 *    retries.
 *  - `refresh_token_external_error` (400, error.ts L359-362, "... Please try
 *    again later."). NOT dead on its own: Nango builds it for ANY failure of
 *    the refresh, a provider's refusal and a provider's 5xx, 429 or a network
 *    error alike (`clients/oauth2.client.ts` L145-175: every Boom and every
 *    other error), and for any exception in the refresh itself, a lock
 *    timeout or a database error included (`credentials/refresh.ts` L522-523).
 *    The provider's answer is not in the body (`refreshCredentials` rebuilds
 *    the error with the connection as its only payload, L232-233), so the
 *    body cannot tell a dead token from an outage. A refusal that REPEATS is
 *    counted by Nango, once a day, and becomes the 424 above on the 4th day:
 *    that repeat is the confirmation this rule waits for.
 * A dead verdict needs the code, the cause's message AND the status Nango gives
 * that cause. Anything else is not this verdict: `null`, and the caller keeps
 * the answer it gave before this rule existed (retry later).
 *
 * `credentialCause` says which it is: `dead`, a known cause to `retry`, or an
 * `unknown` cause of `invalid_credentials` (a reworded or new Nango cause:
 * the caller logs it, so it shows instead of silently reading as a retry
 * forever). `null` = the answer is not about the credential at all.
 * `deadCredential` returns Nango's message when the credential is dead, else
 * `null`.
 *
 * Kept free of multi-line calls and signatures: the two repos' prettier
 * configs differ on trailing commas there, and the copies must stay identical.
 */
const CREDENTIAL_CAUSES = [
  {
    status: 424,
    message: "The refresh limit has been reached for this connection.",
    verdict: "dead",
  },
  {
    status: 424,
    message: "A recent refresh attempt failed. Backing off before retrying.",
    verdict: "retry",
  },
  {
    status: 400,
    message:
      "The external API returned an error when trying to refresh the access token.",
    verdict: "dead",
  },
] as const;

export interface CredentialCause {
  verdict: "dead" | "retry" | "unknown";
  message: string;
}

export function credentialCause(status: number, body: unknown) {
  const error = (body as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== "invalid_credentials" || typeof message !== "string") {
    return null;
  }
  for (const c of CREDENTIAL_CAUSES) {
    if (c.status === status && message.startsWith(c.message)) {
      return { verdict: c.verdict, message } satisfies CredentialCause;
    }
  }
  return { verdict: "unknown", message } satisfies CredentialCause;
}

export function deadCredential(status: number, body: unknown): string | null {
  const cause = credentialCause(status, body);
  return cause?.verdict === "dead" ? cause.message : null;
}
