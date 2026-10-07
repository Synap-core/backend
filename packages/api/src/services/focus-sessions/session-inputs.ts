/**
 * Attach a captured entity to a RUNNING session as an INPUT — the confirm half
 * of the "session" route candidate (`routing/match-sessions-for-entity.ts`):
 * capture says "this belongs to the DJ set you have open", the person confirms,
 * and the thing arrives in that session.
 *
 * THE EDGE: `session --targets--> entity`, metadata `{ role: "input", via }`.
 * No new link type: `targets` is already the session's INPUT side of the
 * graph — `session-output-edges.ts` reads `A --targets--> X` as "X is A's input
 * / subject" (and derives "A waits on B's output" from it), and the project
 * subject bind uses the same edge. `produced` would be a lie: the session did
 * not make it.
 *
 * GOVERNED, through the same gate as `POST /links` (`link` / `create`): a
 * person confirming on their own session is granted; an agent caller follows
 * its governance lane, and a proposal is a normal outcome — on approval the
 * materializer writes the same edge with the same metadata. (The room message
 * is posted only on the direct path: a pending proposal has not arrived yet.)
 *
 * Floors: the session is the caller's own and OPEN; the entity is one the
 * caller can already see (`isOutputRefVisible`, the attach-output floor).
 */

import { createLogger } from "@synap-core/core";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import {
  db,
  and,
  eq,
  inArray,
  entities,
  focusSessions,
  links,
} from "@synap/database";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { stampAutoApprovedCreate } from "../proposals/stamp-materialized.js";
import { createLink } from "../links/links-service.js";
import { isOutputRefVisible } from "./assert-output-ref-visible.js";

const logger = createLogger({ module: "focus-sessions/session-inputs" });

/** Statuses a session can take an input in: it is still being worked. */
const ATTACHABLE_STATUSES = ["active", "paused", "forming"] as const;

export type AttachSessionInputResult =
  | {
      status: "attached";
      linkId: string | null;
      /** The edge already existed — nothing new was written or posted. */
      alreadyLinked: boolean;
      sessionId: string;
      entityId: string;
      channelId: string | null;
    }
  | {
      status: "proposed";
      proposalId: string;
      reviewPath: string;
      reviewUrl: string;
    }
  | { status: "denied"; reason: string }
  | { status: "not_found"; what: "session" | "entity" }
  | { status: "closed"; sessionStatus: string };

export async function attachSessionInput(input: {
  sessionId: string;
  entityId: string;
  /** The human principal (owner floor). */
  userId: string;
  /** The acting agent, when an agent key calls. */
  agentUserId?: string | null;
  /** Where the suggestion came from — recorded on the edge. */
  via?: "capture" | "manual";
  reasoning?: string;
}): Promise<AttachSessionInputResult> {
  const [session] = await db
    .select({
      id: focusSessions.id,
      status: focusSessions.status,
      workspaceId: focusSessions.workspaceId,
      channelId: focusSessions.channelId,
      goal: focusSessions.goal,
      title: focusSessions.title,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, input.sessionId),
        eq(focusSessions.userId, input.userId)
      )
    )
    .limit(1);
  if (!session) return { status: "not_found", what: "session" };
  if (!(ATTACHABLE_STATUSES as readonly string[]).includes(session.status)) {
    return { status: "closed", sessionStatus: session.status };
  }

  const visible = await isOutputRefVisible({
    userId: input.userId,
    kind: "entity",
    refId: input.entityId,
  });
  if (!visible) return { status: "not_found", what: "entity" };
  const [entity] = await db
    .select({ title: entities.title, type: entities.type })
    .from(entities)
    .where(eq(entities.id, input.entityId))
    .limit(1);
  if (!entity) return { status: "not_found", what: "entity" };

  const metadata = { role: "input", via: input.via ?? "capture" };
  const noun = resolveObjectNoun(entity.type).toLowerCase();
  const sessionName = session.title?.trim() || session.goal;
  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    ...(input.agentUserId && input.agentUserId !== input.userId
      ? { agentUserId: input.agentUserId }
      : {}),
    workspaceId: session.workspaceId,
    subjectType: "link",
    action: "create",
    sessionId: session.id,
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    data: {
      title: `Add ${entity.title ?? noun} to “${sessionName}”`,
      fromType: "session",
      fromId: session.id,
      toType: "entity",
      toId: input.entityId,
      linkType: "targets",
      metadata,
    },
  });
  if ("denied" in perm && perm.denied) {
    return { status: "denied", reason: perm.reason };
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
    };
  }

  const created = await createLink({
    workspaceId: session.workspaceId ?? null,
    fromType: "session",
    fromId: session.id,
    toType: "entity",
    toId: input.entityId,
    linkType: "targets",
    metadata,
  });
  await stampAutoApprovedCreate({
    receiptId: "granted" in perm ? perm.autoApprovedProposalId : undefined,
    record: created ? { linkIds: [created.id] } : {},
    door: "attachSessionInput",
  });

  let linkId = created?.id ?? null;
  const alreadyLinked = !created;
  if (alreadyLinked) {
    const [existing] = await db
      .select({ id: links.id })
      .from(links)
      .where(
        and(
          eq(links.fromType, "session"),
          eq(links.fromId, session.id),
          eq(links.toType, "entity"),
          eq(links.toId, input.entityId),
          inArray(links.linkType, ["targets"])
        )
      )
      .limit(1);
    linkId = existing?.id ?? null;
  }

  // ONE short line in the room naming what arrived — the person and the
  // session's agent both read it. Keyed per (session, entity): a repeated
  // confirm never posts twice. A post failure never undoes the attach.
  if (!alreadyLinked && session.channelId) {
    try {
      const { postChannelMessage } =
        await import("../messaging/post-message.js");
      await postChannelMessage({
        channelId: session.channelId,
        userId: input.userId,
        content: `Added as input: ${entity.title ?? noun} (${noun}).`,
        role: "assistant",
        triggerAI: false,
        idempotencyKey: `session-input:${session.id}:${input.entityId}`,
      });
    } catch (err) {
      logger.warn(
        { err, sessionId: session.id, entityId: input.entityId },
        "input attached; the room line was NOT posted"
      );
    }
  }

  return {
    status: "attached",
    linkId,
    alreadyLinked,
    sessionId: session.id,
    entityId: input.entityId,
    channelId: session.channelId ?? null,
  };
}
