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
  /**
   * Workspace the session belongs to. Optional — a session may instead be
   * anchored to a project (or the user floor). At least one of workspaceId /
   * projectId must be provided. When null/undefined the governance membrane
   * treats it as a personal resource and auto-grants (no membership needed).
   */
  workspaceId?: string | null;
  projectId?: string | null;
  /**
   * The entity this session is "about" — the subject-spine anchor. Written on
   * the ad-hoc start path so a session can be tied to a person/company/deal.
   */
  subjectEntityId?: string | null;
  goal: string;
  agentUserId?: string;
  correlationId?: string;
  channelId?: string | null;
  agentIds?: string[];
  templateId?: string | null;
  expectedOutputs?: Array<{
    kind: string;
    label: string;
    icon?: string;
    status?: "pending" | "done";
  }>;
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
    workspaceId = null,
    projectId = null,
    subjectEntityId = null,
    goal,
    agentUserId,
    correlationId,
    channelId = null,
    agentIds = [],
    templateId = null,
    expectedOutputs = [],
  } = params;

  if (!workspaceId && !projectId) {
    throw Object.assign(
      new Error("A focus session requires a workspaceId or a projectId"),
      { code: "BAD_REQUEST" }
    );
  }

  // Idempotency: correlationId returns the existing session for this user,
  // scoped to the same workspace when one is given.
  if (correlationId) {
    const existing = await db.query.focusSessions.findFirst({
      where: and(
        eq(focusSessions.correlationId, correlationId),
        eq(focusSessions.userId, userId),
        ...(workspaceId ? [eq(focusSessions.workspaceId, workspaceId)] : [])
      ),
    });
    if (existing) return { status: "created", session: existing };
  }

  // Governance membrane — AI callers route through proposals. A session with no
  // workspace is a personal resource and auto-grants via checkPermissionOrPropose.
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    workspaceId: workspaceId ?? undefined,
    projectId: projectId ?? undefined,
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
      projectId,
      subjectEntityId,
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
