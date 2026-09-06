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

import { headers } from "next/headers";
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
/** Normalize an https origin to a SAFE prefix: `https://host/` (trailing slash).
 * Without the slash, `startsWith("https://api.synap.live")` would also match
 * `https://api.synap.live.evil.com` — a prefix-confusion hole. The slash pins it
 * to paths UNDER that exact origin. */
function toOriginPrefix(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") return null;
    return `${u.origin}/`;
  } catch {
    return null;
  }
}

function readAllowedHttpsOrigins(): string[] {
  return (process.env.CONNECT_ALLOWED_HTTPS_ORIGINS ?? "")
    .split(",")
    .map(toOriginPrefix)
    .filter((s): s is string => s !== null);
}

/**
 * The redirect the flow is allowed to deliver to is, by default, the origin of
 * the TRUSTED ISSUER that signed this connect assertion — NOT a hand-set env.
 * The assertion's `iss` is the control-plane issuer; the Pod cryptographically
 * verifies it against its `trusted_issuers` registry at `/api/federation/exchange`
 * before any code/key is minted, so a redirect back to that same issuer's origin
 * is safe by the trust already established. (A forged `iss` passes this origin
 * check but fails the exchange → nothing is minted; a real assertion can only
 * deliver to its own issuer's origin.) This is why the CP-MCP callback needs no
 * per-pod env: the trust is the assertion. We decode `iss` here (no verify — the
 * exchange is the gate) purely to pick which origin to allow.
 */
function trustedIssuerRedirectPrefix(issuerAssertion: string): string | null {
  if (!issuerAssertion) return null;
  try {
    const payload = issuerAssertion.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as { iss?: unknown };
    return typeof claims.iss === "string" ? toOriginPrefix(claims.iss) : null;
  } catch {
    return null;
  }
}

export default async function ConnectPage({ searchParams }: ConnectPageProps) {
  const sp = await searchParams;
  const integration = normalizeIntegration(sp.integration);
  const agentType = sp.agent_type ?? null;
  const redirectUri = sp.redirect_uri ?? "";
  const issuerAssertion = sp.issuer_assertion ?? "";

  // Allowed https redirect prefixes: the trusted issuer that signed THIS
  // assertion (zero-config, the canonical path) PLUS any origins the pod owner
  // pre-allowlisted via env (optional, for flows without an assertion).
  const trustedPrefix = trustedIssuerRedirectPrefix(issuerAssertion);
  const extraRedirectPrefixes = [
    ...(trustedPrefix ? [trustedPrefix] : []),
    ...readAllowedHttpsOrigins(),
  ];

  // Which pod is minting, and who the reader is signed in as. A page that
  // hands an API key to an integration is the most phishing-shaped surface the
  // pod has; the identity row is the only anchor a reader arriving from a CLI
  // banner or a control-plane redirect has that this pod is the one they meant.
  const h = await headers();

  return (
    <ConnectForm
      integration={integration}
      agentType={agentType}
      redirectUri={redirectUri}
      issuerAssertion={issuerAssertion}
      extraRedirectPrefixes={extraRedirectPrefixes}
      podHost={h.get("host") ?? undefined}
      identity={h.get("x-pod-admin-email") ?? undefined}
    />
  );
}

function normalizeIntegration(
  raw: string | undefined
): "raycast" | "cli" | "openclaw" | "custom" {
  if (raw === "raycast" || raw === "cli" || raw === "openclaw") return raw;
  return "custom";
}
