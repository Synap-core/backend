import { randomUUID } from "crypto";
import { auditLog } from "./audit-log.js";
import { createPendingProposal } from "./permission-check.js";

export interface CreateEventBackedProposalInput {
  userId: string;
  workspaceId?: string | null;
  targetType: string;
  targetId: string;
  proposalType: string;
  data: Record<string, unknown>;
  action?: string;
  source?: string;
  summary?: string;
  agentUserId?: string | null;
  createdBy?: string | null;
  threadId?: string | null;
  commandRunId?: string | null;
  sourceMessageId?: string | null;
  sessionId?: string | null;
  expiresAt?: Date | null;
}

export async function createEventBackedProposal(
  input: CreateEventBackedProposalInput
) {
  // correlationId serves event-chain grouping, NOT session linking.
  // When linked to a session, use session.id as correlationId so events
  // are traceable back to the session. No randomUUID fallback for sessionId.
  const correlationId =
    input.sessionId ??
    (typeof input.data.correlationId === "string"
      ? input.data.correlationId
      : randomUUID());
  const action = input.action ?? inferProposalAction(input.proposalType);

  const requestedEvent = await auditLog({
    subjectType: input.targetType,
    action,
    phase: "requested",
    subjectId: input.targetId,
    userId: input.userId,
    workspaceId: input.workspaceId ?? undefined,
    correlationId,
    source: input.source ?? "api",
    data: {
      ...input.data,
      proposalType: input.proposalType,
      summary: input.summary,
    },
  });

  const data = {
    ...input.data,
    ...(input.summary ? { summary: input.summary } : {}),
    correlationId,
    ...(requestedEvent?.id ? { requestedEventId: requestedEvent.id } : {}),
  };

  const proposal = await createPendingProposal({
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
    targetType: input.targetType,
    targetId: input.targetId,
    proposalType: input.proposalType,
    data,
    agentUserId: input.agentUserId,
    createdBy: input.createdBy,
    threadId: input.threadId,
    commandRunId: input.commandRunId,
    sourceMessageId: input.sourceMessageId,
    sessionId: input.sessionId ?? null,
    expiresAt: input.expiresAt,
    notificationDescription: input.summary,
  });

  return { proposal, requestedEvent, correlationId };
}

function inferProposalAction(proposalType: string): string {
  const parts = proposalType.split(".");
  return parts[1] || parts[0] || "update";
}
