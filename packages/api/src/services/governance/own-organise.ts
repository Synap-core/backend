/**
 * ORGANISING ITS OWN FRESH WORK — the three doors' proof (FB1020 B3, founder
 * 2026-10-21). Each answers ONE question for its door: may this write go to
 * the pod's own-organise class row (`OWN_ORGANISE_CLASS_PATTERN`, rung 2.8)
 * instead of the floor it always had? The door then passes
 * `{ ownWorkOrganise: proof, forcePropose: !proof }` to
 * `checkPermissionOrPropose`; whether it applies is still the engine's call
 * (the row may be switched off, a person's rule or a floor may win).
 *
 * Every answer is derived from the pod's records and the request's key, never
 * from the caller's input:
 *   - the agent and its KEY (B7, `getRequestApiKeyId`) — no key, no proof;
 *   - "own fresh" — `isOwnFreshWork` (@synap/database): same key, last 24 h,
 *     untouched by a person since;
 *   - "a project the person named" — the project this conversation (or the
 *     agent) declared its focus on (`synap_set_project_focus`: "pin only what
 *     the user names"), or the project of the session the caller NAMED. A
 *     session the door guessed (derived) names nothing, the same rule as the
 *     project ladder (A1).
 *
 * Not covered, by decision: un-filing, a space move, a track filing, a
 * terminal move other than `done`, a role's status, recording a decision the
 * person made in chat, starting a track.
 */
import {
  db,
  eq,
  focusSessions,
  getRequestApiKeyId,
  isDerivedSession,
  isOwnFreshWork,
  classifyLifecycleMove,
  type StatusMoveTarget,
} from "@synap/database";
import { getAgentFocusProjectId } from "../agent-identity-service.js";

/** The kinds whose `done` move an agent may make on its own fresh record. */
export const OWN_CLOSE_KINDS: readonly string[] = ["task"];

/** Projects the person named for this agent's current work. */
async function namedProjectIds(
  agentUserId: string,
  sessionId: string | null | undefined
): Promise<Set<string>> {
  const named = new Set<string>();
  const focus = await getAgentFocusProjectId(agentUserId);
  if (focus) named.add(focus);
  if (sessionId && !isDerivedSession(sessionId, undefined)) {
    const [session] = await db
      .select({ projectId: focusSessions.projectId })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .limit(1);
    if (session?.projectId) named.add(session.projectId);
  }
  return named;
}

/** File records into a project (`file-entities.ts`). */
export async function ownWorkOrganiseForFiling(input: {
  agentUserId: string | null | undefined;
  projectId: string;
  entityIds: readonly string[];
  sessionId?: string | null;
}): Promise<boolean> {
  const apiKeyId = getRequestApiKeyId();
  if (!input.agentUserId || !apiKeyId || input.entityIds.length === 0) {
    return false;
  }
  const named = await namedProjectIds(input.agentUserId, input.sessionId);
  if (!named.has(input.projectId)) return false;
  return isOwnFreshWork(db, {
    agentUserId: input.agentUserId,
    apiKeyId,
    subjectType: "entity",
    subjectIds: input.entityIds,
  });
}

/**
 * File its own session into a project (`session-filing-gate.ts`). Project
 * ONLY: a space move or a track filing in the same patch stays a proposal.
 */
export async function ownWorkOrganiseForSessionFiling(input: {
  agentUserId: string | null | undefined;
  sessionId: string;
  filing: {
    projectId?: string | null;
    workspaceId?: string | null;
    trackFiling?: unknown;
  };
}): Promise<boolean> {
  const { filing } = input;
  const apiKeyId = getRequestApiKeyId();
  if (!input.agentUserId || !apiKeyId) return false;
  if (typeof filing.projectId !== "string") return false;
  if (filing.workspaceId !== undefined || filing.trackFiling !== undefined) {
    return false;
  }
  // The session's own project is what is changing, so only the declared focus
  // can name the target.
  const named = await namedProjectIds(input.agentUserId, null);
  if (!named.has(filing.projectId)) return false;
  return isOwnFreshWork(db, {
    agentUserId: input.agentUserId,
    apiKeyId,
    subjectType: "focus_session",
    subjectIds: [input.sessionId],
  });
}

/** Close its own task (`move-status.ts`): a `done` move on the KIND's lifecycle. */
export async function ownWorkOrganiseForTaskClose(input: {
  agentUserId: string | null | undefined;
  target: Pick<
    StatusMoveTarget,
    "entityId" | "entityType" | "role" | "lifecycle"
  >;
  to: string;
}): Promise<boolean> {
  const { target } = input;
  const apiKeyId = getRequestApiKeyId();
  if (!input.agentUserId || !apiKeyId) return false;
  if (target.role) return false;
  if (!target.entityType || !OWN_CLOSE_KINDS.includes(target.entityType)) {
    return false;
  }
  if (
    classifyLifecycleMove(target.lifecycle, input.to)?.toCategory !== "done"
  ) {
    return false;
  }
  return isOwnFreshWork(db, {
    agentUserId: input.agentUserId,
    apiKeyId,
    subjectType: "entity",
    subjectIds: [target.entityId],
  });
}
