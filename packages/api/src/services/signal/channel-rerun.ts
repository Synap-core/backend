/**
 * Channel rerun — "sweep this channel's recent messages through its extraction
 * automation again".
 *
 * WHY AN EXPLICIT TRIGGER, not a re-ingest: `recordInboundMessage` is idempotent
 * on the delivery hash, so replaying a provider message no-ops; and the bulk
 * path (`suppressSideEffects`) deliberately does NOT re-emit
 * `external_message.received` so a backfill can't replay a whole thread into an
 * auto-reply automation. Both are correct — and both mean a rerun that "just
 * re-ingests" would silently do nothing. So a sweep TRIGGERS the automation
 * directly, with the channel's bound entity as the run subject and the channel
 * id on the payload.
 *
 * GOVERNANCE: the run is opened through the canonical automation trigger door
 * (`automations.trigger`), which owns `assertWorkspaceWrite` for the operator
 * path and `checkPermissionOrPropose` (`automation` + `execute`, NOT in
 * DEFAULT_AUTO_APPROVE) for the agent path. This service does the RESOLUTION —
 * which channel, which automation, how many messages — and hands the decision
 * to that door; it never opens a run itself.
 *
 * FLOORS: the channel is read through `channelVisibilityWhere`; the candidate
 * automations through `userVisibleWhere` (via `getChannelStack`); and the
 * message PREVIEW count through `queryChannelMessages` with a `userId` — the
 * user-request door, never the jobs-side workspace predicate.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  channels,
  messages,
  MessageAuthorType,
} from "@synap/database";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import { queryChannelMessages } from "../../utils/query-channel-messages.js";
import { getChannelStack } from "./channel-stack.js";

/** Default and maximum number of messages a single sweep reports/queues. */
const DEFAULT_SWEEP_LIMIT = 50;
const MAX_SWEEP_LIMIT = 500;

export interface ResolvedChannelRerun {
  channelId: string;
  channelWorkspaceId: string | null;
  /** The entity the channel is bound to — the run's durable subject lens. */
  boundEntityId: string | null;
  automationId: string;
  automationName: string | null;
  /** Inbound external messages in scope for this sweep (floored + capped). */
  scanned: number;
}

/**
 * Pick the automation a bare `channelRerun` (no explicit automationId) should
 * run: the most specifically-bound one. A channel-bound automation beats an
 * entity-bound one, which beats a capability-reached one, which beats a
 * workspace-wide one; enabled always beats disabled. Pure — the caller supplies
 * the already-floored candidate list from `getChannelStack`.
 */
export function pickPrimaryChannelAutomation<
  T extends { id: string; enabled: boolean; binding: string },
>(candidates: T[]): T | null {
  const rank: Record<string, number> = {
    channel: 0,
    entity: 1,
    capability: 2,
    workspace: 3,
  };
  const sorted = [...candidates].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (rank[a.binding] ?? 9) - (rank[b.binding] ?? 9);
  });
  return sorted[0] ?? null;
}

export async function resolveChannelRerun(input: {
  userId: string;
  channelId: string;
  automationId?: string;
  limit?: number;
}): Promise<ResolvedChannelRerun> {
  const { userId, channelId } = input;
  const limit = Math.min(
    Math.max(input.limit ?? DEFAULT_SWEEP_LIMIT, 1),
    MAX_SWEEP_LIMIT
  );

  const [channel] = await db
    .select({
      id: channels.id,
      workspaceId: channels.workspaceId,
      contextObjectId: channels.contextObjectId,
    })
    .from(channels)
    .where(and(eq(channels.id, channelId), channelVisibilityWhere(userId)))
    .limit(1);
  if (!channel) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Channel not found or access denied",
    });
  }

  // The stack read is already dual-floored and matcher-faithful — reuse it
  // rather than re-deriving "which automations belong to this channel".
  const stack = await getChannelStack({ userId, channelId });

  let target = input.automationId
    ? (stack.automations.find((a) => a.id === input.automationId) ?? null)
    : pickPrimaryChannelAutomation(stack.automations);

  if (!target && input.automationId) {
    // An explicit automation that isn't bound to this channel is still a
    // legitimate sweep target (the user is wiring it up by hand), but it must
    // exist and be visible. `automations.trigger` re-gates it, so resolution
    // here only needs to name it.
    target = {
      id: input.automationId,
      name: null,
      enabled: true,
      binding: "workspace",
      triggerSummary: null,
    };
  }

  if (!target) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "No extraction automation is bound to this channel — bind one, or pass an explicit automationId.",
    });
  }

  // Message count in scope. Read through the USER-request door so the channel
  // visibility gate applies; `authorType = EXTERNAL` keeps it to inbound signal
  // (the same rows the signal pipeline classifies).
  const rows = await queryChannelMessages<{ id: string }>(db, {
    channelId,
    userId,
    order: "desc",
    limit,
    columns: { id: true },
    extraWhere: eq(messages.authorType, MessageAuthorType.EXTERNAL),
  });

  return {
    channelId,
    channelWorkspaceId: channel.workspaceId,
    boundEntityId: channel.contextObjectId,
    automationId: target.id,
    automationName: target.name,
    scanned: rows.length,
  };
}
