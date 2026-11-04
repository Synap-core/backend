/**
 * The CLOSE → CLOSING REPORT reactor. On `focus_session.closed.completed`, the
 * session document gains (or refreshes) its closing-report sections
 * (`closing-report.ts`).
 *
 * A reactor, not a line in `complete-session.ts`, for the reason
 * `session-unblock-reactor.ts` gives: the close door already emits the event,
 * and a reaction registered off it cannot be forgotten by the next close door.
 *
 * A FAILURE IS NEVER A SILENT SUCCESS. `emitSideEffects` isolates a throwing
 * reactor with a warning nobody reads, so this one records the outcome where a
 * reader will see it: `focus_sessions.metadata.closingReport` —
 * `{ status: "written", documentId, at }` or `{ status: "failed", reason, at }`
 * — and logs the failure at error level. A skipped session (a receipt, an
 * automation run, nothing to report) is not stamped: nothing was attempted.
 *
 * THE POD WRITES IT, NOT THE CLOSER. Reactors run inline, inside the request
 * that closed the session, so the closing AGENT's request scope is still open
 * here (`runWithActingAgent`). The write gate reads that ambient agent first
 * (`getActingAgentUserId() ?? supplied`, `utils/permission-check.ts`), so a
 * report written in that scope was governed AS the closing agent: each section
 * became a proposal against its pending cap, and the report failed
 * "(proposed)" (finding 39fee1e4, 3 Nov). The report is a deterministic
 * projection of stored facts on the owner's behalf, so it runs OUTSIDE the
 * request (`runOutsideRequestContext`): no acting agent, no calling key's
 * grant. An agent calling the section door itself is still in its own scope
 * and still governed.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  eq,
  drizzleSql,
  focusSessions,
  runOutsideRequestContext,
} from "@synap/database";
import { registerReactor, type Reactor } from "@synap/events";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_CLOSE_ACTION,
} from "../focus-sessions/close-event.js";
import { writeClosingReport } from "./closing-report.js";

const logger = createLogger({ module: "closing-report-reactor" });

async function stampOutcome(
  sessionId: string,
  outcome: Record<string, unknown>
): Promise<void> {
  const patch = JSON.stringify({
    closingReport: { ...outcome, at: new Date().toISOString() },
  });
  await db
    .update(focusSessions)
    .set({
      metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${patch}::jsonb`,
    })
    .where(eq(focusSessions.id, sessionId));
}

export const closingReportReactor: Reactor = {
  id: "session-closing-report",
  match: (payload) =>
    payload.subjectType === FOCUS_SESSION_SUBJECT_TYPE &&
    payload.action === FOCUS_SESSION_CLOSE_ACTION,
  async handler(payload) {
    const sessionId =
      (payload.data?.sessionId as string | undefined) ?? payload.subjectId;
    if (!sessionId) return;
    try {
      const result = await runOutsideRequestContext(() =>
        writeClosingReport(sessionId)
      );
      if (result.status === "skipped") return;
      await stampOutcome(sessionId, {
        status: "written",
        documentId: result.documentId,
        ...(result.keptHuman.length ? { keptHuman: result.keptHuman } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error(
        { error, sessionId },
        "closing-report: the session closed but its report could not be written"
      );
      await stampOutcome(sessionId, { status: "failed", reason }).catch(
        (stampError) =>
          logger.error(
            { error: stampError, sessionId },
            "closing-report: could not record the failure on the session"
          )
      );
    }
  },
};

let registered = false;

/** Register the reactor. Called once at API boot (`apps/api/src/index.ts`). */
export function registerClosingReportReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(closingReportReactor);
  logger.info("Registered session closing-report reactor");
}
