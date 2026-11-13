/**
 * Realtime Event Payload Schemas
 *
 * Zod schemas keyed by realtime event name. The Realtime bridge
 * (`@synap/realtime`'s `/bridge/emit`) and the `emitTyped` helper validate
 * payloads against these schemas before fanning out to Socket.IO clients.
 *
 * Coverage policy:
 *   - Every {actor}:{entity}:{action} event MUST have a schema. New events
 *     without one will not validate and will be rejected by emitTyped.
 *   - Legacy 2-segment events have schemas where they are stable and used by
 *     many call-sites (entity:*, chat:*, notification:new, ai:proposal). The
 *     rest fall back to `passthroughSchema` so we don't break older emitters.
 *
 * Adding a new event: add its name to {@link EventNames}, define its payload
 * type in `@synap-core/types/events`, then add the matching `z.object({...})`
 * here. The bridge picks it up automatically via `getSchemaForEvent`.
 */

import { z } from "zod";
import {
  LIBRARY_ITEM_UPDATES,
  STATUS_EVENT_SUBJECT_TYPES,
  type EventName,
} from "@synap-core/types/events";
import {
  LIFECYCLE_CATEGORIES,
  STATUS_SIGNALS,
} from "@synap-core/types/lifecycle";

// ============================================================================
// Yjs room meta: the `synap-room` map every realtime room may carry
// ============================================================================

/**
 * The Yjs room's meta map and its keys: ONE home, read by `@synap/realtime`
 * (`document-room.ts`, the room server) and `@synap/api` (the board read door,
 * `services/whiteboards/read-board-scene.ts`), which cannot import each other.
 * The client mirror is synap-app `packages/web/src/document/roomMeta.ts`; the
 * key sets must stay identical. Meanings: `document-room.ts`.
 */
export const ROOM_META_MAP = "synap-room";
export const ROOM_META_KEYS = {
  revision: "revision",
  seedRevision: "seedRevision",
  seedClaim: "seedClaim",
  loadError: "loadError",
  schemaVersion: "schemaVersion",
} as const;

/**
 * The realtime bridge's answer to `GET /yjs/:roomId/state` for an OPEN room
 * (`@synap/realtime` bridge.ts writes it, the api's board read door reads it).
 * `loadFailed` is the SERVER's flag that the room could not load the board's
 * saved content (never a key inside the Y.Doc, which clients can write): the
 * state is then not the board.
 */
export interface YjsRoomStateReply {
  roomId: string;
  state: string;
  encoding: "base64";
  byteLength: number;
  loadFailed?: true;
  loadError?: string;
}

/**
 * `POST /yjs/:roomId/apply` (BRIDGE_SECRET): write tldraw records into a
 * whiteboard, the place door's ONE write path (`@synap/api`
 * `services/whiteboards/place-on-board.ts` sends it, `@synap/realtime`
 * bridge.ts + yjs-server.ts apply it). The room is the board's
 * (`whiteboard-<documentId>`). Open room: one Y transaction in the live doc
 * (every client receives it), then saved at once. Closed: loaded from the
 * stored file and saved back, under the room's lock so a person opening the
 * board meanwhile loads the result. Records are put whole (same id =
 * replaced); `remove` deletes by id.
 */
export interface YjsRoomApplyRequest {
  documentId: string;
  /**
   * Records to CREATE. One whose id the board already holds is written only
   * while it is still pending and the same actor placed it; otherwise it is
   * left alone and reported in `skipped` (a shape the person kept is never
   * reset).
   */
  put?: Array<{ id: string; typeName: string } & Record<string, unknown>>;
  /**
   * Changes to shapes already there, merged into the LIVE record under the
   * room's lock (`planBoardApply`, `@synap-core/types/whiteboard`).
   */
  patch?: Array<{
    shapeId: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    props?: Record<string, unknown>;
  }>;
  /** Shape ids to delete: their children and bindings go with them. */
  remove?: string[];
  /** The Y transaction origin (who wrote it), e.g. `synap-place:<userId>`. */
  origin: string;
}

export interface YjsRoomApplyReply {
  roomId: string;
  applied: true;
  /** `live` = the open room (saved too); `stored` = the saved file. */
  target: "live" | "stored";
  put: number;
  /** Shapes changed in place. */
  patched: number;
  /** Records deleted (the removal closure). */
  removed: number;
  /** Created record ids left alone: the board holds them, kept. */
  skipped: string[];
}

/** Why an apply was refused (status → the bridge's HTTP answer). */
export const YJS_APPLY_FAILURES = {
  bad_request: 400,
  /** A patch or removal names a shape the board does not hold. */
  shape_not_found: 400,
  /** No such board document. */
  not_found: 404,
  /** The board's saved content failed to load: it takes no write. */
  load_failed: 409,
  /** Written in memory but the save did not land (retry is safe). */
  save_failed: 503,
  /** The Yjs server is not up yet. */
  unavailable: 503,
  /** The room's lock was held too long: the write MAY have landed. */
  timeout: 504,
} as const;
export type YjsApplyFailure = keyof typeof YJS_APPLY_FAILURES;

export interface YjsRoomApplyError {
  error: string;
  reason: YjsApplyFailure;
  roomId?: string;
}

// ============================================================================
// Pass-through schema for legacy events without a dedicated shape
// ============================================================================

/**
 * Accepts any object payload. Used for legacy events whose payloads are not
 * yet locked down — better to keep them flowing than to break consumers. New
 * events MUST NOT use this; define a real schema instead.
 */
const passthroughSchema = z.record(z.string(), z.unknown());

// ============================================================================
// {actor}:{entity}:{action} — strict schemas (new convention)
// ============================================================================

const externalMessagePlatformSchema = z.enum([
  "telegram",
  "whatsapp",
  "signal",
  "matrix",
  "discord",
  "voice",
]);

// Wire name `openclaw:message:received` is legacy — see ExternalMessageReceivedEvent.
const externalMessageReceivedSchema = z.object({
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  platform: externalMessagePlatformSchema,
  excerpt: z.string(),
  receivedAt: z.string().min(1),
});

const synapReplyRoutedSchema = z.object({
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  targetPlatform: z.string().min(1),
  excerpt: z.string(),
  routedAt: z.string().min(1),
});

const importFileProgressSchema = z.object({
  batchId: z.string().min(1),
  path: z.string(),
  index: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  status: z.enum(["processing", "done", "error"]),
  error: z.string().optional(),
});

const libraryItemUpdatedSchema = z.object({
  itemId: z.string().min(1),
  groupIds: z.array(z.string().min(1)).optional(),
  what: z.enum(LIBRARY_ITEM_UPDATES),
});

/**
 * The status events (`StatusTransitionEvent`, `StatusSignalRaisedEvent`) are
 * STRICT: a key beyond these (a hold, a reason, the mover, the watcher's
 * words) is refused here, at the realtime server's own check, so a later
 * emitter cannot widen what reaches each reader.
 */
const statusTransitionSchema = z.strictObject({
  subjectType: z.enum(STATUS_EVENT_SUBJECT_TYPES),
  subjectId: z.string().min(1),
  transitionId: z.string().min(1),
  role: z.string().min(1).nullable(),
  from: z.string().nullable(),
  to: z.string().min(1),
  category: z.enum(LIFECYCLE_CATEGORIES),
  at: z.string().min(1),
});

const statusSignalRaisedSchema = z.strictObject({
  subjectType: z.enum(STATUS_EVENT_SUBJECT_TYPES),
  subjectId: z.string().min(1),
  signal: z.enum(STATUS_SIGNALS),
  role: z.string().min(1).nullable(),
  beganAt: z.string().min(1),
  raisedAt: z.string().min(1),
});

const uiFocusSurfaceSchema = z.object({
  kind: z.enum(["cell", "view", "entity", "document", "channel", "app"]),
  cellKey: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  viewId: z.string().optional(),
  entityId: z.string().optional(),
  documentId: z.string().optional(),
  channelId: z.string().optional(),
  appId: z.string().optional(),
  placement: z.enum(["main", "side"]).optional(),
  title: z.string().optional(),
  workspaceId: z.string().optional(),
});

const uiFocusSchema = z.object({
  surface: uiFocusSurfaceSchema,
});

// ============================================================================
// Legacy schemas — added for the high-volume, well-typed emitters
// ============================================================================
//
// Other legacy events (document:updated, document:version, ai:proposal:status,
// chat:message) are deliberately NOT schema-locked here: their payloads are
// still in flux at multiple call sites. The bridge passes them through
// unchanged via the absence of a schema entry. Lock them down in a follow-up
// once each emitter is audited.

const entityCreatedSchema = z
  .object({
    entityId: z.string().min(1),
    workspaceId: z.string().min(1),
    type: z.string().min(1),
    title: z.string(),
    createdBy: z.string(),
    createdAt: z.string().min(1),
  })
  // entity, optimistic-update payload, may be present
  .loose();

const entityUpdatedSchema = z
  .object({
    entityId: z.string().min(1),
    workspaceId: z.string().min(1),
    changes: z.record(z.string(), z.unknown()),
    updatedBy: z.string(),
    updatedAt: z.string().min(1),
  })
  .loose();

const entityDeletedSchema = z
  .object({
    entityId: z.string().min(1),
    workspaceId: z.string().min(1),
    deletedBy: z.string(),
    deletedAt: z.string().min(1),
  })
  .loose();

const chatStreamSchema = z
  .object({
    threadId: z.string().min(1),
  })
  // streaming payload varies (chunk/step/complete/error variants share the room)
  .loose();

const aiProposalSchema = z.object({
  proposalId: z.string().min(1),
  threadId: z.string().min(1),
  messageId: z.string().min(1),
  toolName: z.string().min(1),
  description: z.string(),
  agentUserId: z.string().optional(),
});

// ============================================================================
// Registry
// ============================================================================

/**
 * Schema registry keyed by realtime event name. Use {@link getSchemaForEvent}
 * to look up by string — it handles both known and unknown names.
 *
 * Type: `Partial<Record<EventName, ...>>` because not every legacy event has
 * a locked-down schema yet.
 */
export const EventSchemas: Partial<Record<EventName, z.ZodType>> = {
  // {actor}:{entity}:{action}
  "openclaw:message:received": externalMessageReceivedSchema,
  "synap:reply:routed": synapReplyRoutedSchema,
  "import:file:progress": importFileProgressSchema,
  "library:item:updated": libraryItemUpdatedSchema,
  "status:transition:completed": statusTransitionSchema,
  "status:signal:raised": statusSignalRaisedSchema,
  "ui:focus": uiFocusSchema,

  // Legacy (locked-down)
  "entity:created": entityCreatedSchema,
  "entity:updated": entityUpdatedSchema,
  "entity:deleted": entityDeletedSchema,
  "chat:stream": chatStreamSchema,
  "ai:proposal": aiProposalSchema,
};

/** Exposed for callers that want to validate against the same shape as the bridge. */
export { passthroughSchema };

/**
 * Look up a schema by event name. Returns `undefined` for unknown events so
 * the bridge can pass them through unchanged (backwards-compat).
 */
export function getSchemaForEvent(name: string): z.ZodType | undefined {
  return EventSchemas[name as EventName];
}

/**
 * Result of validating an inbound bridge emit payload against the schema
 * registry — what the realtime server's `/bridge/emit` answers 400 on.
 *
 * Contract: legacy events without a schema fall through with `ok: true`.
 * The bridge MUST stay backwards-compatible with old emitters.
 */
export type ValidateEmitResult = { ok: true } | { ok: false; issues: unknown };

/**
 * Apply the realtime schema (if any) to a payload. Returns `{ ok: true }`
 * when no schema is registered for `event` — that's the legacy pass-through.
 * The realtime bridge (`@synap/realtime`) calls this on every emit; the pod's
 * emitters pin their payloads against it.
 */
export function validateEmitPayload(
  event: string,
  data: unknown
): ValidateEmitResult {
  const schema = getSchemaForEvent(event);
  if (!schema) return { ok: true };
  const result = schema.safeParse(data);
  if (result.success) return { ok: true };
  return { ok: false, issues: result.error.issues };
}
