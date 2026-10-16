/**
 * `emitTyped` — schema-validated, type-safe realtime event emit.
 *
 * Wraps the existing `emitChatEvent` bridge POST in a thin layer that:
 *   1. Constrains the event name to {@link EventName} (the
 *      {@link EventNames} registry from `@synap-core/types/events`).
 *   2. Infers the payload shape from the event name via {@link EventPayloadFor},
 *      so a typo in the event name OR a wrong-shaped payload is a TS error
 *      at the call site.
 *   3. Runtime-validates the payload against the matching Zod schema (when
 *      one exists). Throws on validation failure so producer bugs surface
 *      loud instead of silently emitting malformed data over the bridge.
 *
 * Why a wrapper, not a parallel emit path: the bridge HTTP POST + retry
 * logic already lives in {@link emitChatEvent}. Duplicating it would mean
 * double-maintenance. `emitTyped` is the call-site ergonomic layer; the
 * bridge stays the transport.
 */

import { getSchemaForEvent } from "@synap/events";
import type {
  EventName,
  EventPayloadFor,
  ImportFileProgressEvent,
  LibraryItemUpdate,
} from "@synap-core/types/events";
import { emitChatEvent } from "./chat-realtime-broadcast.js";

/**
 * Where to fan out the event. At least one field must be set — the bridge
 * rejects emits with no target room. Multiple fields broadcast to all
 * matching rooms (logical OR).
 */
export interface EmitTypedTarget {
  workspaceId?: string;
  viewId?: string;
  userId?: string;
  channelId?: string;
}

/**
 * Emit a realtime event with compile-time and runtime safety.
 *
 * @example
 * await emitTyped("synap:reply:routed", {
 *   channelId: "ch_1",
 *   messageId: "msg_1",
 *   targetPlatform: "telegram",
 *   excerpt: "on it",
 *   routedAt: new Date().toISOString(),
 * }, { userId });
 *
 * // The following is a compile-time error — wrong payload shape:
 * // await emitTyped("synap:reply:routed", { foo: 1 }, { userId });
 */
export async function emitTyped<E extends EventName>(
  event: E,
  data: EventPayloadFor<E>,
  target: EmitTypedTarget
): Promise<void> {
  if (
    !target.workspaceId &&
    !target.viewId &&
    !target.userId &&
    !target.channelId
  ) {
    throw new Error(
      `emitTyped("${event}") requires at least one target (workspaceId, viewId, userId, channelId).`
    );
  }

  const schema = getSchemaForEvent(event);
  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new Error(
        `emitTyped("${event}") payload validation failed: ${result.error.message}`
      );
    }
  }

  emitChatEvent({
    event,
    // Each typed payload is an object literal — cast through `unknown` to
    // satisfy emitChatEvent's untyped record contract without widening here.
    data: data as unknown as Record<string, unknown>,
    workspaceId: target.workspaceId ?? null,
    userId: target.userId ?? null,
    channelId: target.channelId ?? null,
    viewId: target.viewId ?? null,
  });
}

/**
 * Emit an `import:file:progress` event to the owning user's realtime room.
 *
 * @example
 * await emitImportFileProgress(
 *   { batchId, path, index: 0, total: 5, status: 'processing' },
 *   userId,
 * );
 */
export async function emitImportFileProgress(
  data: ImportFileProgressEvent,
  userId: string
): Promise<void> {
  return emitTyped("import:file:progress", data, { userId });
}

/**
 * Tell the OWNER's clients a Library item's read or media copy finished
 * (`library:item:updated`, the `user:<id>` room only — never a workspace
 * room: a kept item is the person's). Fire-and-forget: the item is already
 * written, so a payload or bridge failure is logged, never thrown — a client
 * that missed it still sees the item on its next read.
 *
 * `metadata` is the item's `documents.metadata` as the writer saw it: the
 * groups it is in come from `importCuration.groupIds`.
 */
export function emitLibraryItemUpdated(args: {
  userId: string;
  itemId: string;
  what: LibraryItemUpdate;
  metadata?: unknown;
}): void {
  const curation =
    args.metadata && typeof args.metadata === "object"
      ? (args.metadata as { importCuration?: { groupIds?: unknown } })
          .importCuration
      : undefined;
  const groupIds = Array.isArray(curation?.groupIds)
    ? curation.groupIds.filter(
        (g): g is string => typeof g === "string" && g.length > 0
      )
    : [];
  void emitTyped(
    "library:item:updated",
    {
      itemId: args.itemId,
      what: args.what,
      ...(groupIds.length ? { groupIds } : {}),
    },
    { userId: args.userId }
  ).catch((err: unknown) =>
    console.warn(
      `[library] library:item:updated NOT emitted for ${args.itemId}:`,
      err
    )
  );
}
