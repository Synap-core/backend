/**
 * /oauth/consent — the pod's OWN OAuth authorization consent screen (Path B).
 *
 * Reached by a 302 from the pod API's `GET /authorize` (packages/api/src/
 * routers/oauth/routes.ts). The pod is its own authorization server here — no
 * control plane in the trust path — so unlike synap-landing's consent screen
 * (which fronts the CP's AS) this one lives on the pod's own operator console.
 *
 * Auth: proxy.ts enforces a valid Kratos session. `/oauth/consent` is in the
 * `isSelfService` list — authorizing an MCP client for YOUR OWN data is a
 * self-service act, exactly like `/connect` and `/approve-agent`, and requiring
 * the pod_admin role would lock out every non-admin pod member. Unauthenticated
 * visitors bounce to `/login?return=/oauth/consent?<query>` and come back with
 * the authorize parameters intact.
 *
 * The query string is NOT trusted. It is a convenience carrier: the form below
 * calls `trpc.apiKeys.getOAuthConsentContext`, which re-resolves the client from
 * the database and returns its REAL name, redirect host and grantable scopes —
 * so a rewritten URL can only ever render (and then mint) an authorization the
 * pod would have granted from a fresh /authorize anyway.
 */

import { ConsentForm } from "./ConsentForm";

interface OAuthConsentPageProps {
  searchParams: Promise<{
    client_id?: string;
    redirect_uri?: string;
    response_type?: string;
    scope?: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
  }>;
}

export const dynamic = "force-dynamic";

export default async function OAuthConsentPage({
  searchParams,
}: OAuthConsentPageProps) {
  const sp = await searchParams;

  return (
    <ConsentForm
      params={{
        clientId: sp.client_id ?? "",
        redirectUri: sp.redirect_uri ?? "",
        responseType: sp.response_type,
        scope: sp.scope,
        state: sp.state,
        codeChallenge: sp.code_challenge,
        codeChallengeMethod: sp.code_challenge_method,
      }}
    />
  );
}
