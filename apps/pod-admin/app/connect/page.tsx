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
 *   agent_type        — optional agent signal. When "claude-web" (with
 *                       integration=custom), the page takes the CP-MCP
 *                       consent-code path instead of minting a plaintext key:
 *                       it records consent as a one-time code and top-level
 *                       navigates to the CP callback with `?code=<code>`.
 *   redirect_uri      — deeplink the page will send credentials to on
 *                       success. Must match an entry in
 *                       DEFAULT_CONNECT_REDIRECT_PREFIXES — PLUS, for the
 *                       claude-web https callback, an https origin the pod
 *                       owner allowlisted via CONNECT_ALLOWED_HTTPS_ORIGINS.
 *   issuer_assertion  — one-shot assertion from any Pod-approved issuer,
 *                       exchanged directly with this Pod before the key is
 *                       minted. Falls back to inline sign-in on failure.
 */

import { ConnectForm } from "./ConnectForm";

interface ConnectPageProps {
  searchParams: Promise<{
    integration?: string;
    agent_type?: string;
    redirect_uri?: string;
    issuer_assertion?: string;
  }>;
}

export const dynamic = "force-dynamic";

/**
 * Extra https redirect prefixes the pod OWNER trusts — a comma-separated list of
 * https origins in `CONNECT_ALLOWED_HTTPS_ORIGINS` (e.g. the control-plane origin
 * that hosts the CP-MCP callback). Read server-side and passed down so the client
 * form never has to hardcode a CP domain. We do NOT edit the shared/forked
 * DEFAULT_CONNECT_REDIRECT_PREFIXES (a published, cross-repo package) — this is a
 * pod-owner-controlled env, no package bump.
 */
function readAllowedHttpsOrigins(): string[] {
  return (process.env.CONNECT_ALLOWED_HTTPS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("https://"));
}

export default async function ConnectPage({ searchParams }: ConnectPageProps) {
  const sp = await searchParams;
  const integration = normalizeIntegration(sp.integration);
  const agentType = sp.agent_type ?? null;
  const redirectUri = sp.redirect_uri ?? "";
  const issuerAssertion = sp.issuer_assertion ?? "";

  return (
    <ConnectForm
      integration={integration}
      agentType={agentType}
      redirectUri={redirectUri}
      issuerAssertion={issuerAssertion}
      extraRedirectPrefixes={readAllowedHttpsOrigins()}
    />
  );
}

function normalizeIntegration(
  raw: string | undefined
): "raycast" | "cli" | "openclaw" | "custom" {
  if (raw === "raycast" || raw === "cli" || raw === "openclaw") return raw;
  return "custom";
}
