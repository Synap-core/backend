/**
 * One structured log line per refusal of an OAuth request (review A6).
 *
 * A pod app shows the person one sentence (doc 18 §3.3), so when someone
 * reports "this app says it is misconfigured", the pod log is the only place
 * the detail lives: which client, at which step, why. Every field is public
 * request data or a reason the pod wrote. The caller passes the client_id and
 * the error, never the request: an authorization code, a refresh or access
 * token and a PKCE verifier can therefore never reach this line.
 */

import { createLogger } from "@synap-core/core";

/** See the `: any` rationale in hub-protocol/rest/_shared.ts (TS2742). */
const logger: any = createLogger({ module: "pod-oauth" });

/** Where the request was refused. */
export type OAuthRefusalPhase = "authorize" | "consent" | "token" | "refresh";

/** A client_id is caller-chosen: bounded (a CIMD URL is ≤ 512, `client-id-url.ts`). */
const MAX_CLIENT_ID = 512;
const MAX_DETAIL = 300;

export function logOAuthRefusal(fields: {
  phase: OAuthRefusalPhase;
  clientId: string | null | undefined;
  /** A refusal code (`AuthorizeRefusal`) or the OAuth error code. */
  reason: string;
  /** The OAuth error code, when the answer carries one (RFC 6749 §5.2). */
  code?: string;
  /** The pod's own message: what the person or the client was told. */
  detail?: string;
}): void {
  logger.warn(
    {
      phase: fields.phase,
      clientId: fields.clientId?.slice(0, MAX_CLIENT_ID) ?? null,
      reason: fields.reason,
      code: fields.code ?? null,
      detail: fields.detail?.slice(0, MAX_DETAIL) ?? null,
    },
    "pod-oauth: request refused"
  );
}
