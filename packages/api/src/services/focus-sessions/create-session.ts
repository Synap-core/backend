/**
 * createFocusSession — shared service behind both Hub REST and MCP adapter.
 *
 * Creates a focus session (goal-bound work session) with governance gating.
 * Idempotent by correlationId. Emits realtime events for browser mirroring.
 */
import { db, focusSessions, eq, and } from "@synap/database";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { emitHubRealtimeEvent } from "../../utils/domain-event-bridge.js";

export interface CreateFocusSessionParams {
  userId: string;
  workspaceId: string;
  goal: string;
  agentUserId?: string;
  correlationId?: string;
  channelId?: string | null;
  agentIds?: string[];
  templateId?: string | null;
  expectedOutputs?: Array<{ kind: string; label: string; icon?: string }>;
}

export type CreateFocusSessionResult =
  | { status: "created"; session: typeof focusSessions.$inferSelect }
  | {
      status: "proposed";
      proposalId: string;
      message: string;
      summary?: string;
      reasoning?: string;
      reviewPath?: string;
      reviewUrl?: string;
    };

export async function createFocusSession(
  params: CreateFocusSessionParams
): Promise<CreateFocusSessionResult> {
  const {
    userId,
    workspaceId,
    goal,
    agentUserId,
    correlationId,
    channelId = null,
    agentIds = [],
    templateId = null,
    expectedOutputs = [],
  } = params;

  // Idempotency: correlationId returns the existing session for this user+workspace.
  if (correlationId) {
    const existing = await db.query.focusSessions.findFirst({
      where: and(
        eq(focusSessions.correlationId, correlationId),
        eq(focusSessions.userId, userId),
        eq(focusSessions.workspaceId, workspaceId)
      ),
    });
    if (existing) return { status: "created", session: existing };
  }

  // Governance membrane — AI callers route through proposals.
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    workspaceId,
    subjectType: "focus_session",
    action: "create",
    source: "intelligence",
    data: { goal, templateId },
  });

  if ("denied" in perm && perm.denied) {
    throw Object.assign(new Error(perm.reason), { code: "FORBIDDEN" });
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      message: "Focus session creation proposed for review",
      summary: perm.summary,
      reasoning: perm.reasoning,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
    };
  }

  const [created] = await db
    .insert(focusSessions)
    .values({
      workspaceId,
      userId,
      goal,
      correlationId: correlationId ?? null,
      templateId,
      expectedOutputs,
      channelId,
      agentIds,
      status: "active",
    })
    .returning();

  emitHubRealtimeEvent({
    eventType: "focus_session.create.completed",
    subjectId: created.id,
    userId,
    data: {
      id: created.id,
      workspaceId: created.workspaceId,
      status: created.status,
      goal: created.goal,
      progress: created.progress,
    },
  });

  return { status: "created", session: created };
}
