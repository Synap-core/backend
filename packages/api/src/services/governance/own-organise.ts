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
 * D7 (founder, 2026-10-28) added three doors' proofs: removing its own fresh
 * `blocked_by` edge on its own session (Q2), re-typing its own fresh record
 * within the same entity scope ("own renames"), and recording a decision the
 * person made in chat, relayed with their verbatim words (Q3).
 *
 * Not covered, by decision: un-filing, a space move, a track filing, a
 * terminal move other than `done`, a role's status, starting a track, any
 * other delete, an old link, a link on someone else's session.
 */
import {
  and,
  db,
  eq,
  focusSessions,
  getRequestApiKeyId,
  isDerivedSession,
  isOwnFreshWork,
  classifyLifecycleMove,
  links,
  ProfileResolutionService,
  sessionClientApiKeyId,
  type StatusMoveTarget,
} from "@synap/database";
import { getAgentFocusProjectId } from "../agent-identity-service.js";

/** The kind a relayed answer is recorded as (Q3). */
export const RELAYED_DECISION_KIND = "decision";

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

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this session bound to the request's key (the agent's OWN session)? */
async function sessionIsThisKeys(
  sessionId: string,
  apiKeyId: string,
  userId?: string | null
): Promise<boolean> {
  // A malformed id names no session (and must not reach a uuid column).
  if (!UUID_SHAPE.test(sessionId)) return false;
  const [session] = await db
    .select({ userId: focusSessions.userId, metadata: focusSessions.metadata })
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1);
  if (!session) return false;
  if (userId && session.userId !== userId) return false;
  return sessionClientApiKeyId(session.metadata) === apiKeyId;
}

/**
 * D7 Q2 — remove its own `blocked_by` edge (`dependency-links.ts`): the
 * waiting end is a session bound to THIS key, and the edge itself is this
 * key's fresh work (made through it in the last 24 h, untouched by a person —
 * `isOwnFreshWork` on the link). An older edge, an edge a person drew, or an
 * edge on another key's session proposes as every delete does.
 */
export async function ownWorkOrganiseForBlockerRemoval(input: {
  agentUserId: string | null | undefined;
  edge: {
    fromType: string;
    fromId: string;
    toType: string;
    toId: string;
    linkType: string;
  };
}): Promise<boolean> {
  const { edge } = input;
  const apiKeyId = getRequestApiKeyId();
  if (!input.agentUserId || !apiKeyId) return false;
  if (edge.linkType !== "blocked_by" || edge.fromType !== "session") {
    return false;
  }
  if (!(await sessionIsThisKeys(edge.fromId, apiKeyId))) return false;
  const [link] = await db
    .select({ id: links.id })
    .from(links)
    .where(
      and(
        eq(links.fromType, edge.fromType as never),
        eq(links.fromId, edge.fromId),
        eq(links.toType, edge.toType as never),
        eq(links.toId, edge.toId),
        eq(links.linkType, edge.linkType)
      )
    )
    .limit(1);
  if (!link) return false;
  return isOwnFreshWork(db, {
    agentUserId: input.agentUserId,
    apiKeyId,
    subjectType: "link",
    subjectIds: [link.id],
  });
}

/**
 * D7 "own renames" — re-type its own fresh record (`entities/mutate.ts`),
 * when the kind change is the write's ONLY forcing reason. Both kinds must
 * have the same entity scope, so the record is seen by exactly the same
 * people after the change: a re-type that would move it pod-wide (or back)
 * is a scope change and stays a floor.
 */
export async function ownWorkOrganiseForRetype(input: {
  agentUserId: string | null | undefined;
  entityId: string;
  fromKind: string | null | undefined;
  toKind: string;
  workspaceId: string | null;
}): Promise<boolean> {
  const apiKeyId = getRequestApiKeyId();
  if (!input.agentUserId || !apiKeyId) return false;
  if (!input.fromKind || input.fromKind === input.toKind) return false;
  const profiles = new ProfileResolutionService(db);
  const [fromScope, toScope] = await Promise.all([
    profiles.getEntityScope(input.fromKind, input.workspaceId),
    profiles.getEntityScope(input.toKind, input.workspaceId),
  ]);
  if (fromScope !== toScope) return false;
  return isOwnFreshWork(db, {
    agentUserId: input.agentUserId,
    apiKeyId,
    subjectType: "entity",
    subjectIds: [input.entityId],
  });
}

/**
 * The relay provenance a decision must carry to be recorded without asking
 * (Q3), read from the write itself. PURE. Returns the session the person
 * answered in, or `null` when any of the three is missing:
 *   - `answeredVia: "relayed"` — the agent carried the answer from a chat;
 *   - `relayQuote` — the person's words, verbatim (non-blank);
 *   - `sourceSessionId` — the session the question was asked in.
 */
export function relayedDecisionSession(
  profileSlug: string | null | undefined,
  properties: Record<string, unknown> | null | undefined
): string | null {
  if (profileSlug !== RELAYED_DECISION_KIND || !properties) return null;
  const { answeredVia, relayQuote, sourceSessionId } = properties;
  if (answeredVia !== "relayed") return null;
  if (typeof relayQuote !== "string" || relayQuote.trim() === "") return null;
  if (typeof sourceSessionId !== "string" || sourceSessionId === "") {
    return null;
  }
  return sourceSessionId;
}

/**
 * D7 Q3 — record a decision the person made in chat (`entities/create.ts`,
 * the capture graph): the decision carries the relay provenance above and
 * its session is the person's AND bound to THIS key (the agent that heard
 * the answer is the one recording it). The receipt and its Undo are the
 * check. Only a decision born decided needs it: the door claims the lane
 * only when the born status is a terminal one (otherwise the write already
 * applies as an ordinary create).
 */
export async function ownWorkOrganiseForRelayedDecision(input: {
  agentUserId: string | null | undefined;
  userId: string;
  profileSlug: string | null | undefined;
  properties: Record<string, unknown> | null | undefined;
}): Promise<boolean> {
  const apiKeyId = getRequestApiKeyId();
  if (!input.agentUserId || !apiKeyId) return false;
  const sessionId = relayedDecisionSession(
    input.profileSlug,
    input.properties
  );
  if (!sessionId) return false;
  return sessionIsThisKeys(sessionId, apiKeyId, input.userId);
}
