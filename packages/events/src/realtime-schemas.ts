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
import type { EventName } from "@synap-core/types/events";

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

const openClawPlatformSchema = z.enum([
  "telegram",
  "whatsapp",
  "signal",
  "matrix",
  "discord",
  "voice",
]);

const openclawMessageReceivedSchema = z.object({
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  platform: openClawPlatformSchema,
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
  "openclaw:message:received": openclawMessageReceivedSchema,
  "synap:reply:routed": synapReplyRoutedSchema,
  "import:file:progress": importFileProgressSchema,
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
