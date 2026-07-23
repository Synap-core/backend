/**
 * Run subject derivation — the ONE door.
 *
 * `automation_runs.subject_entity_id` is the lens `resolveRunChannel`
 * (`post-run-summary.ts`) reads for `resultRouting: "per_entity"`: the entity a
 * run "is about", and therefore whose own channel the run's activity lands in —
 * the per-client recap spine ("each client's daily digest lands in that client's
 * own channel"). `per_entity` on a run with a NULL subject silently degrades to
 * the per-type feed, so a creation path that forgets to populate the column
 * makes the routing mode inert rather than loud.
 *
 * There are four run-creating paths (manual trigger, event matcher, cron
 * scheduler, `sub_automation` spawn). They all derive the subject through the
 * two helpers below so the rules cannot drift into four private copies.
 */

import { z } from "zod";

const UUID = z.string().uuid();

/** A candidate subject is only accepted when it is actually a UUID. */
function asEntityId(value: unknown): string | undefined {
  const parsed = UUID.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The subject carried by a trigger/step payload bag.
 *
 * `entityId` is the established payload convention across the automation
 * surface: the generic action renderers send it on a manual trigger, and a
 * `sub_automation` node's `payloadMapping` maps the loop item onto it (the
 * "cron parent → for-each-client → per-client child" shape).
 *
 * Only a UUID is accepted, which is load-bearing: an unresolved template string
 * (`"{{loop.item.id}}"` with no matching context) must NOT become a subject.
 */
export function subjectEntityIdFromPayload(
  payload: Record<string, unknown> | null | undefined
): string | undefined {
  return asEntityId(payload?.entityId);
}

/**
 * The subject of an event-triggered run, derived from the matched event.
 *
 * `eventType` is `${subjectType}.${action}.completed` by construction
 * (`emitSideEffects` builds it that way in `@synap/events`), so both parts are
 * read straight off it.
 */
export function deriveEventSubjectEntityId(input: {
  eventType: string;
  subjectId?: string | null;
  data?: Record<string, unknown> | null;
}): string | undefined {
  const [subjectType, action] = input.eventType.split(".");

  // A run about a just-DELETED entity has no room to post into: routing it per
  // entity would mint a channel bound to a dead row. Degrading to the per-type
  // feed is the honest behaviour, so a delete never yields a subject.
  if (action === "delete") return undefined;

  // `entity.*` — `subjectId` IS the entity, and it is authoritative. Preferred
  // over `data.entityId` here because `entity.update.completed` spreads the
  // entity's own changed PROPERTIES into `data` (routers/entities.ts), so a
  // user-defined property named `entityId` could otherwise hijack the subject.
  if (subjectType === "entity") return asEntityId(input.subjectId);

  // Every other emitter that knows which entity its event is about publishes it
  // explicitly as `data.entityId`: `entity_facet.*` carries the parent entity,
  // and `external_message.received` carries the channel's bound context entity
  // (absent when the channel isn't entity-bound). Their `subjectId` is NOT an
  // entity — it is a facet id, or `contextObjectId ?? channelId` — so it must
  // never be used as a fallback on this branch.
  return asEntityId(input.data?.entityId);
}
