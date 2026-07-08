/**
 * Resolve the ACTOR a capture-flow write should be attributed to.
 *
 * The seeded, least-privilege Capture agent (see `ensure-capture-agent.ts`)
 * auto-approves ONLY the capture verbs. Attributing a capture-flow write to it
 * makes `checkPermissionOrPropose` resolve to "execute" (auto-apply, no
 * proposal) AND stamps clean provenance ("captured by Capture").
 *
 * This is a DE-ESCALATION seam: the Capture agent is strictly less privileged
 * than a normal caller, so swapping the actor to it can only narrow what
 * auto-approves — never widen it. It is applied either:
 *   - ALWAYS, on the capture pipeline endpoints (`/capture/*`), which ARE the
 *     capture flow; or
 *   - HEADER-GATED (`X-Capture: 1`), on shared write routes (enrich, link,
 *     file, attachment, focus-session) that the capture bridge also drives —
 *     a non-capture caller (no header) is unaffected and keeps its normal
 *     governance.
 *
 * GRACEFUL FALLBACK: if the Capture agent is not seeded yet (a pre-bootstrap
 * pod, or `ensureCaptureAgent` has not run), fall back to the caller's own
 * `ctxAgentUserId` so the write proceeds under its normal governance instead of
 * crashing.
 */

import type { Context } from "hono";

import { createLogger } from "@synap-core/core";

import { getCaptureAgentUserId } from "./ensure-capture-agent.js";
import { enrollAgentInWorkspace } from "../enroll-agent-in-workspace.js";

const logger = createLogger({ module: "resolve-capture-actor" });

export async function resolveCaptureActorUserId(
  c: Context,
  ctxAgentUserId: string | undefined,
  opts?: { always?: boolean; workspaceId?: string | null }
): Promise<string | undefined> {
  const shouldCapture =
    opts?.always === true || c.req.header("x-capture") === "1";
  if (!shouldCapture) return ctxAgentUserId;

  // Graceful fallback: an unseeded Capture agent — or a transient DB error —
  // must not break the write; fall back to the caller's normal governance.
  let captureAgentId: string | null = null;
  try {
    captureAgentId = await getCaptureAgentUserId();
  } catch (err) {
    logger.warn(
      { err },
      "getCaptureAgentUserId failed — using caller identity"
    );
    return ctxAgentUserId;
  }
  if (!captureAgentId) return ctxAgentUserId;

  // Membership gate: checkPermissionOrPropose requires workspace membership
  // BEFORE the auto-approve ladder — so a pod-wide Capture agent that isn't a
  // member of the target workspace would file a `workspace.join` proposal
  // instead of auto-applying (breaking event-mode sessions + workspace-scoped
  // enrichment). Enroll it idempotently (editor) so its bounded capture writes
  // reach the ladder. Its 7-verb `autoApproveFor` — NOT the editor role —
  // stays the real capability boundary. Non-fatal.
  if (opts?.workspaceId) {
    try {
      await enrollAgentInWorkspace({
        workspaceId: opts.workspaceId,
        agentUserId: captureAgentId,
        role: "editor",
      });
    } catch (err) {
      logger.warn(
        { err, workspaceId: opts.workspaceId },
        "capture-agent workspace enroll failed (non-fatal)"
      );
    }
  }

  return captureAgentId;
}
