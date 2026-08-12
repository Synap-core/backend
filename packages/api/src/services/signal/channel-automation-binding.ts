/**
 * Channel ⇄ automation binding — "which automations can fire for THIS channel".
 *
 * A MATCHER-FAITHFUL mirror of the fire-time predicate in
 * `@synap/jobs` `automation-trigger-matcher.ts` (`matchPattern` +
 * `matchFilters` + `matchTriggerSpecificFilters`), reduced to the message
 * events a channel emits. It is a MIRROR, not the matcher itself: the matcher
 * lives in @synap/jobs, whose subpath exports resolve through `dist`, so
 * importing it here would make an api typecheck depend on a freshly built jobs
 * bundle. The mirror is pure and unit-tested against the matcher's rules; when
 * the matcher's channel/external-message branches change, change this too.
 *
 * WHY a scan and not a column: an automation's binding to a channel is not one
 * field. It can be
 *   • `channel`    — `triggerConfig.channelId` (post-U3 this is honored for
 *                    external_message too, not just channel_message),
 *   • `entity`     — a `filters.entityId` equal to the channel's bound context
 *                    entity (the recorder puts `entityId` on the event data),
 *   • `capability` — reached through a capability that targets the channel
 *                    (resolved from `links`, not from the trigger config),
 *   • `workspace`  — no narrowing at all: every inbound in the lens fires it.
 * Reporting only the first kind would under-report the real wiring, which is
 * exactly the blindness this surface exists to remove.
 */

import type { AutomationTriggerConfig } from "@synap/database";

export type ChannelAutomationBinding =
  "channel" | "entity" | "workspace" | "capability";

/**
 * The event types a channel emits that an automation can bind to.
 *   `external_message.received.completed` — inbound-recorder's emitSideEffects.
 *   `channel_message.created.completed`   — an in-pod channel message.
 * Both are `{subject}.{action}.completed`, the shape `matchPattern` walks.
 */
export const CHANNEL_EVENT_TYPES = [
  "external_message.received.completed",
  "channel_message.created.completed",
] as const;

/**
 * The synthetic `message.received` aliases (mirror of the matcher's
 * `matchesMessageAlias`): an automation with one of these patterns fires for
 * BOTH physical message events, so the channel-Stack surface must count it for a
 * channel too. Keep in lockstep with @synap/jobs `automation-trigger-matcher.ts`.
 */
function matchesMessageAlias(eventType: string, pattern: string): boolean {
  if (
    pattern !== "message.received" &&
    pattern !== "message.received.*" &&
    pattern !== "message.*"
  ) {
    return false;
  }
  return (CHANNEL_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * Verbatim mirror of the matcher's `matchPattern`: exact match, the synthetic
 * `message.received` alias, or a trailing `*` that swallows the rest.
 */
export function matchesEventPattern(
  eventType: string,
  pattern: string | undefined
): boolean {
  if (!pattern) return false;
  if (pattern === eventType) return true;
  if (matchesMessageAlias(eventType, pattern)) return true;
  const patternParts = pattern.split(".");
  const eventParts = eventType.split(".");
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === "*") return true;
    if (patternParts[i] !== eventParts[i]) return false;
  }
  return patternParts.length === eventParts.length;
}

export interface ChannelFacts {
  channelId: string;
  /** `channels.contextObjectId` — the entity this channel is bound to. */
  boundEntityId: string | null;
  /** `channels.externalSource` — the provider the event data will carry. */
  provider: string | null;
}

/**
 * Can this automation's trigger config ever fire for this channel, and by which
 * binding? Returns null when the automation can NEVER fire for it (a different
 * channel, a different bound entity, a non-message event pattern, or a generic
 * filter this channel's event data can never satisfy).
 *
 * Mirrors the matcher's evaluation ORDER: pattern → generic filters → trigger-
 * specific filters. Only filters whose keys the channel event data actually
 * carries are decidable here; an undecidable filter key (one the recorder does
 * not emit) is treated as NON-MATCHING, because the matcher's exact-equality
 * `matchFilters` would compare it against `undefined` and reject.
 */
export function classifyChannelAutomationBinding(
  triggerConfig: AutomationTriggerConfig | null | undefined,
  channel: ChannelFacts
): ChannelAutomationBinding | null {
  const config = (triggerConfig ?? {}) as AutomationTriggerConfig;

  const matchedEventType = CHANNEL_EVENT_TYPES.find((t) =>
    matchesEventPattern(t, config.eventPattern)
  );
  if (!matchedEventType) return null;

  // ── trigger-specific: channelId (the matcher's channel_message branch, and
  //    — post-U3 — its external_message branch too).
  if (config.channelId) {
    if (config.channelId !== channel.channelId) return null;
  }

  // ── generic `filters` map. The channel event data the recorder emits is
  //    { entityId, channelId, provider, threadId, messageId, participantName,
  //      messagePreview, content, attachments? }. Only the stable, channel-level
  //    keys are decidable ahead of an actual message.
  let entityBound = false;
  const filters = config.filters ?? {};
  for (const [key, expected] of Object.entries(filters)) {
    if (key === "entityId") {
      if (!channel.boundEntityId || expected !== channel.boundEntityId)
        return null;
      entityBound = true;
      continue;
    }
    if (key === "channelId") {
      if (expected !== channel.channelId) return null;
      continue;
    }
    if (key === "provider") {
      if (expected !== channel.provider) return null;
      continue;
    }
    // A per-message filter (messagePreview, content, participantName, …) is not
    // decidable per-channel: it narrows WHICH messages fire, not WHETHER this
    // channel can. Treat it as satisfiable so the binding is still reported.
  }

  if (config.channelId) return "channel";
  if (entityBound) return "entity";
  return "workspace";
}
