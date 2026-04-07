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

// ============================================================================
// RUNTIME VALIDATION (Zod-free — no Zod dep in this package)
// ============================================================================

/**
 * Valid automation event patterns:
 *   - Exact:              "entity.create.completed"
 *   - Action wildcard:   "entity.create.*"
 *   - Full wildcard:     "entity.*"
 *
 * All three levels are supported by the trigger matcher's matchPattern().
 */
export type EventPattern =
  | EventName
  | `${SubjectType}.${EventAction}.*`
  | `${SubjectType}.*`;

/**
 * Validate that a string is a valid event pattern at runtime.
 * Use this in API routes before persisting automation triggerConfig.
 *
 * Returns the validated pattern or throws a descriptive error.
 *
 * @example
 * validateEventPattern("entity.create.completed") // ✓ returns it
 * validateEventPattern("entities.create.validated") // ✗ throws
 */
export function validateEventPattern(raw: string): EventPattern {
  const parts = raw.split(".");

  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `Invalid event pattern "${raw}": must be "subject.action" or "subject.action.phase" (with optional trailing "*").`
    );
  }

  const [subject, action, phase] = parts;

  if (!SUBJECT_TYPES.includes(subject as SubjectType)) {
    throw new Error(
      `Invalid event pattern "${raw}": subject "${subject}" is not a recognised SubjectType. ` +
        `Valid subjects (always singular): ${SUBJECT_TYPES.join(", ")}.`
    );
  }

  if (action === "*") {
    // "entity.*" — valid full wildcard
    if (phase !== undefined) {
      throw new Error(
        `Invalid event pattern "${raw}": cannot have more segments after a "*" wildcard.`
      );
    }
    return raw as EventPattern;
  }

  if (!EVENT_ACTIONS.includes(action as EventAction)) {
    throw new Error(
      `Invalid event pattern "${raw}": action "${action}" is not a recognised EventAction. ` +
        `Valid actions: ${EVENT_ACTIONS.join(", ")}.`
    );
  }

  if (phase === undefined || phase === "*") {
    // "entity.create" or "entity.create.*" — valid action wildcard
    return raw as EventPattern;
  }

  if (!EVENT_PHASES.includes(phase as EventPhase)) {
    throw new Error(
      `Invalid event pattern "${raw}": phase "${phase}" is not a recognised EventPhase. ` +
        `Valid phases: ${EVENT_PHASES.join(", ")}. ` +
        `Most automations should use "completed" (the mutation succeeded).`
    );
  }

  return raw as EventPattern;
}

/**
 * Same as validateEventPattern but returns a { ok, error } result instead of throwing.
 */
export function parseEventPattern(
  raw: string
): { ok: true; value: EventPattern } | { ok: false; error: string } {
  try {
    return { ok: true, value: validateEventPattern(raw) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
