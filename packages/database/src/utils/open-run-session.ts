import { and, desc, eq, sql as drizzleSql } from "drizzle-orm";
import { db } from "../client-pg.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { recordSessionSpawn } from "./session-spawn.js";

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
  /**
   * The session this run was PUSHED FROM — recorded as
   * `session --spawned_from--> session`, never a column. Owner-floored against
   * `userId` by the producer; an unowned parent silently drops the edge.
   * Governance metadata is NEVER inherited from the parent.
   * Only applied when a session is actually CREATED (a reused channel session
   * already has its own lineage and must not be re-parented).
   */
  parentSessionId?: string | null;
  /** One line recorded on the PARENT's `metadata.suspended` at push time. */
  suspendedIntent?: string | null;
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

  // Typed origin (`focus_sessions.origin`, migration 0240) derived from the
  // caller's OWN typed inputs — never from the metadata bag. A run is automation
  // origin exactly when the caller named the automation lane (`source` /
  // automation ids); every other run source ("enrichment", "import", "digest")
  // is an agent-driven run. This is the ONLY writer that produces
  // automation-origin rows.
  const origin: "automation" | "agent" =
    input.source === "automation" ||
    !!input.automationId ||
    !!input.automationRunId
      ? "automation"
      : "agent";

  const reusedId = await findReusableRunSession();
  if (reusedId) {
    // Stamp the CURRENT occupant onto the reused session: the run reaper closes
    // orphaned sessions by metadata.automationRunId, so a reused session must
    // always name the run using it NOW — otherwise reaping the original (dead)
    // run would close a room a healthy successor run is mid-flight in.
    if (input.automationRunId) {
      await db
        .update(focusSessions)
        .set({
          metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(
            { automationRunId: input.automationRunId }
          )}::jsonb`,
          // Re-stamp origin with the CURRENT occupant for the same reason the
          // metadata is re-stamped: merging an automationRunId onto a session
          // opened by a non-automation run (e.g. "enrichment") makes the legacy
          // metadata sniff read "automation", so leaving the column at its
          // opening value would split the two readings of this one row.
          origin,
        })
        .where(eq(focusSessions.id, reusedId));
    }
    return { sessionId: reusedId, reused: true };
  }

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
        origin,
        agentIds: input.agentUserId ? [input.agentUserId] : [],
        expectedOutputs: (input.expectedOutputs ?? []) as never[],
        metadata,
      })
      .returning({ id: focusSessions.id });

  // Best-effort by CONTRACT: this runs AFTER the session row is committed and
  // inside the jobs layer, where a throw fails the whole run. A bad parent
  // handle drops the edge; it never costs the caller their session.
  const linkSpawn = async (sessionId: string): Promise<void> => {
    if (!input.parentSessionId) return;
    try {
      await recordSessionSpawn({
        childSessionId: sessionId,
        parentSessionId: input.parentSessionId,
        userId: input.userId,
        workspaceId: input.workspaceId ?? null,
        suspendedIntent: input.suspendedIntent ?? null,
      });
    } catch (err) {
      console.warn(
        "[open-run-session] recordSessionSpawn failed — session kept, spawned_from edge dropped",
        { sessionId, parentSessionId: input.parentSessionId, err }
      );
    }
  };

  try {
    const [session] = await insert(input.channelId ?? null);
    await linkSpawn(session.id);
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
    await linkSpawn(session.id);
    return { sessionId: session.id, reused: false };
  }
}

/**
 * `closeRunSession` USED TO LIVE HERE and was removed, deliberately.
 *
 * It stamped `status:'closed'` with a raw UPDATE — the dual-path defect named
 * in `@synap-core/types/focus-sessions`: every TERMINAL status MUST go through
 * `completeFocusSession` (review pack + running-run close + session-bound
 * ephemeral expiry + BOTH halves of the close event), and this skipped all four.
 *
 * The door cannot move down here (api → database, so @synap/database can never
 * import it), so the close moved UP to its two callers instead — see
 * `closeRunSessionViaDoor` in `packages/api/src/routers/capabilities.ts`, which
 * calls the one door and absorbs its throws because both call sites close from
 * a `finally`. Do not re-add a raw close helper at this layer.
 */
