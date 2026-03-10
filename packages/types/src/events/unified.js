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
];
// ============================================================================
// EVENT ACTIONS
// ============================================================================
export const EVENT_ACTIONS = [
  "create",
  "update",
  "delete",
  "archive",
  "restore",
];
// ============================================================================
// EVENT PHASES — lifecycle stages
// ============================================================================
export const EVENT_PHASES = ["requested", "validated", "completed", "denied"];
/**
 * Build a type-safe event name at compile time.
 *
 * @example
 * buildEventName("entity", "create", "requested") // "entity.create.requested"
 */
export function buildEventName(subject, action, phase) {
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
export function subjectTrigger(subject) {
  return { event: `${subject}.*` };
}
//# sourceMappingURL=unified.js.map
