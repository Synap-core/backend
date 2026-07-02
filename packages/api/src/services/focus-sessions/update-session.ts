/**
 * updateFocusSession — shared service behind the MCP `synap_update_session` tool.
 *
 * Mirrors createFocusSession / completeFocusSession: owns the load, governance
 * gate, the read-modify-write of the JSONB `expectedOutputs` array (row-locked
 * transaction to avoid TOCTOU), and the `stage_changed` side-effect. Extracted
 * verbatim from the MCP adapter so the tool handler just delegates + shapes the
 * response.
 *
 * NOTE: this is the MCP door's field set (goal/status(active|paused)/progress/
 * currentStage + addOutput/completeOutput/expectedOutputs). The Hub REST PATCH
 * /focus-sessions/:id supports a wider set (channelId, correlationId, agentIds,
 * verificationReport, metadata, status=closed, realtime event) WITHOUT the
 * output RMW lock — they are intentionally distinct doors, not unified here.
 */

import { db, focusSessions, eq, and } from "@synap/database";

export interface UpdateFocusSessionParams {
  sessionId: string;
  /** Operator userId — the scoping floor (stops touching another user's session). */
  userId: string;
  agentUserId?: string;
  goal?: string;
  status?: "active" | "paused";
  progress?: number;
  currentStage?: string;
  addOutput?: { kind: string; label: string; icon?: string };
  completeOutput?: string;
  expectedOutputs?: Array<{
    kind: string;
    label: string;
    icon?: string;
    status?: "pending" | "done";
  }>;
}

export type UpdateFocusSessionResult =
  | { status: "not_found" }
  | { status: "denied"; reason: string }
  | {
      status: "proposed";
      proposalId: string;
      summary?: string;
      reviewPath?: string;
      reviewUrl?: string;
    }
  | { status: "updated"; session: typeof focusSessions.$inferSelect };

type OutputItem = {
  kind: string;
  label: string;
  icon?: string;
  status?: "pending" | "done";
};

export async function updateFocusSession(
  params: UpdateFocusSessionParams
): Promise<UpdateFocusSessionResult> {
  const { sessionId, userId, agentUserId } = params;

  // Load scoped by the operator userId — the floor that stops an agent key
  // from touching another user's session (mirrors completeFocusSession).
  const existing = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, sessionId),
      eq(focusSessions.userId, userId)
    ),
  });
  if (!existing) {
    return { status: "not_found" };
  }

  // Governance membrane — AI callers route through proposals (same gate the
  // Hub PATCH /focus-sessions/:id and synap_complete_session use).
  const { checkPermissionOrPropose } =
    await import("../../utils/permission-check.js");
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    workspaceId: existing.workspaceId ?? undefined,
    subjectType: "focus_session",
    action: "update",
    source: "intelligence",
    data: {
      id: sessionId,
      status: params.status,
      progress: params.progress,
    },
  });
  if ("denied" in perm && perm.denied) {
    return { status: "denied", reason: perm.reason };
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      summary: perm.summary,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
    };
  }

  // Build the field set. status is constrained to active|paused — closing a
  // session is synap_complete_session's job (it also closes the running
  // playbook_run); a raw status='closed' here would orphan that run.
  const set: Partial<typeof focusSessions.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (params.goal !== undefined) set.goal = params.goal;
  if (params.status !== undefined) set.status = params.status;
  if (params.progress !== undefined) set.progress = params.progress;
  if (params.currentStage !== undefined) set.currentStage = params.currentStage;

  // addOutput / completeOutput / a full expectedOutputs replace mutate the
  // JSONB deliverables array. Do the read-modify-write inside a transaction
  // with a row lock (`FOR UPDATE`) so two concurrent edits can't both read
  // the same base array and lose one's item (TOCTOU).
  const mutatesOutputs =
    params.addOutput !== undefined ||
    typeof params.completeOutput === "string" ||
    params.expectedOutputs !== undefined;

  const [updated] = await db.transaction(async (tx) => {
    if (mutatesOutputs) {
      const [locked] = await tx
        .select({ expectedOutputs: focusSessions.expectedOutputs })
        .from(focusSessions)
        .where(eq(focusSessions.id, sessionId))
        .for("update");
      const current: OutputItem[] = Array.isArray(locked?.expectedOutputs)
        ? (locked.expectedOutputs as OutputItem[])
        : [];
      let next: OutputItem[] = params.expectedOutputs ?? current;
      if (params.addOutput) {
        const add = params.addOutput;
        next = [
          ...next,
          {
            kind: add.kind,
            label: add.label,
            icon: add.icon,
            status: "pending",
          },
        ];
      }
      if (typeof params.completeOutput === "string") {
        const label = params.completeOutput;
        next = next.map((o) =>
          o.label === label ? { ...o, status: "done" as const } : o
        );
      }
      set.expectedOutputs = next;
    }
    return tx
      .update(focusSessions)
      .set(set)
      .where(eq(focusSessions.id, sessionId))
      .returning();
  });

  // Stage transition side-effect: when the active stage actually changes,
  // emit `focus_session.stage_changed` so automations can react (mirrors the
  // tRPC + Hub REST update doors). No-op for stageless / unchanged stages.
  if (
    params.currentStage !== undefined &&
    params.currentStage !== existing.currentStage
  ) {
    const { emitSideEffects } = await import("@synap/events");
    emitSideEffects({
      subjectType: "focus_session",
      action: "stage_changed",
      subjectId: updated.id,
      userId,
      workspaceId: existing.workspaceId,
      data: {
        sessionId: updated.id,
        subjectId: existing.subjectEntityId,
        playbookId: existing.playbookId,
        fromStage: existing.currentStage,
        toStage: updated.currentStage,
        workspaceId: existing.workspaceId,
        userId,
      },
    });
  }

  return { status: "updated", session: updated };
}
