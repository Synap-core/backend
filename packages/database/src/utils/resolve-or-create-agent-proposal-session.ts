/**
 * Resolve or create a focus session for an agent PENDING proposal that arrived
 * without a sessionId — the Wave 2 "AI works like a teammate" packaging door.
 *
 * Reuse ladder (anti-spam):
 *  1. Existing session with the same correlationId (when caller set a stable one)
 *  2. Active agent-origin session for same operator + agent + goal (+ workspace)
 *  3. Mint via openRunSession (source: agent-write)
 *
 * Never calls createFocusSession (that proposes → recursion / null id).
 * Humans (no agentUserId) never enter this helper — callers must gate.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../client-pg.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { openRunSession } from "./open-run-session.js";

export interface ResolveOrCreateAgentProposalSessionInput {
  userId: string;
  agentUserId: string;
  goal: string;
  workspaceId?: string | null;
  projectId?: string | null;
  /** Only reuse/bind when the caller already had a stable chain id — not a
   *  fresh per-proposal UUID that would force one session per row. */
  correlationId?: string | null;
  /** When true, treat correlationId as stable and prefer it for reuse. */
  stableCorrelation?: boolean;
}

function normalizeGoal(goal: string): string {
  return goal.replace(/\s+/g, " ").trim().slice(0, 240);
}

export async function resolveOrCreateAgentProposalSession(
  input: ResolveOrCreateAgentProposalSessionInput
): Promise<string | null> {
  const goal = normalizeGoal(input.goal);
  if (!goal) return null;

  try {
    // 1) Stable correlation → existing session
    if (input.stableCorrelation && input.correlationId) {
      const byCorr = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.correlationId, input.correlationId),
          eq(focusSessions.userId, input.userId),
          ...(input.workspaceId
            ? [eq(focusSessions.workspaceId, input.workspaceId)]
            : [])
        ),
        columns: { id: true },
      });
      if (byCorr) return byCorr.id;
    }

    // 2) Active agent session with same goal + agent on roster
    const open = await db.query.focusSessions.findFirst({
      where: and(
        eq(focusSessions.userId, input.userId),
        eq(focusSessions.status, "active"),
        eq(focusSessions.goal, goal),
        eq(focusSessions.origin, "agent"),
        sql`${focusSessions.agentIds} @> ARRAY[${input.agentUserId}]::text[]`,
        ...(input.workspaceId
          ? [eq(focusSessions.workspaceId, input.workspaceId)]
          : [])
      ),
      columns: { id: true },
      orderBy: [desc(focusSessions.startedAt)],
    });
    if (open) return open.id;

    // 3) Mint ungated run session
    const opened = await openRunSession({
      userId: input.userId,
      agentUserId: input.agentUserId,
      workspaceId: input.workspaceId ?? null,
      projectId: input.projectId ?? null,
      goal,
      source: "agent-write",
      extraMetadata: {
        kind: "agent-proposal-package",
        ...(input.stableCorrelation && input.correlationId
          ? { correlationId: input.correlationId }
          : {}),
      },
    });
    return opened.sessionId;
  } catch {
    // Best-effort — never block the proposal write if session mint fails.
    return null;
  }
}

/** Derive a short goal string from proposal insert fields. */
export function deriveAgentProposalSessionGoal(input: {
  data?: Record<string, unknown> | null;
  proposalType?: string;
  targetType?: string;
  notificationDescription?: string | null;
}): string {
  const data = input.data ?? {};
  const fromSummary =
    typeof data.summary === "string" ? data.summary.trim() : "";
  if (fromSummary) return normalizeGoal(fromSummary);
  const fromNotify = input.notificationDescription?.trim();
  if (fromNotify) return normalizeGoal(fromNotify);
  const fromGoal = typeof data.goal === "string" ? data.goal.trim() : "";
  if (fromGoal) return normalizeGoal(fromGoal);
  const fromReasoning =
    typeof data.reasoning === "string" ? data.reasoning.trim() : "";
  if (fromReasoning) return normalizeGoal(fromReasoning.slice(0, 160));
  const type = input.proposalType?.trim() || "write";
  const target = input.targetType?.trim() || "entity";
  return normalizeGoal(`Agent ${type} · ${target}`);
}
