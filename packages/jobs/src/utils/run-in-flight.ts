/**
 * Is a run of this playbook already IN FLIGHT on this subject?
 *
 * The question a propose-mode `playbook_run` node asks before it files a run
 * proposal (`steps/playbook-run.ts`). A run-mode node already answers it inside
 * the run spine (`runPlaybook`'s `idempotentBySubject` reuse); a propose-mode
 * node never reached that spine, so an activator re-fired on a subject that a
 * run was still working on filed a SECOND run for it. Live, 9 Nov 2026: a
 * Produce Content run moved post Video 01 back to "Briefed", its "enters
 * Briefed" activator fired again and filed proposal 100d7d65 while run
 * 12dbd086 was open on the same post.
 *
 * In flight = the same set the run spine reuses: every status except the
 * terminal ones and `scheduled` (an appointment has run nothing).
 * `IDEMPOTENCY_NON_REUSABLE_SESSION_STATUSES` (@synap/api `run-playbook.ts`)
 * is the other spelling; `run-in-flight.parity.test.ts` there pins the two.
 */
import { db, and, desc, eq, notInArray, focusSessions } from "@synap/database";
import { TERMINAL_SESSION_STATUSES } from "@synap-core/types/focus-sessions";

/** The session statuses that are NOT a run in flight. */
export const RUN_NOT_IN_FLIGHT_SESSION_STATUSES = [
  ...TERMINAL_SESSION_STATUSES,
  "scheduled",
] as const;

/** The newest in-flight session of (playbook, subject), or null. */
export async function findInFlightRunSession(input: {
  playbookId: string;
  subjectId: string;
}): Promise<{ id: string; status: string; title: string | null } | null> {
  const row = await db.query.focusSessions.findFirst({
    columns: { id: true, status: true, title: true },
    where: and(
      eq(focusSessions.playbookId, input.playbookId),
      eq(focusSessions.subjectEntityId, input.subjectId),
      notInArray(focusSessions.status, [...RUN_NOT_IN_FLIGHT_SESSION_STATUSES])
    ),
    orderBy: [desc(focusSessions.startedAt)],
  });
  return row ?? null;
}
