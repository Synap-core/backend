/**
 * /approve-agent/[keyId] — agent-key approval surface.
 *
 * Standalone page (no admin chrome) opened by `synap connect <target>` after
 * the CLI provisions an INACTIVE agent key (`POST /api/hub/setup/agent` with
 * `requireApproval: true`). The operator approves/rejects here; the CLI polls
 * `/setup/agent/pending/:keyId` and continues once the key goes active.
 *
 * Replaces the bare REST HTML review page on the API host — approval now lives
 * in pod-admin where the operator is already Kratos-authed. The backend builds
 * this URL via `toPodAdminOrigin()` in `hub-protocol/rest/setup.ts`.
 *
 * Auth: middleware enforces a valid Kratos session (no pod_admin role required
 * — see middleware.ts, same exemption as /connect). Unauthenticated visitors
 * are bounced to `/login?return=/approve-agent/<id>?<query>` and come back.
 *
 * The backend approve/reject endpoints (`resolveKratosSession`) re-verify the
 * session server-side, so the cross-subdomain POST must send credentials.
 *
 * Query parameters:
 *   agentType — surface label shown to the operator (e.g. "raycast"). Display
 *               only; the keyId path param is the capability.
 */

import { ApproveForm } from "./ApproveForm";
import { headers } from "next/headers";

interface ApproveAgentPageProps {
  params: Promise<{ keyId: string }>;
  searchParams: Promise<{ agentType?: string }>;
}

export const dynamic = "force-dynamic";

export default async function ApproveAgentPage({
  params,
  searchParams,
}: ApproveAgentPageProps) {
  const { keyId } = await params;
  const sp = await searchParams;
  const agentType = sp.agentType?.trim() || "agent";

  // Which pod is asking, and who the reader is signed in as. Without these a
  // legitimate request reaching someone from an email is indistinguishable
  // from a phishing page.
  const h = await headers();
  return (
    <ApproveForm
      keyId={keyId}
      agentType={agentType}
      podHost={h.get("host") ?? undefined}
      identity={h.get("x-pod-admin-email") ?? undefined}
    />
  );
}
