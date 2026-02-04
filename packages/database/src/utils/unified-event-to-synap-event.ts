/**
 * UnifiedEvent to SynapEvent Conversion
 *
 * Converts UnifiedEvent (new format) to SynapEvent (database format)
 * This allows BaseRepository to use the unified event system while
 * maintaining compatibility with EventRepository.append()
 */

import type { SynapEvent } from "@synap-core/core";
import type {
  UnifiedEvent,
  EventPhase,
  EventAction,
  SubjectType,
} from "./create-unified-event.js";

/**
 * Convert UnifiedEvent to SynapEvent format
 *
 * UnifiedEvent is the new type-safe format for Inngest events.
 * SynapEvent is the database storage format (validated by SynapEventSchema).
 */
export function unifiedEventToSynapEvent(
  event: UnifiedEvent<SubjectType, EventAction, EventPhase>
): SynapEvent {
  return {
    id: event.id,
    version: event.version,
    type: event.type,
    subjectId: event.subjectId,
    subjectType: event.subjectType,
    data: event.data as Record<string, unknown>,
    metadata: event.metadata as Record<string, unknown> | undefined,
    userId: event.userId,
    source: event.source as
      | "api"
      | "automation"
      | "sync"
      | "migration"
      | "system"
      | "intelligence",
    timestamp:
      event.timestamp instanceof Date
        ? event.timestamp
        : new Date(event.timestamp),
    correlationId: event.correlationId,
    causationId: event.causationId,
    requestId: event.requestId,
  };
}
