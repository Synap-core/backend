/**
 * Unified Event Type System
 *
 * Single source of truth for backend event naming.
 * Pattern: {subjectType}.{action}.{phase}
 *
 * Rules:
 * - subjectType is ALWAYS singular (each event is about ONE specific object instance)
 * - DDD / Stripe / GitHub / AWS all use singular noun events
 * - Template literal type EventName makes invalid event names impossible to construct
 *
 * Used by: @synap/jobs (Inngest workers), @synap/database (BaseRepository),
 *           @synap/api (emit-event), and frontend event listeners.
 */

// ============================================================================
// SUBJECT TYPES — always singular
// ============================================================================

export const SUBJECT_TYPES = [
  "entity",
  "document",
  "workspace",
  "view",
  "relation",
  "tag",
  "project",
  "proposal",
  "message",
  "user",
  "role",
  "apiKey",
  "skill",
  "backgroundTask",
  "agent",
  "chatThread",
  "template",
  "inboxItem",
  "sharing",
  "workspaceMember",
  "projectMember",
] as const;

export type SubjectType = (typeof SUBJECT_TYPES)[number];

// ============================================================================
// EVENT ACTIONS
// ============================================================================

export const EVENT_ACTIONS = [
  "create",
  "update",
  "delete",
  "archive",
  "restore",
] as const;

export type EventAction = (typeof EVENT_ACTIONS)[number];

// ============================================================================
// EVENT PHASES — lifecycle stages
// ============================================================================

export const EVENT_PHASES = [
  "requested",
  "validated",
  "completed",
  "denied",
] as const;

export type EventPhase = (typeof EVENT_PHASES)[number];

// ============================================================================
// TYPE-SAFE EVENT NAME
// ============================================================================

/**
 * Template literal type — impossible to create an invalid event name.
 *
 * @example
 * const name: EventName = "entity.create.requested"; // ✓
 * const bad: EventName = "entities.create.requested"; // ✗ Type error
 */
export type EventName = `${SubjectType}.${EventAction}.${EventPhase}`;

/**
 * Build a type-safe event name at compile time.
 *
 * @example
 * buildEventName("entity", "create", "requested") // "entity.create.requested"
 */
export function buildEventName<
  S extends SubjectType,
  A extends EventAction,
  P extends EventPhase,
>(subject: S, action: A, phase: P): `${S}.${A}.${P}` {
  return `${subject}.${action}.${phase}`;
}

// ============================================================================
// INNGEST TRIGGER HELPERS
// ============================================================================

/**
 * Generate the Inngest trailing-wildcard trigger string for a subject type.
 * Inngest dev only supports trailing wildcards (e.g. "entity.*"), not middle wildcards.
 *
 * @example
 * subjectTrigger("entity") // { event: "entity.*" }
 */
export function subjectTrigger(subject: SubjectType): { event: string } {
  return { event: `${subject}.*` };
}
