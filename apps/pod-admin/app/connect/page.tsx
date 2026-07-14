/**
 * /connect — integration key mint surface.
 *
 * Standalone page (no admin chrome) that any signed-in pod user can hit
 * to provision a Hub Protocol API key for an external integration
 * (Synap CLI, Raycast, OpenClaw, Claude Desktop via MCP, etc.).
 *
 * Replaces the legacy admin-ui `/admin/connect` page deleted in the
 * auth refactor. Existing in-the-wild CLI/Raycast installs that still
 * build URLs against `${podUrl}/admin/connect` are redirected here by a
 * Hono handler on the backend.
 *
 * Auth: middleware enforces a valid Kratos session (no pod_admin role
 * required — see middleware.ts). Unauthenticated visitors are bounced
 * to `/login?return=/connect?<original query>` and come back here.
 *
 * Query parameters:
 *   integration       — "raycast" | "cli" | "openclaw" | "custom"
 *   redirect_uri      — deeplink the page will send credentials to on
 *                       success. Must match an entry in
 *                       DEFAULT_CONNECT_REDIRECT_PREFIXES.
 *   issuer_assertion  — one-shot assertion from any Pod-approved issuer,
 *                       exchanged directly with this Pod before the key is
 *                       minted. Falls back to inline sign-in on failure.
 */

import { ConnectForm } from "./ConnectForm";

interface ConnectPageProps {
  searchParams: Promise<{
    integration?: string;
    redirect_uri?: string;
    issuer_assertion?: string;
  }>;
}

export const dynamic = "force-dynamic";

export default async function ConnectPage({ searchParams }: ConnectPageProps) {
  const sp = await searchParams;
  const integration = normalizeIntegration(sp.integration);
  const redirectUri = sp.redirect_uri ?? "";
  const issuerAssertion = sp.issuer_assertion ?? "";

  return (
    <ConnectForm
      integration={integration}
      redirectUri={redirectUri}
      issuerAssertion={issuerAssertion}
    />
  );
}

function normalizeIntegration(
  raw: string | undefined
): "raycast" | "cli" | "openclaw" | "custom" {
  if (raw === "raycast" || raw === "cli" || raw === "openclaw") return raw;
  return "custom";
}
