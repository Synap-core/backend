/**
 * The spine record of a direct session edit — `focus_session.update.completed`.
 *
 * WHY. "Untouched by a person since" (`isOwnFreshWork`, @synap/database, the
 * FB1020 B3 proof that lets an agent tidy its own fresh session directly)
 * reads the `focus_session.%.completed` events on the session that carry no
 * agent. The person's own door (tRPC `focusSessions.update`, the app's board,
 * rename and filing) wrote the row and nothing else, so a person re-filing or
 * un-filing the agent's session was invisible and the agent could re-file it
 * on its own (w2 review M8). The edit is now recorded where it happens.
 *
 * Attribution is the caller's: an agent key's edit carries its agent (never
 * read as a person's). Log only — no automation fan-out, so a board edit
 * triggers nothing it did not trigger before. Best-effort, like every
 * `auditLog` append: a failed append is logged, never fails the edit.
 */
import { auditLog } from "../../utils/audit-log.js";

export async function recordSessionEdited(input: {
  sessionId: string;
  userId: string;
  agentUserId: string | null;
  workspaceId: string | null;
  /** The patch keys that carried a value (what was edited, not the values). */
  fields: string[];
}): Promise<void> {
  await auditLog({
    subjectType: "focus_session",
    action: "update",
    phase: "completed",
    subjectId: input.sessionId,
    userId: input.userId,
    agentUserId: input.agentUserId,
    workspaceId: input.workspaceId,
    data: { fields: input.fields },
  });
}
