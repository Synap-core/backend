/**
 * completeFocusSession — shared service behind both Hub REST and MCP adapter.
 *
 * Closes the running playbook_run for the session and updates the session record
 * (status → closed, reports, summary). Best-effort on the run close — no running
 * run is not an error.
 */
import { db, focusSessions, playbookRuns, eq, and } from "@synap/database";
import type { FocusSession } from "@synap/database";

export interface CompleteFocusSessionParams {
  sessionId: string;
  userId: string;
  /** Short human-readable outcome — surfaced in session lists. */
  summary?: string;
  verificationReport?: Record<string, unknown> | null;
  planReport?: Record<string, unknown> | null;
  contextReport?: Record<string, unknown> | null;
  executionLog?: Record<string, unknown> | null;
}

export async function completeFocusSession(
  params: CompleteFocusSessionParams
): Promise<FocusSession | null> {
  const {
    sessionId,
    summary,
    verificationReport,
    planReport,
    contextReport,
    executionLog,
  } = params;

  // Load the session — scoping is the caller's responsibility (REST resolves
  // acting context; MCP passes the operator userId).
  const session = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, sessionId),
  });
  if (!session) return null;

  // Close any running playbook_run for this session.
  const [run] = await db
    .select()
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, sessionId),
        eq(playbookRuns.status, "running")
      )
    )
    .limit(1);

  if (run) {
    await db
      .update(playbookRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(playbookRuns.id, run.id));
  }

  // Update the session.
  const [updated] = await db
    .update(focusSessions)
    .set({
      status: "closed",
      closedAt: new Date(),
      ...(summary !== undefined
        ? {
            executionLog: {
              summary,
              ...((executionLog as Record<string, unknown>) ?? {}),
            },
          }
        : {}),
      ...(verificationReport !== undefined ? { verificationReport } : {}),
      ...(planReport !== undefined ? { planReport } : {}),
      ...(contextReport !== undefined ? { contextReport } : {}),
    })
    .where(eq(focusSessions.id, sessionId))
    .returning();

  return updated;
}
