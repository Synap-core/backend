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
  "agent",
  "agentRun",
  "chatThread",
  "template",
  "inboxItem",
  "sharing",
  "workspaceMember",
  "projectMember",
] as const;

export type SubjectType = (typeof SUBJECT_TYPES)[number];

// ============================================================================
// CONNECTOR / SYSTEM EVENT FAMILIES — outside the CRUD taxonomy
// ============================================================================

/**
 * Event families emitted by connectors and system flows (inbound messages,
 * channel relays, connector syncs, captures, proactive posts, feed items).
 *
 * They intentionally live OUTSIDE the CRUD taxonomy: their "action" segment is
 * a domain verb (`received`, `synced`, …) rather than create/update/delete, so
 * the strict subject+action+phase rules below do NOT apply. The runtime
 * automation-trigger matcher (@synap/jobs) matches these as raw string
 * patterns, so `validateEventPattern` must accept them at create-time too —
 * otherwise a perfectly matchable automation (e.g. inbound-message →
 * `external_message.received.*`) is rejected at the API boundary.
 *
 * Keep in sync with the prefixes special-cased in
 * `automation-trigger-matcher.ts` (matchTriggerSpecificFilters).
 */
export const CONNECTOR_SUBJECT_TYPES = [
  "external_message",
  "channel_message",
  "connector_sync",
  "capture",
  "proactive",
  "feed",
] as const;

export type ConnectorSubjectType = (typeof CONNECTOR_SUBJECT_TYPES)[number];

/**
 * The synthetic message-alias patterns. `message.received` is the documented
 * cross-transport proactive-from-messages trigger — it fires for BOTH physical
 * message events (`external_message.*` and `channel_message.*`) without binding
 * to one transport. `message.sent` is the outbound counterpart, added for the
 * `message.sent` channel-activity fact (see `unified.ts` events log). `message.*`
 * also validates as a plain full wildcard, but is listed here so the whole alias
 * set is a SINGLE source of truth.
 *
 * The action segments `received`/`sent` are domain verbs outside the CRUD vocab,
 * so `validateEventPattern` must accept this set explicitly (below) — otherwise
 * the authoring door rejects the very patterns the runtime matcher is built to
 * match. The runtime matcher (`matchesMessageAlias` in @synap/jobs) matches this
 * EXACT set; it consumes this constant (re-exported through @synap/database)
 * rather than re-listing it, so validator and matcher can never drift.
 *
 * NOTE: unlike the physical `external_message.*`/`channel_message.*` events
 * `matchesMessageAlias` exists to bridge, the literal `message.received` /
 * `message.sent` event rows the channel/message-activity log emits already
 * begin with the `message.` prefix, so the generic trailing-wildcard walk in
 * `matchPattern` matches them against every pattern here WITHOUT needing an
 * entry in `MESSAGE_ALIAS_EVENT_TYPES` — that list stays physical-types-only.
 */
export const MESSAGE_ALIAS_PATTERNS = [
  "message.received",
  "message.received.*",
  "message.sent",
  "message.sent.*",
  "message.*",
] as const;

/**
 * Registered OBSERVATION namespaces — the raw `<namespace>.<rest>` types the
 * hub-protocol observations door accepts (`dev.commit`, `ci.workflow_run`, …).
 *
 * They live HERE, not in the api package, for the same reason
 * `MESSAGE_ALIAS_PATTERNS` does: an observation can FIRE an automation (the
 * unified trigger hop enqueues `automation-trigger-match` with the raw type),
 * and the runtime matcher's `matchPattern` handles them as plain dotted strings
 * — so `validateEventPattern` MUST accept them at create-time too. Otherwise the
 * trigger hop fans out to a receiver set that can never be populated: every
 * automation able to receive an observation is rejected at the authoring door.
 *
 * That is not hypothetical — it is the SECOND time this exact split has bitten
 * (`message.received` was the first, and its comment above states the same
 * invariant). One constant, consumed by both the door and the validator, is what
 * makes drift impossible.
 *
 * `packages/api/.../hub-protocol/observations.ts` re-exports this; add a
 * namespace here and both sides move together. Keep them coarse (one per
 * producing system), never per-event-type, and disjoint from every first-party /
 * governance namespace (tripwire: `observations-not-a-governance-input.test.ts`).
 */
export const OBSERVATION_NAMESPACES = [
  /** Local development tooling — commits, gate runs, deploys (`./dev`). */
  "dev",
  /** Continuous integration — workflow runs, build results. */
  "ci",
] as const;

export type ObservationNamespace = (typeof OBSERVATION_NAMESPACES)[number];

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
  EventName | `${SubjectType}.${EventAction}.*` | `${SubjectType}.*`;

/**
 * DOMAIN-VERB SUBJECTS — first-party subjects whose event ACTIONS are domain
 * verbs rather than the CRUD five, exactly like the connector family above.
 *
 * 🔴 Why this exists. `validateEventPattern` is the AUTHORING GATE: the
 * automation create door runs it on every incoming trigger, so a pattern it
 * rejects can never be authored, by any door, ever. It was narrower than the
 * event catalog the system actually emits — measured, 13 of the 26 types
 * declared in `@synap/events`' `event-types.ts` were rejected — so half the
 * pod's own events were unreachable as triggers. A rule "when a proposal is
 * approved" or "when a notification is created" could not be written at all.
 *
 * These six subjects appear in the catalog and in neither list: `command`,
 * `external_channel`, `focus_session`, `inbox_item`, `messaging_account`,
 * `notification`. (`SUBJECT_TYPES` carries `inboxItem`; the catalog emits
 * `inbox_item` — a spelling fork, and the catalog is the one the runtime
 * matches on.)
 *
 * Kept SEPARATE from `SUBJECT_TYPES` deliberately: that list is the CRUD
 * subject vocabulary and widening it would let `entity.created.completed`-shaped
 * past-tense patterns back through the strict action check. These bypass the
 * action check the same way connectors do, and nothing else changes.
 *
 * Guarded by `packages/types/src/events/catalog-parity.tripwire.test.ts`, which
 * runs BOTH the declared catalog AND every literal `(subjectType, action)` pair
 * at an `emitSideEffects(...)` call site through this validator — so a new event
 * turns that test red instead of silently becoming unauthorable.
 *
 * ⚠️ The CATALOG and the RUNTIME are two different things, and only the second
 * one fires. `event-types.ts` DECLARES types; the reactor
 * (`packages/events/src/side-effects.ts`) CONSTRUCTS the pattern it matches on as
 * `` `${payload.subjectType}.${payload.action}.completed` `` from the emit site's
 * own values. Validating the catalog alone proved a declaration, not a behaviour
 * — `external_webhook`, `hydration` and `tool` are emitted at real call sites and
 * appear in no catalog entry, so they were still unauthorable after the catalog
 * was made to pass. Check the emit sites.
 */
export const DOMAIN_SUBJECT_TYPES = [
  "command",
  "external_channel",
  "external_webhook",
  "focus_session",
  "hydration",
  "inbox_item",
  "messaging_account",
  "notification",
  "tool",
] as const;

export type DomainSubjectType = (typeof DOMAIN_SUBJECT_TYPES)[number];

/**
 * Extra, non-CRUD actions a STRICT subject legitimately emits.
 *
 * `proposal` and `user` ARE `SUBJECT_TYPES`, so they reach the strict action
 * check — and the catalog emits `proposal.approved`, `proposal.created`,
 * `proposal.rejected`, `user.updated`, none of which are in `EVENT_ACTIONS`.
 *
 * Narrow on purpose: adding `created`/`updated` to `EVENT_ACTIONS` globally
 * would make `entity.created.completed` validate again, and no emitter produces
 * that — it is the past-tense pattern the sentence grammar's mood bridge exists
 * to prevent. A per-subject allowance accepts exactly what is emitted and
 * nothing more.
 */
const SUBJECT_EXTRA_ACTIONS: Record<string, readonly string[]> = {
  proposal: ["approved", "created", "rejected"],
  user: ["updated"],
};

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

  // Synthetic message alias (`message.received` / `message.received.*` /
  // `message.*`): a documented cross-transport trigger whose action segment is
  // the domain verb "received", outside the CRUD vocab. `subject === "message"`
  // is otherwise a real CRUD subject, so this must be accepted BEFORE the strict
  // action check below rejects "received". The runtime matcher matches this exact
  // set (matchesMessageAlias) — both sides consume MESSAGE_ALIAS_PATTERNS.
  if ((MESSAGE_ALIAS_PATTERNS as readonly string[]).includes(raw)) {
    return raw as EventPattern;
  }

  // Observation namespaces (`dev.*`, `ci.*`): raw producer-defined types that the
  // trigger hop enqueues verbatim and the runtime matcher matches as plain dotted
  // strings. Accepted before the SubjectType check — "dev" is deliberately NOT a
  // SubjectType (an observation is not a first-party domain event), so without
  // this the authoring door rejects every automation capable of receiving one.
  if ((OBSERVATION_NAMESPACES as readonly string[]).includes(subject)) {
    return raw as EventPattern;
  }

  // Connector / system event families bypass the strict CRUD action/phase vocab
  // (their actions are domain verbs like "received"). The structural length
  // check above already ran; the runtime matcher does the real matching.
  if ((CONNECTOR_SUBJECT_TYPES as readonly string[]).includes(subject)) {
    return raw as EventPattern;
  }

  // First-party subjects whose actions are domain verbs — same bypass, same
  // reason. See DOMAIN_SUBJECT_TYPES above for why these are not simply added
  // to SUBJECT_TYPES.
  if ((DOMAIN_SUBJECT_TYPES as readonly string[]).includes(subject)) {
    return raw as EventPattern;
  }

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

  const extra = SUBJECT_EXTRA_ACTIONS[subject!];
  if (extra && extra.includes(action!)) {
    // A non-CRUD action this specific subject really emits (proposal.approved,
    // user.updated). Phase still checked below.
  } else if (!EVENT_ACTIONS.includes(action as EventAction)) {
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
