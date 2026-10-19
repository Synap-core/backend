/**
 * Does Nango's error answer to `GET /connection/:id` say the connection's
 * credential is dead, so that only the user reconnecting it will help?
 *
 * ONE rule, two copies, byte for byte: this file (the source) and the control
 * plane's `src/lib/nango-dead-credential.ts`, pinned by a tripwire there. The
 * CP reads the connection for a CP-brokered pod and relays the verdict as
 * `reason: "needs_reauth"`; a pod holding its own Nango key reads it here.
 *
 * Nango 0.70.9 answers every failed refresh-or-test of a connection as
 * `{error: {code: "invalid_credentials", message}}` (server
 * `controllers/connection/connectionId/getConnection.ts` L106-118). The code is
 * the same for every cause; the message is the underlying NangoError's (shared
 * `utils/error.ts`), the one field that names the cause:
 *  - `connection_refresh_exhausted` (424, L377-380): refreshes failed four days
 *    running, or Nango marked the auth failed. Dead.
 *  - `refresh_token_external_error` (400, L359-362): the provider refused the
 *    refresh. Dead.
 *  - `connection_refresh_backoff` (424, L382-385): a refresh failed under 30s
 *    ago (shared `services/connections/credentials/refresh.ts` L92-102). NOT
 *    dead: the next read retries, and lands on one of the two above if it is.
 * A dead verdict needs the code, the cause's message AND the status Nango gives
 * that cause. Any other code, message, status or body is not this verdict:
 * `null`, and the caller keeps the answer it gave before this rule existed.
 *
 * Returns Nango's message when the credential is dead, else `null`.
 */
const DEAD_CREDENTIAL_CAUSES = [
  {
    status: 424,
    message: "The refresh limit has been reached for this connection.",
  },
  {
    status: 400,
    message:
      "The external API returned an error when trying to refresh the access token.",
  },
];

export function deadCredential(status: number, body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== "invalid_credentials" || typeof message !== "string") {
    return null;
  }
  const cause = DEAD_CREDENTIAL_CAUSES.find((c) => c.status === status);
  return cause && message.startsWith(cause.message) ? message : null;
}
