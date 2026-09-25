/**
 * Chat real-time broadcast via Realtime server bridge
 *
 * The API server does not have Socket.IO in context. We POST to the Realtime
 * server's /bridge/emit endpoint so chat events (stream, message, thread:created, etc.)
 * are delivered to connected clients on the /presence namespace.
 *
 * Reliability: up to MAX_RETRIES attempts with exponential backoff.
 * A 5-second total deadline prevents slow retries from accumulating.
 * Failures are warned but never throw — the API response must not be blocked.
 *
 * AUDIENCE — an event about a CHANNEL never goes to `workspace:<id>`. The bridge
 * fans a `workspaceId` out to every socket of every workspace member, which is
 * wider than the channel's read rule for a private thread, a personal channel
 * and a roster-only session room (`channelVisibilityWhere`). So, at this one
 * door, whatever the caller passed:
 *   - stream-class events (chunks, steps, "is answering") → the channel room
 *     (`channel:<id>`, joined through the SAME predicate by `@synap/realtime`)
 *     + the acting user's room. No per-chunk DB read.
 *   - every other channel event (the durable `chat:message`, channel lifecycle,
 *     inbound excerpts) → the channel room + the `user:<id>` room of EACH user
 *     the read predicate admits (`listChannelAudienceUserIds`), so a reader who
 *     has not opened the room (channel list, previews, the global cache patch)
 *     still updates — and nobody else does.
 * A channel named only in the PAYLOAD (not the explicit `channelId`) is
 * honoured only when the actor is one of its readers — `POST /events/broadcast`
 * relays caller-shaped data. If the audience read FAILS, nothing fans out to
 * the readers (channel room when explicit, else the actor only) and the failure
 * is logged — a failed read is not "everyone".
 */

import { dispatchWebhooksForEvent } from "./webhook-delivery.js";
import { notifyChatTurnObserver } from "./chat-turn-observer.js";
import { db } from "@synap/database";
import { listChannelAudienceUserIds } from "./channel-visibility.js";
import { SERVER_CONVERSATION_EVENTS as E } from "../realtime/socket-events.js";

/**
 * High-frequency / transient events of an open conversation: delivered to the
 * channel room only (plus the actor). Their only consumers live in a surface
 * that has joined the room (`useChannelStream`, `useTeammateAnswering`).
 */
const CHANNEL_ROOM_ONLY_EVENTS: ReadonlySet<string> = new Set([
  E.CHAT_STREAM,
  E.CHAT_STREAM_ERROR,
  E.AI_STEP,
  E.AI_PROPOSAL,
  E.BRANCH_DECISION,
  E.ROUTE_TO_CHANNEL,
  E.TEAMMATE_ANSWERING,
]);

/** A channel id carried in the payload (`channelId`, or legacy `threadId`). */
function channelIdInData(data: Record<string, unknown>): string | null {
  const id = data.channelId ?? data.threadId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function getRealtimeUrl(): string {
  return process.env.REALTIME_URL || "http://localhost:4001";
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 50;
/** Total time budget across all retry attempts (ms) */
const TOTAL_DEADLINE_MS = 5_000;

export interface ChatBroadcastOptions {
  event: string;
  data: Record<string, unknown>;
  workspaceId?: string | null;
  userId?: string | null;
  /** Target a specific channel room (e.g. for stream events). Reduces noise for other clients. */
  channelId?: string | null;
  /** Target a view room (e.g. for view-scoped realtime updates). */
  viewId?: string | null;
}

/**
 * Headers every POST to the realtime bridge carries. `bridgeSecretOk`
 * (`@synap/realtime` bridge.ts) 401s a request without `X-Bridge-Secret` the
 * moment `BRIDGE_SECRET` is set — a bridge client that omits it goes silently
 * dark on exactly the deploys that turned auth on.
 */
export function bridgeRequestHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(process.env.BRIDGE_SECRET
      ? { "X-Bridge-Secret": process.env.BRIDGE_SECRET }
      : {}),
  };
}

async function attemptEmit(
  url: string,
  body: string,
  signal: AbortSignal
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: bridgeRequestHeaders(),
      body,
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Emit a chat event to connected clients via the Realtime bridge.
 * Fire-and-forget: we do not await so the API response is not blocked.
 * Retries up to MAX_RETRIES times with exponential backoff within TOTAL_DEADLINE_MS.
 * At least one of workspaceId, userId, or channelId must be set.
 */
export function emitChatEvent(options: ChatBroadcastOptions): void {
  const { event, data, workspaceId, userId, channelId, viewId } = options;
  // The sender's SSE connection observes this exact event in-process. This is
  // deliberately synchronous and best-effort; the existing bridge remains the
  // observer transport for all other surfaces.
  notifyChatTurnObserver(options);
  if (!workspaceId && !userId && !channelId && !viewId) return;

  // Fan out to webhook subscribers (fire-and-forget, never blocks)
  dispatchWebhooksForEvent(event, data);

  // An explicit `channelId` comes from an internal door that already
  // authorized the channel; one only found in the payload may be caller-shaped
  // (`POST /events/broadcast` relays IS-supplied data), so it is trusted only
  // after the actor is proven a reader (below).
  const explicitChannel = channelId || null;
  const payloadChannel = explicitChannel ? null : channelIdInData(data);

  if (CHANNEL_ROOM_ONLY_EVENTS.has(event)) {
    // Never the workspace room; the channel room only when explicitly targeted.
    if (!explicitChannel && !userId) return;
    sendWithRetry(
      event,
      JSON.stringify({
        event,
        data,
        ...(explicitChannel && { channelId: explicitChannel }),
        ...(userId && { userId }),
      })
    );
    return;
  }

  const aboutChannel = explicitChannel ?? payloadChannel;
  if (!aboutChannel) {
    sendWithRetry(
      event,
      JSON.stringify({
        event,
        data,
        ...(workspaceId && { workspaceId }),
        ...(userId && { userId }),
        ...(viewId && { viewId }),
      })
    );
    return;
  }

  // Channel event: never the workspace room (see AUDIENCE above).
  const channelBody = JSON.stringify({
    event,
    data,
    channelId: aboutChannel,
    ...(userId && { userId }),
    ...(viewId && { viewId }),
  });
  const actorOnly = userId
    ? JSON.stringify({ event, data, userId, ...(viewId && { viewId }) })
    : null;

  // Run in background — never blocks caller
  void (async () => {
    let audience: string[];
    try {
      audience = await listChannelAudienceUserIds(db, aboutChannel);
    } catch (err) {
      console.warn(
        `[Chat] Audience read failed for '${event}' on channel ${aboutChannel}; not fanning out to its readers`,
        err
      );
      if (explicitChannel) sendWithRetry(event, channelBody);
      else if (actorOnly) sendWithRetry(event, actorOnly);
      return;
    }
    // A payload-named channel the actor cannot read is not theirs to broadcast into.
    if (!explicitChannel && !(userId && audience.includes(userId))) {
      if (actorOnly) sendWithRetry(event, actorOnly);
      return;
    }
    sendWithRetry(event, channelBody);
    for (const member of audience) {
      if (member === userId) continue; // already reached by channelBody
      sendWithRetry(event, JSON.stringify({ event, data, userId: member }));
    }
  })();
}

/** POST one bridge body in the background, with bounded retries. */
function sendWithRetry(event: string, body: string): void {
  const url = `${getRealtimeUrl()}/bridge/emit`;
  void (async () => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), TOTAL_DEADLINE_MS);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((r) =>
          setTimeout(r, BASE_BACKOFF_MS * Math.pow(2, attempt - 1))
        );
      }
      if (controller.signal.aborted) break;

      const ok = await attemptEmit(url, body, controller.signal);
      if (ok) {
        clearTimeout(deadline);
        return;
      }
    }

    clearTimeout(deadline);
    console.warn(
      `[Chat] Failed to broadcast '${event}' after ${MAX_RETRIES} attempts`
    );
  })();
}
