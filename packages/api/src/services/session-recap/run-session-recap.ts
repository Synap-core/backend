/**
 * Session Recap — the `post`-stage recap for an event-mode focus session.
 *
 * Invoked by the jobs `session-recap` worker (IoC slot `registerSessionRecapRunner`)
 * when a focus session advances to its `post` stage — in event mode, when the
 * bound event's endDate crossed and `run-event-end` flipped the session (see
 * services/event-end/run-event-end.ts). Lives in @synap/api because it needs the
 * links graph, the IS transport, the channel writer, and the governance gate —
 * none of which @synap/jobs can import.
 *
 * Flow:
 *   1. Read the session's produced entities via `session --produced--> entity`
 *      (getLinksFor). Empty ⇒ nothing was captured ⇒ bail (no noise).
 *   2. Load the session (channelId + subjectEntityId=the event). Resolve the
 *      channel and ASSERT branchPurpose !== 'client-comms' (never recap into a
 *      client-facing surface — the capture channel is an internal team surface).
 *   3. Ask the IS to summarize who/what was captured during the event and propose
 *      concrete follow-ups (intros, messages, deals). Credentials via
 *      resolveIntelligenceService (DB, never env).
 *   4. Post the recap TEXT to the session's channel (insertChannelMessage —
 *      firewall-safe, auto-mirrors if the channel is Discord-bound).
 *   5. Surface the follow-ups as ONE governed proposal (checkPermissionOrPropose
 *      with agentUserId + sessionId + projectId) — one review item per recap, not
 *      N. Only when an agent identity exists (else it would auto-grant as owner).
 *   6. Best-effort close the session with the recap as its summary.
 */

import {
  db,
  channels,
  entities,
  focusSessions,
  eq,
  inArray,
  insertChannelMessage,
  MessageCategory,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { randomUUID } from "crypto";

import {
  resolveIntelligenceService,
  requestHeadlessChatText,
} from "@synap/intelligence-client";

import { getLinksFor } from "../links/links-service.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { completeFocusSession } from "../focus-sessions/complete-session.js";

const logger = createLogger({ module: "session-recap" });

export interface RunSessionRecapInput {
  sessionId: string;
  userId: string;
  workspaceId?: string | null;
}

export interface RunSessionRecapResult {
  skipped?: boolean;
  reason?: string;
  producedCount?: number;
  posted?: boolean;
  proposalId?: string | null;
}

/** Ordered, de-duped list of entity ids this session produced. */
function producedEntityIds(
  links: Awaited<ReturnType<typeof getLinksFor>>,
  sessionId: string
): string[] {
  const ids: string[] = [];
  for (const l of links) {
    if (
      l.linkType === "produced" &&
      l.fromType === "session" &&
      l.fromId === sessionId &&
      l.toType === "entity"
    ) {
      if (!ids.includes(l.toId)) ids.push(l.toId);
    }
  }
  return ids;
}

export async function runSessionRecap(
  input: RunSessionRecapInput
): Promise<RunSessionRecapResult> {
  const { sessionId, userId } = input;

  // 1. Produced entities (session --produced--> entity). Scoped by the owner.
  const links = await getLinksFor(userId, "session", sessionId);
  const entityIds = producedEntityIds(links, sessionId);
  if (entityIds.length === 0) {
    logger.info(
      { sessionId },
      "session-recap: no produced entities — skipping"
    );
    return { skipped: true, reason: "no_produced_entities", producedCount: 0 };
  }

  // 2. Load the session (owner-scoped) for channelId + subject event + lens.
  const session = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, sessionId),
    columns: {
      id: true,
      userId: true,
      workspaceId: true,
      projectId: true,
      channelId: true,
      subjectEntityId: true,
      goal: true,
    },
  });
  if (!session) {
    return { skipped: true, reason: "session_not_found" };
  }
  if (!session.channelId) {
    return { skipped: true, reason: "session_has_no_channel" };
  }
  const workspaceId = session.workspaceId ?? input.workspaceId ?? null;

  // Firewall assertion — never recap into a client-facing surface. The capture
  // channel is an internal team surface; guard before posting.
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, session.channelId),
    columns: { id: true, branchPurpose: true },
  });
  if (channel?.branchPurpose === "client-comms") {
    logger.warn(
      { sessionId, channelId: session.channelId },
      "session-recap: channel is client-comms — refusing to post"
    );
    return { skipped: true, reason: "client_comms_channel" };
  }

  // Load produced entities + the event for the IS prompt context.
  const produced = await db.query.entities.findMany({
    where: inArray(entities.id, entityIds),
    columns: { id: true, title: true, type: true },
  });
  const event = session.subjectEntityId
    ? await db.query.entities.findFirst({
        where: eq(entities.id, session.subjectEntityId),
        columns: { id: true, title: true },
      })
    : null;

  // 3. Ask the IS to summarize + propose follow-ups. Credentials from the DB.
  const service = await resolveIntelligenceService({
    userId,
    workspaceId: workspaceId ?? undefined,
    capability: "default",
  });

  const eventLabel = event?.title ? `"${event.title}"` : "this event";
  const capturedList = produced
    .map((e) => `- ${e.title ?? "(untitled)"} [${e.type}]`)
    .join("\n");

  const query =
    `The event ${eventLabel} just ended. During it, these were captured in ` +
    `Synap (focus session ${sessionId}):\n${capturedList}\n\n` +
    `Write a short recap for the team channel: (1) summarize who and what was ` +
    `captured during the event, then (2) propose concrete follow-ups — specific ` +
    `intros to make, messages to send, and deals to open — grounded ONLY in the ` +
    `captured items above. Be concise and actionable.`;

  let recapText = "";
  if (service?.endpoint) {
    try {
      const res = await requestHeadlessChatText(
        service.endpoint,
        service.serviceApiKey,
        {
          query,
          threadId: session.channelId,
          userId,
          workspaceId: workspaceId ?? undefined,
          agentType: "orchestrator",
          sourceMessageId: randomUUID(),
          focusSessionId: sessionId,
          agentUserId: service.agentUserId,
        }
      );
      recapText = res.text?.trim() ?? "";
      if (res.error) {
        logger.warn(
          { sessionId, err: res.error },
          "session-recap: IS returned error"
        );
      }
    } catch (err) {
      logger.warn(
        { err, sessionId },
        "session-recap: IS call failed — using fallback"
      );
    }
  } else {
    logger.info(
      { sessionId },
      "session-recap: no IS resolved — using fallback recap"
    );
  }

  // Deterministic fallback so the recap always posts even when the IS is down.
  if (!recapText) {
    recapText =
      `**Event recap — ${event?.title ?? "event"}**\n\n` +
      `Captured during this event (${produced.length}):\n${capturedList}`;
  }

  // 4. Post the recap to the session's channel (firewall-safe, auto-mirrors).
  let posted = false;
  try {
    await insertChannelMessage({
      channelId: session.channelId,
      content: recapText,
      userId,
      messageCategory: MessageCategory.SYSTEM_NOTIFICATION,
      metadata: {
        source: "session-recap",
        sessionId,
        eventId: event?.id ?? null,
      },
    });
    posted = true;
  } catch (err) {
    logger.warn({ err, sessionId }, "session-recap: channel post failed");
  }

  // 5. ONE composite governed proposal for the follow-ups (intros/messages/deals).
  // Only when an agent identity exists — otherwise checkPermissionOrPropose runs
  // as the OWNER and auto-grants (no review), which defeats the purpose. The
  // suggestions ride in the proposal's `data` as advisory text the reviewer acts
  // on; approval is a no-op materialize (the wildcard executor records it).
  let proposalId: string | null = null;
  if (service?.agentUserId) {
    try {
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: service.agentUserId,
        workspaceId: workspaceId ?? undefined,
        projectId: session.projectId ?? undefined,
        sessionId,
        subjectType: "proactive",
        action: "recap",
        source: "intelligence",
        reasoning:
          "Event-mode recap: review the suggested follow-ups (intros, messages, deals).",
        data: {
          id: sessionId,
          eventId: event?.id ?? null,
          channelId: session.channelId,
          producedEntityIds: entityIds,
          followUps: recapText,
        },
      });
      if ("proposalId" in perm) proposalId = perm.proposalId;
    } catch (err) {
      logger.warn(
        { err, sessionId },
        "session-recap: follow-up proposal failed"
      );
    }
  }

  // 6. Best-effort close the session with the recap as its summary.
  try {
    const closed = await completeFocusSession({
      sessionId,
      userId,
      summary: recapText,
    });
    // This is the one UNATTENDED close — no agent or human reads the return
    // value, so the retirement report would otherwise vanish here. A log line
    // is the honest surface on a worker.
    if (closed && closed.counts.expiredEphemerals > 0) {
      logger.info(
        {
          sessionId,
          expired: closed.counts.expiredEphemerals,
          warnings: closed.warnings,
        },
        "session recap closed the session; expired its unanswered capability runs"
      );
    }
  } catch (err) {
    logger.warn(
      { err, sessionId },
      "session-recap: session close failed (non-fatal)"
    );
  }

  logger.info(
    { sessionId, producedCount: produced.length, posted, proposalId },
    "session-recap run complete"
  );

  return {
    producedCount: produced.length,
    posted,
    proposalId,
  };
}
