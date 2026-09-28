/**
 * /approve-agents?keys=<id>,<id> — approve several agent keys in ONE step (V1 D5).
 *
 * `synap init` connects every harness it finds (Claude Code, Codex, …), each
 * minting a pending key via `POST /api/hub/setup/agent` with
 * `requireApproval: true`. Instead of one page per key, the CLI opens this page
 * once with every `pendingToken`; the person approves them together. The CLI
 * keeps polling `/setup/agent/pending/:keyId` per key, unchanged.
 *
 * Auth: same as `/approve-agent/[keyId]` — a valid Kratos session, no pod_admin
 * role (`proxy.ts` exempts every `/approve-agent*` path). The backend
 * (`/setup/agent/pending/lookup` + `/approve-batch`) re-verifies the session and
 * applies the per-key decide gate server-side.
 */

import { headers } from "next/headers";
import { ApproveBatchForm } from "./ApproveBatchForm";

interface ApproveAgentsPageProps {
  searchParams: Promise<{ keys?: string }>;
}

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ApproveAgentsPage({
  searchParams,
}: ApproveAgentsPageProps) {
  const sp = await searchParams;
  const keyIds = [
    ...new Set(
      (sp.keys ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter((k) => UUID_RE.test(k))
    ),
  ].slice(0, 20);
  const h = await headers();
  return (
    <ApproveBatchForm
      keyIds={keyIds}
      podHost={h.get("host") ?? undefined}
      identity={h.get("x-pod-admin-email") ?? undefined}
    />
  );
}
