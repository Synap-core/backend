/**
 * CLAIM ONE DECLARED DELIVERABLE — the narrow service behind Hub
 * `POST /focus-sessions/:id/outputs/complete`.
 *
 * An in-pod playbook run reaches the pod only through Hub REST, and the Hub
 * PATCH refuses `completeOutput` (it takes no row lock). This is the claim and
 * nothing else: it calls `updateFocusSession` with `completeOutput` ONLY, so
 * the row lock, the human-slot floor, the evidence verdict and governance
 * (`checkPermissionOrPropose`) stay that service's, never a second copy. A
 * door built on it can say four things (the session, the operator, the acting
 * agent, the deliverable) and cannot retitle, re-stage or close the session:
 * that is `synap_update_session`'s job.
 */
import {
  updateFocusSession,
  type UpdateFocusSessionResult,
} from "./update-session.js";

export interface ClaimSessionOutputParams {
  sessionId: string;
  /** Operator userId — the scoping floor. */
  userId: string;
  /** The verified acting agent (auth context), never a body field. */
  agentUserId?: string;
  /** The deliverable's key or exact label. */
  output: string;
}

export function claimSessionOutput(
  p: ClaimSessionOutputParams
): Promise<UpdateFocusSessionResult> {
  return updateFocusSession({
    sessionId: p.sessionId,
    userId: p.userId,
    agentUserId: p.agentUserId,
    completeOutput: p.output,
  });
}
