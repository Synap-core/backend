/**
 * completeFocusSession — lifecycle close for a focus session.
 *
 * Callers today: MCP `synap_complete_session`, session-recap. Hub REST PATCH
 * and tRPC `close` still flip status without this service (known dual path —
 * consolidate later). Closes running playbook_run, stamps closed + report.
 *
 * Gate 2: returns a **proposal pack** (pending proposals for this session).
 */
import {
  db,
  focusSessions,
  playbookRuns,
  proposals,
  ProposalStatus,
  eq,
  and,
  desc,
} from "@synap/database";
import type { FocusSession } from "@synap/database";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { expireSessionEphemerals } from "../proposals/expire-lapsed-proposals.js";

export interface CompleteFocusSessionParams {
  sessionId: string;
  userId: string;
  agentUserId?: string;
  /** Short human-readable outcome — surfaced in session lists. */
  summary?: string;
  verificationReport?: Record<string, unknown> | null;
}

export type ProposalPackItem = {
  id: string;
  status: string;
  proposalType: string | null;
  summary: string | null;
  workspaceId: string | null;
  createdAt: Date | null;
};

export type CompleteFocusSessionResult = {
  session: FocusSession;
  /** Pending proposals attributed to this session (review pack). */
  pendingProposals: ProposalPackItem[];
  counts: {
    pending: number;
    /** expectedOutputs still status !== done (warn only — does not block close). */
    unfinishedOutputs: number;
    /**
     * Ephemeral proposals retired because this session closed — bound to it and
     * no longer answerable. Reported so the close is never a silent retirement.
     */
    expiredEphemerals: number;
  };
  warnings: string[];
};

function packItem(row: typeof proposals.$inferSelect): ProposalPackItem {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const summary =
    typeof data.summary === "string"
      ? data.summary
      : typeof data.targetName === "string"
        ? data.targetName
        : null;
  return {
    id: row.id,
    status: row.status,
    proposalType: row.proposalType ?? null,
    summary,
    workspaceId: row.workspaceId ?? null,
    createdAt: row.createdAt ?? null,
  };
}

export async function completeFocusSession(
  params: CompleteFocusSessionParams
): Promise<CompleteFocusSessionResult | null> {
  const { sessionId, summary, verificationReport } = params;

  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, sessionId),
      eq(focusSessions.userId, params.userId)
    ),
  });
  if (!session) return null;

  // Lifecycle close must not be blocked by session forceProposeWrites (pack mode).
  // ignoreSessionForcePropose keeps auto-approve / execute path for complete only.
  // When a proposal is still required, gate data carries goal + summary so the
  // proposal card and focus_session/update executor can complete the session.
  const perm = await checkPermissionOrPropose({
    userId: params.userId,
    agentUserId: params.agentUserId,
    workspaceId: session.workspaceId,
    // Attribute + honor pack-mode escape: stamp would force-propose without
    // ignoreSessionForcePropose; both must be set for lifecycle complete.
    sessionId,
    subjectType: "focus_session",
    action: "update",
    source: "intelligence",
    data: {
      id: sessionId,
      status: "closed",
      goal: session.goal,
      previousStatus: session.status,
      ...(summary !== undefined ? { sessionSummary: summary } : {}),
      ...(verificationReport != null ? { verificationReport } : {}),
    },
    ignoreSessionForcePropose: true,
  });

  if ("denied" in perm && perm.denied) {
    throw Object.assign(new Error(perm.reason), { code: "FORBIDDEN" });
  }
  if ("proposalId" in perm) {
    // Hub REST surfaces proposalId/summary/review*; human approve runs
    // focus_session/update which reuses completeFocusSession (no agentUserId).
    throw Object.assign(
      new Error("Session completion proposed for review — approval required"),
      {
        code: "FORBIDDEN",
        proposalId: perm.proposalId,
        summary: perm.summary,
        reasoning: perm.reasoning,
        reviewPath: perm.reviewPath,
        reviewUrl: perm.reviewUrl,
      }
    );
  }

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

  const unfinishedOutputs = (
    (session.expectedOutputs as Array<{ status?: string }> | null) ?? []
  ).filter((o) => o.status !== "done").length;

  const warnings: string[] = [];
  if (unfinishedOutputs > 0) {
    warnings.push(
      `${unfinishedOutputs} expected output(s) still not marked done — session closed anyway (warn-only).`
    );
  }

  const [updated] = await db
    .update(focusSessions)
    .set({
      status: "closed",
      closedAt: new Date(),
      ...(verificationReport != null
        ? {
            verificationReport: {
              ...(summary !== undefined ? { summary } : {}),
              ...(verificationReport as Record<string, unknown>),
              ...(unfinishedOutputs > 0 ? { unfinishedOutputs } : {}),
            },
          }
        : summary !== undefined
          ? {
              verificationReport: {
                summary,
                ...(unfinishedOutputs > 0 ? { unfinishedOutputs } : {}),
              },
            }
          : verificationReport === null
            ? { verificationReport: null }
            : unfinishedOutputs > 0
              ? { verificationReport: { unfinishedOutputs } }
              : {}),
    })
    .where(eq(focusSessions.id, sessionId))
    .returning();

  // The session is closed, so its EPHEMERAL proposals are no longer answerable.
  // A capability run is an outbound call bound to this session — urgent for
  // minutes, worthless after. OpenID CIBA's rule is the one to follow here: a
  // server should "terminate the authentication when it knows the client is no
  // longer interested in the result". Session close IS that signal; the 6h cron
  // is only the backstop for sessions that die without a clean close.
  //
  // Runs BEFORE the pack query below so the pack reports what is really still
  // owed, not rows this call is about to retire. Best-effort and never throws —
  // a session must close even if the sweep fails. Only classes WITH a lifetime
  // are touched: a proposed entity or a merge candidate created during a session
  // outlives it by design.
  const expiredEphemerals = await expireSessionEphemerals(sessionId);

  // Proposal pack — pending rows attributed to this session.
  const pendingRows = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.sessionId, sessionId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(100);

  const pendingProposals = pendingRows.map(packItem);

  // Say it out loud. Expiry is honest only if the person closing the session
  // learns it happened — a silent retirement is the lying-count defect the C2
  // TTL removal was about, wearing a different hat.
  if (expiredEphemerals > 0) {
    warnings.push(
      `${expiredEphemerals} unanswered capability run(s) expired with this session — ` +
        `they were bound to it and are no longer actionable.`
    );
  }

  return {
    session: updated,
    pendingProposals,
    counts: {
      pending: pendingProposals.length,
      unfinishedOutputs,
      expiredEphemerals,
    },
    warnings,
  };
}
