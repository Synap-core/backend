import { and, desc, eq } from "drizzle-orm";
import { db } from "../client-pg.js";
import { focusSessions } from "../schema/focus-sessions.js";

export interface OpenRunSessionInput {
  /** Owner of the run (the operator on whose behalf the automation/agent acts). */
  userId: string;
  /** Human-readable purpose of the run — becomes the session's goal (required). */
  goal: string;
  workspaceId?: string | null;
  /** Bind the session to a channel so its feed mirrors to Discord/etc. When set,
   *  an existing active session on the channel is REUSED (see below). */
  channelId?: string | null;
  projectId?: string | null;
  subjectEntityId?: string | null;
  /** The agent authoring the run — recorded on the session's agent roster. */
  agentUserId?: string | null;
  /** What opened this session — e.g. "automation", "digest". Stored on metadata. */
  source: string;
  /** Automation linkage — every run's automation data lives ON the session. */
  automationId?: string | null;
  automationRunId?: string | null;
  expectedOutputs?: unknown[];
  /** Extra run context to fold into session.metadata (trigger kind, etc.). */
  extraMetadata?: Record<string, unknown>;
}

export interface OpenRunSessionResult {
  sessionId: string;
  /** True when an existing active channel session was reused, not created. */
  reused: boolean;
}

/**
 * Open (or reuse) a focus session for an autonomous / automation run.
 *
 * This is the ONE door that makes "everything an agent does is a session" true
 * for runs that aren't playbooks: the run opens a session, threads its
 * `sessionId` onto every proposal it creates, and the review board groups those
 * proposals under one reviewable card. The session also carries the automation's
 * data (automationId / automationRunId / trigger) so the run is fully auditable
 * from the session alone.
 *
 * Channel-bound sessions are constrained to ONE active per channel by the partial
 * unique index `idx_focus_sessions_active_channel` (WHERE status='active'), so
 * when `channelId` is given we REUSE the channel's active session rather than
 * race the constraint — matching how `triggerAutoRespond` resolves a channel's
 * active session. Channel-less runs always get a fresh session.
 *
 * Lives in `@synap/database` (not `@synap/api`) so the jobs layer — which cannot
 * import `@synap/api` — can open run sessions without a forked inline insert.
 */
export async function openRunSession(
  input: OpenRunSessionInput
): Promise<OpenRunSessionResult> {
  // Reuse ONLY a run-origin session (one WE opened — it carries metadata.source).
  // Never hijack a human's interactive session that happens to be active on the
  // channel: that would file automation proposals into a person's session card.
  // A human session on the channel → returns null → we fall back to channel-less.
  const findReusableRunSession = async (): Promise<string | null> => {
    if (!input.channelId) return null;
    const existing = await db.query.focusSessions.findFirst({
      where: and(
        eq(focusSessions.channelId, input.channelId),
        eq(focusSessions.status, "active")
      ),
      columns: { id: true, metadata: true },
      orderBy: [desc(focusSessions.startedAt)],
    });
    const isRunSession =
      !!existing &&
      typeof (existing.metadata as Record<string, unknown> | null)?.source ===
        "string";
    return isRunSession ? existing!.id : null;
  };

  const reusedId = await findReusableRunSession();
  if (reusedId) return { sessionId: reusedId, reused: true };

  const metadata: Record<string, unknown> = {
    source: input.source,
    ...(input.automationId ? { automationId: input.automationId } : {}),
    ...(input.automationRunId
      ? { automationRunId: input.automationRunId }
      : {}),
    ...(input.extraMetadata ?? {}),
  };

  const insert = (channelId: string | null) =>
    db
      .insert(focusSessions)
      .values({
        userId: input.userId,
        goal: input.goal,
        status: "active",
        workspaceId: input.workspaceId ?? null,
        channelId,
        projectId: input.projectId ?? null,
        subjectEntityId: input.subjectEntityId ?? null,
        // The template that spawned this session — the automation itself.
        templateId: input.automationId ?? null,
        agentIds: input.agentUserId ? [input.agentUserId] : [],
        expectedOutputs: (input.expectedOutputs ?? []) as never[],
        metadata,
      })
      .returning({ id: focusSessions.id });

  try {
    const [session] = await insert(input.channelId ?? null);
    return { sessionId: session.id, reused: false };
  } catch (err) {
    // Partial unique index `idx_focus_sessions_active_channel` rejects a second
    // active channel-bound session. This means a concurrent run raced us (or a
    // human session appeared) between the reuse-check and the insert. Re-check
    // for a run session to reuse; failing that, open channel-LESS so the run
    // still groups its proposals rather than crashing.
    const isUniqueViolation =
      !!input.channelId && (err as { code?: string })?.code === "23505";
    if (!isUniqueViolation) throw err;

    const racedId = await findReusableRunSession();
    if (racedId) return { sessionId: racedId, reused: true };
    const [session] = await insert(null);
    return { sessionId: session.id, reused: false };
  }
}
