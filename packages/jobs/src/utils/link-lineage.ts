/**
 * THE RUN-TIME LOOP GUARD OF PLAYBOOK LINKS (work model W8a).
 *
 * A link ("when a run of X ends, start Y": a `run_ended` activator) is
 * refused at the playbook write door when its chain comes back to the
 * playbook being written (`api` `playbook-links.ts`). A loop can still form
 * past that door: a rename, an install, a playbook edited outside it. So the
 * one place a link starts a run (`steps/playbook-run.ts`) asks this first:
 * is the playbook about to start already in the chain of link-started runs
 * that led here?
 *
 * The chain is read off what the runs already record, nothing new: a run a
 * rule started carries its automation run on its session
 * (`metadata.automationRunId`, `buildRunSessionMetadata`), and that run
 * keeps the event that fired it (`automation_runs.trigger_payload`). When
 * that event is a session close (a link fired), its `data.sessionId` is the
 * run before. The walk stops at a run no close started (a person's, a
 * schedule's, an entity event's) and after {@link LINK_CHAIN_MAX} runs.
 *
 * NOT seen, by design: a run a person approved from a link's proposal is not
 * stamped with the automation run (the approval replays `playbooks.run`), so
 * the chain restarts there. A loop of PROPOSED links therefore asks a person
 * at every turn; it never runs by itself.
 */
import { automationRuns, db, eq, focusSessions } from "@synap/database";
import { LINK_CHAIN_MAX } from "@synap-core/types/workers";
import { FOCUS_SESSION_CLOSED_EVENT_TYPE } from "../workers/automation-trigger-matcher.js";

export interface LinkLineage {
  /** The playbooks of the chain, newest first (the run that just ended first). */
  playbookIds: string[];
  /** The walk stopped at {@link LINK_CHAIN_MAX}: the chain is that long or longer. */
  capped: boolean;
}

/** The chain of link-started runs ending with `endedSessionId`. */
export async function readLinkLineage(
  endedSessionId: string,
  max: number = LINK_CHAIN_MAX
): Promise<LinkLineage> {
  const playbookIds: string[] = [];
  const seen = new Set<string>();
  let sessionId: string | undefined = endedSessionId;
  while (sessionId && !seen.has(sessionId)) {
    if (seen.size >= max) return { playbookIds, capped: true };
    seen.add(sessionId);
    const [session] = await db
      .select({
        playbookId: focusSessions.playbookId,
        metadata: focusSessions.metadata,
      })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .limit(1);
    if (!session) break;
    if (session.playbookId) playbookIds.push(session.playbookId);
    const meta = session.metadata as {
      automationRunId?: unknown;
      automationChainContext?: { automationRunId?: unknown };
    } | null;
    const runId =
      meta?.automationRunId ?? meta?.automationChainContext?.automationRunId;
    if (typeof runId !== "string" || !runId) break;
    const [run] = await db
      .select({ triggerPayload: automationRuns.triggerPayload })
      .from(automationRuns)
      .where(eq(automationRuns.id, runId))
      .limit(1);
    const payload = run?.triggerPayload as {
      eventType?: unknown;
      data?: { sessionId?: unknown };
    } | null;
    if (payload?.eventType !== FOCUS_SESSION_CLOSED_EVENT_TYPE) break;
    const before = payload.data?.sessionId;
    sessionId = typeof before === "string" ? before : undefined;
  }
  return { playbookIds, capped: false };
}

/**
 * Would starting `playbookId` after the close of `endedSessionId` loop?
 * True when the playbook is already in the chain, or the chain is capped.
 */
export async function linkWouldLoop(input: {
  endedSessionId: string;
  playbookId: string;
}): Promise<boolean> {
  const lineage = await readLinkLineage(input.endedSessionId);
  return lineage.capped || lineage.playbookIds.includes(input.playbookId);
}
