/**
 * /connect — integration key mint surface.
 *
 * Standalone page (no admin chrome) that any signed-in pod user can hit
 * to provision a Hub Protocol API key for an external integration
 * (Synap CLI, Raycast, Claude Desktop via MCP, any agent, etc.).
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
 *   integration       — "raycast" | "cli" | "custom" (anything else, including
 *                       the legacy "openclaw" older CLIs still send, is custom)
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
 *   issuer_assertion  — one-shot assertion from a Pod-approved issuer. Read
 *                       ONLY to allowlist the redirect origin (see
 *                       approvedIssuerRedirectPrefix, lib/connect-redirect.ts); never exchanged — the
 *                       pod Kratos session gating this page is the sign-in.
 */

import { headers } from "next/headers";
import { ConnectForm } from "./ConnectForm";
import {
  approvedIssuerRedirectPrefix,
  toOriginPrefix,
} from "../../lib/connect-redirect";

const INTERNAL_POD_URL = process.env.POD_URL ?? "http://localhost:4000";

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
    .map(toOriginPrefix)
    .filter((s): s is string => s !== null);
}

/**
 * The pod's APPROVED Synap Cloud issuer, from its own public discovery. A
 * failed read yields null: the assertion then widens nothing (fail closed) and
 * only the owner's CONNECT_ALLOWED_HTTPS_ORIGINS apply.
 */
async function readApprovedIssuerUrl(): Promise<string | null> {
  try {
    const res = await fetch(`${INTERNAL_POD_URL}/api/federation/discovery`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      cloudSignIn?: { available?: boolean; issuerUrl?: string | null };
    };
    return body.cloudSignIn?.available
      ? (body.cloudSignIn.issuerUrl ?? null)
      : null;
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

  // Allowed https redirect prefixes: the assertion's issuer ONLY when it is the
  // pod's approved Synap Cloud issuer (lib/connect-redirect.ts) PLUS any origins
  // the pod owner pre-allowlisted via env.
  const trustedPrefix = approvedIssuerRedirectPrefix(
    issuerAssertion,
    await readApprovedIssuerUrl()
  );
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
      extraRedirectPrefixes={extraRedirectPrefixes}
      podHost={h.get("host") ?? undefined}
      identity={h.get("x-pod-admin-email") ?? undefined}
    />
  );
}

function normalizeIntegration(
  raw: string | undefined
): "raycast" | "cli" | "custom" {
  if (raw === "raycast" || raw === "cli") return raw;
  return "custom";
}
