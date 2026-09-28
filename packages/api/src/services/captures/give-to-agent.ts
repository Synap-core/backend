/**
 * GIVE TO AGENT — hand one own capture to an agent as work (relay Capture
 * "Give to agent", design-relay §4.4 / F4).
 *
 * WHERE THE WORK IS FILED. A new focus session owned by the PERSON, goal =
 * the capture's words, the agent on its roster (`agentIds`), opened through
 * the ONE create door (`createFocusSession`). When the capture already has an
 * intake run, the session is that run's child (`session --spawned_from-->
 * run`), so the capture's own detail lists it under `runs`. That is exactly
 * where a pull-only agent looks: orient's `startHere.handedToYou` lists open
 * sessions naming it, and `startHere.openSessions` counts it.
 *
 * HONEST DELIVERY. Nothing here WAKES an agent: an external agent (Claude
 * Code, Codex…) only sees the work when it next calls the pod. So the answer
 * says "Delivered when <agent> checks in", with its last-seen time — never
 * "sent". A house agent (twin, IS persona) has no check-in; it is REFUSED
 * here until a wake exists for it, rather than filed where nothing will read
 * it.
 *
 * Idempotent by the create door's own twin rule: giving the same capture again
 * while its session is open returns that session (`deduped: true`).
 */
import {
  and,
  db,
  desc,
  documents,
  documentVersions,
  eq,
  readDocumentVersionContent,
} from "@synap/database";
import { resolveAgentDirection } from "@synap-core/types/agents";
import { AccessContext, scopedDb } from "../../access/index.js";
import { queryAgentUsers } from "../../routers/agent-users.js";
import { loadAgentPresence } from "../agent-presence.js";
import { createFocusSession } from "../focus-sessions/create-session.js";
import {
  INTAKE_SOURCE_METADATA_KEY,
  type IntakeSourceMetadata,
} from "../intake/stage-intake-source.js";
import { ownCapturesWhere } from "./capture-scope.js";

/** `focusSessions.create`'s own goal bound. */
const GOAL_MAX = 2000;

export type GiveToAgentResult =
  | {
      status: "given";
      sessionId: string;
      /** The capture's session was already open — nothing new was written. */
      deduped: boolean;
      agent: {
        id: string;
        name: string | null;
        /** ISO; `null` = never seen. */
        lastSeenAt: string | null;
      } | null;
      /**
       * How the work reaches the agent. `on_check_in` — it sees it the next
       * time it calls the pod (orient / wait); nothing wakes it.
       */
      delivery: "on_check_in";
      /** The one line the phone shows. */
      line: string;
    }
  | { status: "not_found" }
  | { status: "agent_not_found" }
  | { status: "agent_not_wakeable"; message: string }
  | { status: "empty_capture" }
  | { status: "proposed"; message: string };

function goalFrom(text: string | null, row: { title: string | null }, source: IntakeSourceMetadata): string | null {
  const words = (text ?? "").replace(/\s+/g, " ").trim();
  if (words) return words.slice(0, GOAL_MAX);
  const named = source.url || source.filename || row.title;
  return named ? `Work on ${named}`.slice(0, GOAL_MAX) : null;
}

export async function giveCaptureToAgent(p: {
  access: AccessContext;
  userId: string;
  captureId: string;
  agentUserId?: string | null;
}): Promise<GiveToAgentResult> {
  // The capture: the caller's own, live — the SAME read `captures.get` does
  // (the `documents` VisibilityRule, narrowed to the owner). A foreign id and
  // a missing id are the same answer.
  const row = await scopedDb(p.access).findFirst<{
    id: string;
    title: string | null;
    metadata: Record<string, unknown> | null;
    workspaceId: string | null;
  }>(documents, {
    where: and(ownCapturesWhere(p.userId), eq(documents.id, p.captureId)),
    columns: { id: true, title: true, metadata: true, workspaceId: true },
  });
  if (!row) return { status: "not_found" };
  const source = ((row.metadata ?? {}) as Record<string, unknown>)[
    INTAKE_SOURCE_METADATA_KEY
  ] as IntakeSourceMetadata;

  // The agent: one the caller's roster shows (`agentUsers.list`'s floor).
  let agent: { id: string; name: string | null } | null = null;
  if (p.agentUserId) {
    const roster = await queryAgentUsers({ userId: p.userId }, undefined);
    const found = roster.find((r) => r.id === p.agentUserId);
    if (!found) return { status: "agent_not_found" };
    const direction = resolveAgentDirection({
      origin: found.createdVia,
      isPersonalAgent: found.isPersonalAgent,
    });
    if (direction === "house") {
      return {
        status: "agent_not_wakeable",
        message: `${found.name ?? "This agent"} is the pod's own agent and has no check-in to pick this up — ask it in its chat instead.`,
      };
    }
    agent = { id: found.id, name: found.name };
  }

  const [latest] = await db
    .select({
      content: documentVersions.content,
      storageKey: documentVersions.storageKey,
      mimeType: documentVersions.mimeType,
    })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, row.id))
    .orderBy(desc(documentVersions.version))
    .limit(1);
  const text = latest ? await readDocumentVersionContent(latest) : null;
  const goal = goalFrom(text, row, source);
  if (!goal) return { status: "empty_capture" };

  const created = await createFocusSession({
    userId: p.userId,
    workspaceId: row.workspaceId ?? null,
    projectId: null,
    trackId: null,
    trackStage: null,
    subjectEntityId: null,
    title: null,
    goal,
    templateId: null,
    expectedOutputs: [],
    channelId: null,
    agentIds: agent ? [agent.id] : [],
    parentSessionId: source?.sessionId ?? null,
    blockedBySessionIds: [],
  });
  if (created.status === "proposed") {
    return { status: "proposed", message: created.message };
  }

  const presence = agent
    ? (await loadAgentPresence([agent.id])).get(agent.id)
    : undefined;
  const lastSeenAt = presence?.lastSeenAt ?? null;
  const who = agent?.name ?? "your agent";
  return {
    status: "given",
    sessionId: created.session.id,
    deduped: created.status === "deduped",
    agent: agent ? { ...agent, lastSeenAt } : null,
    delivery: "on_check_in",
    line: agent
      ? `Delivered when ${who} checks in`
      : "Delivered to the next agent that checks in",
  };
}
