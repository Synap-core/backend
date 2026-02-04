/**
 * Create UnifiedEvent (duplicated from @synap/jobs to avoid circular dependency)
 *
 * This is a minimal implementation for BaseRepository to create completed events.
 * The full implementation is in @synap/jobs/types/unified-events.ts
 */

import { randomUUID } from "crypto";
import type { EnhancedEventMetadata } from "@synap-core/core";

export type EventPhase = "requested" | "validated" | "completed" | "denied";
export type EventAction =
  | "create"
  | "update"
  | "delete"
  | "archive"
  | "restore";
export type SubjectType =
  | "entity"
  | "document"
  | "workspace"
  | "view"
  | "relation"
  | "tag"
  | "project"
  | "proposal"
  | "message"
  | "user"
  | "role"
  | "apiKey"
  | "skill"
  | "backgroundTask"
  | "agent"
  | "chatThread"
  | "template"
  | "inboxItem"
  | "sharing";

export type GenericEventType<
  TSubjectType extends string,
  TAction extends EventAction,
  TPhase extends EventPhase,
> = `${TSubjectType}.${TAction}.${TPhase}`;

export interface UnifiedEventData {
  [key: string]: unknown;
}

export interface UnifiedEvent<
  TSubjectType extends string,
  TAction extends EventAction,
  TPhase extends EventPhase,
> {
  id: string;
  version: "v1";
  type: GenericEventType<TSubjectType, TAction, TPhase>;
  subjectId: string;
  subjectType: TSubjectType;
  data: UnifiedEventData;
  metadata?: EnhancedEventMetadata;
  userId: string;
  source:
    | "api"
    | "automation"
    | "sync"
    | "migration"
    | "system"
    | "intelligence"
    | "iot"
    | "enterprise";
  timestamp: Date;
  correlationId?: string;
  causationId?: string;
  requestId?: string;
}

/**
 * Create a UnifiedEvent instance (minimal version for BaseRepository)
 */
export function createUnifiedEvent<
  TSubjectType extends string,
  TAction extends EventAction,
  TPhase extends EventPhase,
>(params: {
  subjectType: TSubjectType;
  action: TAction;
  phase: TPhase;
  subjectId?: string;
  data: UnifiedEventData;
  metadata?: EnhancedEventMetadata;
  userId: string;
  source?: UnifiedEvent<TSubjectType, TAction, TPhase>["source"];
  correlationId?: string;
  causationId?: string;
  requestId?: string;
}): UnifiedEvent<TSubjectType, TAction, TPhase> {
  const type =
    `${params.subjectType}.${params.action}.${params.phase}` as GenericEventType<
      TSubjectType,
      TAction,
      TPhase
    >;

  return {
    id: randomUUID(),
    version: "v1",
    type,
    subjectId: params.subjectId || randomUUID(),
    subjectType: params.subjectType,
    data: params.data,
    metadata: params.metadata,
    userId: params.userId,
    source: params.source || "api",
    timestamp: new Date(),
    correlationId: params.correlationId,
    causationId: params.causationId,
    requestId: params.requestId,
  };
}
