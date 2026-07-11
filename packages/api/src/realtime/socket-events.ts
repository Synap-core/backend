/**
 * SERVER_CONVERSATION_EVENTS — typed SSOT for the Socket.IO event NAMES the
 * backend emits for the conversation / AI-streaming / presence / proposal
 * surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * The realtime contract between backend (emitter) and frontend (subscriber) is
 * a set of bare strings crossing a repo boundary with no compiler to check them.
 * A rename on one side, or a subscriber guessing a name the server never emits,
 * silently breaks a live feature with no build error — exactly the
 * `proposal.new` / `proposal.created` phantom-event bug that left the proposals
 * badge dead (the frontend subscribed to names the backend never emitted).
 *
 * This const is the emitter half of the fix. The subscriber half lives in
 * `synap-app/packages/synap-client/src/socket/conversation-events.ts`
 * (`SUBSCRIBED_CONVERSATION_EVENTS`). A cross-repo tripwire
 * (`src/__tripwires__/socket-event-consistency.test.ts`) reads BOTH files and
 * fails if the frontend subscribes to a name this file does not emit — turning
 * the phantom-event class of bug into a red test instead of a silent miss.
 *
 * SCOPE
 * -----
 * Only the convergence-relevant conversation set. Entity / view / document /
 * collab-cursor events are intentionally out of scope and NOT enumerated here.
 *
 * KEEPING IT HONEST
 * -----------------
 * Every value below is the exact string the backend actually emits. When you
 * add or rename an emitted conversation event, update this const AND the
 * frontend SSOT, or the tripwire goes red.
 *
 * Emit-site map (where each name is broadcast today):
 * - chat:stream, chat:message  → routers/channels.ts via `EventNames.CHAT_STREAM`
 *                                / `EventNames.CHAT_MESSAGE` (already the SSOT in
 *                                @synap-core/types; mirrored here as literals so
 *                                the fs-based tripwire can read them — see the
 *                                drift guard at the bottom of this file).
 * - chat:stream:error          → routers/channels.ts (streaming failure paths).
 * - ai:step                    → routers/channels.ts (tool/thinking steps).
 * - branch_decision            → routers/channels.ts (orchestrator auto-dispatch).
 * - route_to_channel           → routers/channels.ts (context-scoped routing).
 * - teammate:answering         → routers/channels.ts (AI "is answering" presence).
 * - proposal:reviewed          → routers/proposals.ts (approve/reject/reopen).
 * - notification:new           → notifications/NotificationService.ts (bell feed).
 * - presence:init/update,
 *   user:joined/left           → @synap/realtime (server.ts, collaboration-manager.ts).
 *                                That package sits BELOW @synap/api in the dep
 *                                graph, so its emit sites can't import this const
 *                                without a dependency inversion. The names are
 *                                enumerated here (documenting the emitted contract
 *                                for the tripwire); the emit literals stay in
 *                                @synap/realtime.
 */

import { EventNames } from "@synap-core/types/events";

export const SERVER_CONVERSATION_EVENTS = {
  /** AI response streaming chunks/completion (channel:<id> room). */
  CHAT_STREAM: "chat:stream",
  /** A persisted chat message was created (channel:<id> room). */
  CHAT_MESSAGE: "chat:message",
  /** Streaming failed; `fallback` flag distinguishes soft vs hard failure. */
  CHAT_STREAM_ERROR: "chat:stream:error",
  /** An AI tool-call / thinking step during a stream turn. */
  AI_STEP: "ai:step",
  /** Orchestrator auto-dispatched a specialist sub-agent. */
  BRANCH_DECISION: "branch_decision",
  /** Orchestrator routed the conversation to a context-scoped channel. */
  ROUTE_TO_CHANNEL: "route_to_channel",
  /** A teammate/agent is answering — drives the "is answering" indicator. */
  TEAMMATE_ANSWERING: "teammate:answering",
  /** A proposal was approved, rejected, or reopened. */
  PROPOSAL_REVIEWED: "proposal:reviewed",
  /** Generic bell notification (filter on data.notification.sourceType). */
  NOTIFICATION_NEW: "notification:new",
  /** Initial "who's online" snapshot on connect (@synap/realtime). */
  PRESENCE_INIT: "presence:init",
  /** A user's presence changed (@synap/realtime). */
  PRESENCE_UPDATE: "presence:update",
  /** A user joined a view room (@synap/realtime). */
  USER_JOINED: "user:joined",
  /** A user left a view room (@synap/realtime). */
  USER_LEFT: "user:left",
} as const;

export type ServerConversationEvent =
  (typeof SERVER_CONVERSATION_EVENTS)[keyof typeof SERVER_CONVERSATION_EVENTS];

// -----------------------------------------------------------------------------
// Drift guard — chat:stream / chat:message are ALSO declared canonically in
// `EventNames` (@synap-core/types) and emitted through those constants. The
// literals above are mirrors so the filesystem-based tripwire can read them.
// These compile-time checks fail if the mirrored literal ever diverges from the
// canonical EventNames value, so the two can never silently drift apart.
// -----------------------------------------------------------------------------
const _chatStreamInSync: typeof EventNames.CHAT_STREAM =
  SERVER_CONVERSATION_EVENTS.CHAT_STREAM;
const _chatMessageInSync: typeof EventNames.CHAT_MESSAGE =
  SERVER_CONVERSATION_EVENTS.CHAT_MESSAGE;
void _chatStreamInSync;
void _chatMessageInSync;
