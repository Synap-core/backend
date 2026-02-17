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
export declare const SUBJECT_TYPES: readonly ["entity", "document", "workspace", "view", "relation", "tag", "project", "proposal", "message", "user", "role", "apiKey", "skill", "backgroundTask", "agent", "chatThread", "template", "inboxItem", "sharing", "workspaceMember", "projectMember"];
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export declare const EVENT_ACTIONS: readonly ["create", "update", "delete", "archive", "restore"];
export type EventAction = (typeof EVENT_ACTIONS)[number];
export declare const EVENT_PHASES: readonly ["requested", "validated", "completed", "denied"];
export type EventPhase = (typeof EVENT_PHASES)[number];
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
export declare function buildEventName<S extends SubjectType, A extends EventAction, P extends EventPhase>(subject: S, action: A, phase: P): `${S}.${A}.${P}`;
/**
 * Generate the Inngest trailing-wildcard trigger string for a subject type.
 * Inngest dev only supports trailing wildcards (e.g. "entity.*"), not middle wildcards.
 *
 * @example
 * subjectTrigger("entity") // { event: "entity.*" }
 */
export declare function subjectTrigger(subject: SubjectType): {
    event: string;
};
//# sourceMappingURL=unified.d.ts.map