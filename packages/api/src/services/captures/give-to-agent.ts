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
 * HONEST DELIVERY. A connected agent (Claude Code, Codex…) that the pod cannot
 * reach only sees the work when it next calls the pod. So the answer says
 * "Delivered when <agent> checks in", with its last-seen time — never "sent".
 * A house agent (twin, IS persona) has no check-in; it is REFUSED here until a
 * wake exists for it, rather than filed where nothing will read it.
 *
 * A BOUND agent (reach `'dispatch'`: a person stored how the pod reaches it) is
 * PUSHED instead: its binding's capability ships a hand-off playbook
 * (`findHandOffPlaybook`), and the capture runs it through the ONE run door
 * (`runPlaybook` → the external-agent executor → the binding's `start` verb,
 * governed). The line then says what really happened — sent, waiting on an
 * approval, or not sent and why. A binding whose template ships no hand-off
 * playbook is refused by name, never filed as pull work it will not read.
 * Idempotent per capture: while a hand-off run of this capture is live or
 * proposed, giving it again returns that session (each start is a new provider
 * session and spends the provider's rate limit).
 *
 * Idempotent by the create door's own twin rule: giving the same capture again
 * while its session is open returns that session (`deduped: true`). The twin
 * rule ignores the roster, so a repeat naming ANOTHER agent APPENDS it to that
 * session's roster through the one roster door (`attachSessionAgent`) rather
 * than refusing: the work is the same, and both agents may pick it up. The
 * `line` is built from the roster the session ACTUALLY has after that.
 *
 * WHICH AGENTS. Only one the person OPERATES (`agentsOperatedBy`: a key linked
 * to them). Another person's agent may be on a shared roster, but its calls
 * run as that other person, so its orient never lists this person's sessions.
 */
import {
  and,
  db,
  desc,
  documents,
  documentVersions,
  drizzleSql,
  eq,
  inArray,
  LIVE_RUN_STATUSES,
  playbookRuns,
  readDocumentVersionContent,
} from "@synap/database";
import { resolveAgentDirection } from "@synap-core/types/agents";
import { AccessContext, scopedDb } from "../../access/index.js";
import { queryAgentUsers } from "../../routers/agent-users.js";
import { agentsOperatedBy, loadAgentPresence } from "../agent-presence.js";
import {
  AgentBindingError,
  ownedAgentIds,
  resolveAgentBinding,
  resolveAgentReach,
} from "../agent-dispatch/agent-binding.js";
import { findHandOffPlaybook } from "../agent-dispatch/hand-off-playbook.js";
import { runPlaybook } from "../playbooks/run-playbook.js";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { attachSessionAgent } from "../focus-sessions/attach-session-agent.js";
import { createFocusSession } from "../focus-sessions/create-session.js";
import {
  INTAKE_SOURCE_METADATA_KEY,
  type IntakeSourceMetadata,
} from "../intake/stage-intake-source.js";
import { ownCapturesWhere } from "./capture-scope.js";

export interface RosterAgent {
  id: string;
  name: string | null;
  /** ISO; `null` = never seen. */
  lastSeenAt: string | null;
}

/**
 * "Delivered when Claude Code checks in" / "…when Claude Code or Codex checks
 * in" — whoever checks in first can pick it up. No em dash (UI copy).
 */
export function deliveryLine(roster: readonly RosterAgent[]): string {
  const names = roster.map((a) => a.name ?? "your agent");
  if (names.length === 0) return "Delivered to the next agent that checks in";
  const who =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return `Delivered when ${who} checks in`;
}

/** `focusSessions.create`'s own goal bound. */
const GOAL_MAX = 2000;

export type GiveToAgentResult =
  | {
      status: "given";
      sessionId: string;
      /** The capture's session was already open — nothing new was written. */
      deduped: boolean;
      agent: RosterAgent | null;
      /**
       * Every agent on the session's roster after this call, the requested one
       * included. On a repeat it can hold an agent given the work earlier.
       */
      roster: RosterAgent[];
      /**
       * How the work reaches the agent.
       *   `on_check_in`       — it sees it the next time it calls the pod
       *                         (orient / wait); nothing wakes it.
       *   `sent`              — a bound agent: its provider accepted the task.
       *   `awaiting_approval` — a bound agent: starting it is a proposal.
       *   `not_sent`          — a bound agent: the start failed (the line and
       *                         the session room say why).
       */
      delivery: GiveDelivery;
      /** The one line the phone shows. */
      line: string;
    }
  | { status: "not_found" }
  | { status: "agent_not_found" }
  | { status: "agent_not_wakeable"; message: string }
  | { status: "empty_capture" }
  | { status: "proposed"; message: string }
  /** A bound agent's hand-off could not even start a run (the message says why). */
  | { status: "dispatch_failed"; message: string };

export type GiveDelivery =
  "on_check_in" | "sent" | "awaiting_approval" | "not_sent";

/** A hand-off run still in flight — or still waiting on its approval. */
const OPEN_HAND_OFF_STATUSES = [...LIVE_RUN_STATUSES, "proposed"] as const;

function deliveryOf(runStatus: string | null | undefined): GiveDelivery {
  if (runStatus === "proposed") return "awaiting_approval";
  if (runStatus === "failed" || runStatus === "cancelled") return "not_sent";
  return "sent";
}

function dispatchLine(
  delivery: GiveDelivery,
  who: string,
  error?: string | null
): string {
  switch (delivery) {
    case "awaiting_approval":
      return `Sending this to ${who} needs your approval`;
    case "not_sent":
      return error?.trim()
        ? `Not sent to ${who}: ${error.trim()}`
        : `Not sent to ${who}. The session says why`;
    default:
      return `Sent to ${who}`;
  }
}

function goalFrom(
  text: string | null,
  row: { title: string | null },
  source: IntakeSourceMetadata
): string | null {
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
  let bound = false;
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
        message: `${found.name ?? "This agent"} is the pod's own agent and never checks in to pick this up. Ask it in its chat instead.`,
      };
    }
    bound = (await resolveAgentReach(found.id)) === "dispatch";
    // Visible is not enough. A bound agent must be one this person OWNS (the
    // run executor's own floor — it never hands a teammate's agent the work);
    // a pulling agent must act for THIS person, or it will never see the
    // session (its orient reads its operator's sessions).
    const mine = bound
      ? (await ownedAgentIds(p.userId, [found.id])).has(found.id)
      : (await agentsOperatedBy(p.userId, [found.id])).has(found.id);
    if (!mine) return { status: "agent_not_found" };
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

  if (agent && bound) {
    return handToBoundAgent({
      userId: p.userId,
      captureId: row.id,
      captureWorkspaceId: row.workspaceId ?? null,
      parentSessionId: source?.sessionId ?? null,
      agent,
      goal,
    });
  }

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

  const sessionId = created.session.id;
  let agentIds = Array.isArray(created.session.agentIds)
    ? created.session.agentIds
    : [];
  if (agent && !agentIds.includes(agent.id)) {
    // A repeat naming another agent: the twin rule returned the open session,
    // whose roster does not hold this agent yet. Append it (the ONE roster
    // writer, locked + idempotent) so the line below is true.
    const attached = await attachSessionAgent({
      sessionId,
      agentId: agent.id,
      userId: p.userId,
    });
    if (attached.status === "not_found") return { status: "not_found" };
    agentIds = attached.agentIds;
  }

  // The line names the roster the session ACTUALLY has, among the agents this
  // person operates (the only ones that will ever see it).
  const [operated, presence] = await Promise.all([
    agentsOperatedBy(p.userId, agentIds),
    loadAgentPresence(agentIds),
  ]);
  const names = agentIds.length
    ? new Map(
        (await queryAgentUsers({ userId: p.userId }, undefined)).map(
          (r) => [r.id, r.name] as const
        )
      )
    : new Map<string, string | null>();
  const roster: RosterAgent[] = agentIds
    .filter((id) => operated.has(id))
    .map((id) => ({
      id,
      name: names.get(id) ?? null,
      lastSeenAt: presence.get(id)?.lastSeenAt ?? null,
    }));
  return {
    status: "given",
    sessionId,
    deduped: created.status === "deduped",
    agent: agent ? (roster.find((r) => r.id === agent!.id) ?? null) : null,
    roster,
    delivery: "on_check_in",
    line: deliveryLine(roster),
  };
}

/**
 * A BOUND agent: run its binding's hand-off playbook with the capture as the
 * task, through the ONE run door. See the header for the contract.
 */
async function handToBoundAgent(p: {
  userId: string;
  captureId: string;
  captureWorkspaceId: string | null;
  parentSessionId: string | null;
  agent: { id: string; name: string | null };
  goal: string;
}): Promise<GiveToAgentResult> {
  const who = p.agent.name ?? "your agent";
  let binding;
  try {
    binding = await resolveAgentBinding(p.agent.id);
  } catch (err) {
    if (!(err instanceof AgentBindingError)) throw err;
    return {
      status: "agent_not_wakeable",
      message: `${who} cannot be reached: ${err.message}`,
    };
  }
  if (!binding) {
    return {
      status: "agent_not_wakeable",
      message: `${who} has no way for the pod to reach it. Bind it in Settings > Agents.`,
    };
  }
  const service = resolveServiceName(binding.provider);
  const playbook = await findHandOffPlaybook(binding.toolId);
  if (!playbook) {
    return {
      status: "agent_not_wakeable",
      message: `${who} is reached through ${service}, which ships no hand-off playbook. Run one of its playbooks from a session instead.`,
    };
  }
  const workspaceId = playbook.workspaceId ?? p.captureWorkspaceId;
  if (!workspaceId) {
    return {
      status: "dispatch_failed",
      message: `"${playbook.name}" has no space to run in.`,
    };
  }

  const presence = await loadAgentPresence([p.agent.id]);
  const rosterAgent: RosterAgent = {
    id: p.agent.id,
    name: p.agent.name,
    lastSeenAt: presence.get(p.agent.id)?.lastSeenAt ?? null,
  };
  const given = (
    sessionId: string,
    deduped: boolean,
    runStatus: string | null | undefined,
    error?: string | null
  ): GiveToAgentResult => {
    const delivery = deliveryOf(runStatus);
    return {
      status: "given",
      sessionId,
      deduped,
      agent: rosterAgent,
      roster: [rosterAgent],
      delivery,
      line: dispatchLine(delivery, who, error),
    };
  };

  // A hand-off of THIS capture still in flight (or awaiting its approval) is
  // returned, never started twice.
  const [open] = await db
    .select({ sessionId: playbookRuns.sessionId, status: playbookRuns.status })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.playbookId, playbook.id),
        eq(playbookRuns.createdBy, p.userId),
        drizzleSql`${playbookRuns.input}->>'captureId' = ${p.captureId}`,
        inArray(playbookRuns.status, [...OPEN_HAND_OFF_STATUSES])
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  if (open?.sessionId) return given(open.sessionId, true, open.status);

  let started;
  try {
    started = await runPlaybook({
      playbookId: playbook.id,
      workspaceId,
      userId: p.userId,
      // `task` is the hand-off playbook's goal param; `agentUserId` is the
      // executor's "which agent" param; `captureId` keys the dedupe above.
      params: { task: p.goal, agentUserId: p.agent.id, captureId: p.captureId },
      onMissingRequired: "owe",
      agentIds: [p.agent.id],
      ...(p.parentSessionId ? { parentSessionId: p.parentSessionId } : {}),
    });
  } catch (err) {
    return {
      status: "dispatch_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!started.session) {
    return {
      status: "dispatch_failed",
      message: `"${playbook.name}" did not start a run.`,
    };
  }
  return given(
    started.session.id,
    started.reused === true,
    started.run?.status,
    started.run?.error
  );
}
