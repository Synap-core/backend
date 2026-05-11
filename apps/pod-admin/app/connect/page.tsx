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
 *   cp_handshake_token — (managed pods) one-shot CP→pod handshake token
 *                       used to bootstrap a Kratos session before the
 *                       key is minted. Falls back to inline sign-in on
 *                       failure.
 */

import { ConnectForm } from "./ConnectForm";

interface ConnectPageProps {
  searchParams: Promise<{
    integration?: string;
    redirect_uri?: string;
    cp_handshake_token?: string;
  }>;
}

export const dynamic = "force-dynamic";

export default async function ConnectPage({ searchParams }: ConnectPageProps) {
  const sp = await searchParams;
  const integration = normalizeIntegration(sp.integration);
  const redirectUri = sp.redirect_uri ?? "";
  const cpHandshakeToken = sp.cp_handshake_token ?? "";

  return (
    <ConnectForm
      integration={integration}
      redirectUri={redirectUri}
      cpHandshakeToken={cpHandshakeToken}
    />
  );
}

function normalizeIntegration(
  raw: string | undefined
): "raycast" | "cli" | "openclaw" | "custom" {
  if (raw === "raycast" || raw === "cli" || raw === "openclaw") return raw;
  return "custom";
}
