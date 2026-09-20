/**
 * Notification CATALOGUE — the projection of `NOTIFICATION_REGISTRY` that a
 * settings surface can render a per-type picker FROM.
 *
 * WHY THIS EXISTS. `notification_preferences.routingRules` is a JSONB map keyed
 * by notification type (read at `NotificationService.create`), but nothing ever
 * published the set of LEGAL keys. Relay concluded, correctly, that a per-type
 * picker was impossible because "there is nothing to render a picker FROM"
 * (`relay-app/src/features/governance/exposure.ts`). This module is that missing
 * half — and only that half. It adds NO new preference store: `routingRules`
 * stays the one place a per-type rule lives.
 *
 * THREE THINGS IT REFUSES TO DO, each because the alternative ships a dead
 * switch — a control that writes a real server row and changes nothing:
 *
 *  1. It never offers a type with NO PRODUCER. ~17 of the registry's rows are
 *     declared but emitted by nobody (`PRODUCERLESS_NOTIFICATION_TYPES` below).
 *     Enumerating the raw registry would render ~17 switches that govern
 *     nothing. That list lives HERE rather than in the test that pins it,
 *     precisely so there is one list and not two — see its docblock.
 *
 *  2. It never offers a channel with NO TRANSPORT. `telegram` logs "not
 *     implemented" and falls back to defaults (`resolveChannels`), and
 *     `email_digest` has no transport at all. A routing rule naming either is
 *     a setting the pod will ignore.
 *
 *  3. It never offers a rule a type's own `channelCeiling` would strip back to
 *     nothing (or back to a rule already offered). `handoff.continue` is capped
 *     to `in_app`, so a "Push" switch on it is a no-op with a server row behind
 *     it. `allowedRules` is DERIVED per type from the ceiling, never declared.
 *
 * WHAT IT DOES NOT COVER, measured and deliberate:
 *  - **No description.** `NotificationDef` has no `description` field; the only
 *    prose it carries is `bodyTemplate`, which is a mustache string
 *    (`"{{description}}"`) and would reach a settings screen as literal
 *    `{{…}}` text. The honest home for a one-line description is a new
 *    `description?: string` on `NotificationDef` in `registry.ts` — NOT a
 *    second label table here.
 *  - **It does not describe rule PRECEDENCE.** `NotificationService.create`
 *    resolves `rules[input.type] ?? rules[def.category]` — MORE SPECIFIC WINS,
 *    so a per-type rule set through this catalogue governs, and a category rule
 *    remains the fallback for every type not named individually. That is a
 *    property of the reader, not of this projection: mirroring it here as a
 *    constant would be a second copy free to drift, which is why this note
 *    points at the reader rather than restating it.
 *
 *    (It read `rules[def.category] ?? rules[input.type]` until 2026-09-20,
 *    which made every per-type rule dead the moment its category carried one —
 *    a picker built on this catalogue would have written real rows that did
 *    nothing. Fixed in `NotificationService.ts`; recorded here because this
 *    module is what invites a UI to write per-type rules in the first place.)
 *  - **It does not read or merge preferences.** Callers pair it with
 *    `notifCenter.getPrefs`.
 */

import {
  NOTIFICATION_REGISTRY,
  type DeliveryChannel,
  type NotificationDef,
} from "./registry.js";
import { resolveNotificationCategoryLabel } from "@synap-core/types/vocabulary";

// ---------------------------------------------------------------------------
// Producer-backed filter
// ---------------------------------------------------------------------------

/**
 * Registry types with NO producer anywhere in `packages/api/src` — reviewed
 * 2026-09-04 (S3), each row carrying a "remove or produce by 2026-10-01"
 * rationale in `notification-producer-allowlist.test.ts`, which is the tripwire
 * that PINS this list to reality.
 *
 * WHY THE LIST LIVES HERE AND NOT IN THE TEST. The tripwire derives the truth
 * by SOURCE SCAN — `readdirSync` over the `.ts` tree under `packages/api/src`
 * (`collectSourceFiles`). That mechanism cannot be reused at runtime: a
 * deployed pod runs compiled JS and has no `src` tree to scan, so a runtime
 * call would find zero files and report every type producer-less — a vacuous
 * filter that hides the entire catalogue. The smallest honest alternative is
 * therefore ONE list, declared here (runtime-safe, dependency-free) and
 * IMPORTED by the tripwire, which continues to assert it equals the scan
 * exactly. Copying the array into a second place is what that would have been;
 * moving it is not.
 *
 * Consequence to keep in mind: this set is only as current as the last
 * tripwire run. A type that gains a producer stays hidden from the catalogue
 * until someone removes its row — and the tripwire goes RED the moment that
 * happens, which is the point.
 */
export const PRODUCERLESS_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  // ── The original ten (pre-S3 audit) ──────────────────────────────────────
  "proposal.auto_approved",
  "ai_request.terminal_exec",
  "entity.created_by_ai",
  "data.entity.deleted",
  "data.document.created",
  "data.view.created",
  "data.relation.created",
  "inbox.email",
  "inbox.mention",
  "inbox.priority_item",

  // ── Found during S3 (2026-09-04) — no caller anywhere ────────────────────
  "pod.storage_warning",
  "workspace.invite",

  // ── Also S3 — unfinished halves of a set whose sibling IS produced ───────
  "connector.sync.complete",
  "agent.task_complete",
  "agent.insight",
  "pod.update_available",
]);

// ---------------------------------------------------------------------------
// Channels that actually have a transport
// ---------------------------------------------------------------------------

/**
 * Channels the pod can genuinely deliver on today.
 *
 * COMPILE-TIME COVERAGE FLOOR (`_channelsClassified` below): both sets are
 * checked against `DeliveryChannel` itself, and every member of that union
 * must appear in one of them. Adding a sixth channel to `registry.ts` without
 * saying which kind it is stops the BUILD — it cannot silently default into
 * "offerable" and reach a settings screen as a switch over nothing.
 */
export const DELIVERABLE_CHANNELS = [
  "in_app",
  "os",
] as const satisfies ReadonlyArray<DeliveryChannel>;

/**
 * Declared in the `DeliveryChannel` union but with no working transport.
 * `telegram` logs "not implemented" and falls back to the type's defaults
 * (`NotificationService.resolveChannels`); `email_digest` has no send path at
 * all — no caller, no worker, nothing reads it.
 */
export const TRANSPORTLESS_CHANNELS = [
  "telegram",
  "email_digest",
] as const satisfies ReadonlyArray<DeliveryChannel>;

type _ChannelsClassified =
  Exclude<
    DeliveryChannel,
    (typeof DELIVERABLE_CHANNELS)[number]
  > extends (typeof TRANSPORTLESS_CHANNELS)[number]
    ? true
    : never;
const _channelsClassified: _ChannelsClassified = true;
void _channelsClassified;

const DELIVERABLE = new Set<DeliveryChannel>(DELIVERABLE_CHANNELS);

// ---------------------------------------------------------------------------
// Routing-rule vocabulary
// ---------------------------------------------------------------------------

/**
 * The five values `routingRules` has always declared, as read by
 * `NotificationService` (`"mute"` short-circuits before the row is written;
 * the other four reach `resolveChannels`). This module adds no sixth token.
 */
export type NotificationRoutingRule =
  "mute" | "in_app" | "os" | "all" | "telegram";

/** Rules a settings surface may offer. Ordered loudest→quietest for display. */
const OFFERABLE_RULES = [
  "all",
  "os",
  "in_app",
  "mute",
] as const satisfies ReadonlyArray<NotificationRoutingRule>;

/** Declared, but naming a transport that does not exist. Never offered. */
const UNOFFERABLE_RULES = [
  "telegram",
] as const satisfies ReadonlyArray<NotificationRoutingRule>;

type _RulesClassified =
  Exclude<
    NotificationRoutingRule,
    (typeof OFFERABLE_RULES)[number]
  > extends (typeof UNOFFERABLE_RULES)[number]
    ? true
    : never;
const _rulesClassified: _RulesClassified = true;
void _rulesClassified;

/**
 * What each rule resolves to, mirroring `resolveChannels`' switch. `"mute"` is
 * not here: it is handled before channel resolution and means "not delivered
 * at all", so it is always offerable and never ceiling-stripped.
 */
const RULE_CHANNELS: Record<
  Exclude<NotificationRoutingRule, "mute" | "telegram">,
  readonly DeliveryChannel[]
> = {
  all: ["in_app", "os"],
  os: ["os"],
  in_app: ["in_app"],
};

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface NotificationCatalogueEntry {
  /** Registry key — and the exact key to write under `routingRules`. */
  type: string;
  category: NotificationDef["category"];
  /** Human label, from the registry entry's own `label`. */
  label: string;
  /** lucide icon name, from the registry entry. */
  icon: string;
  priority: NotificationDef["priority"];
  /** The type's declared defaults, narrowed to channels with a transport. */
  defaultChannels: DeliveryChannel[];
  /** Present only when the type declares one; narrowed to deliverable channels. */
  channelCeiling?: DeliveryChannel[];
  /** Rule values a picker may offer for THIS type — derived from the ceiling. */
  allowedRules: NotificationRoutingRule[];
  /**
   * The offered rule equivalent to `defaultChannels`, so a picker can name the
   * unset state ("Default — In-app + Push") instead of showing a blank. `null`
   * when no offered rule reproduces the defaults exactly (e.g. a type whose
   * defaults are empty after the transport filter).
   */
  defaultRule: NotificationRoutingRule | null;
}

export interface NotificationCatalogueCategory {
  category: NotificationDef["category"];
  label: string;
}

export interface NotificationCatalogue {
  /** Producer-backed types only, registry order. */
  types: NotificationCatalogueEntry[];
  /** Categories present in `types`, for grouping. Never an empty group. */
  categories: NotificationCatalogueCategory[];
  /** Channels with a real transport — the only ones any entry can name. */
  deliverableChannels: DeliveryChannel[];
  /**
   * How many registry rows were withheld for having no producer. Exposed so a
   * surface can be honest ("12 more types are declared but never fire") rather
   * than implying the registry is this small.
   */
  withheldProducerlessCount: number;
}

function sameChannelSet(
  a: readonly DeliveryChannel[],
  b: readonly DeliveryChannel[]
): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((c) => bs.has(c));
}

/**
 * Rules worth offering for `def`, in display order.
 *
 * A rule is offered iff the type's `channelCeiling` does not change what it
 * means: its NOMINAL set (its channels, transport-filtered) must survive the
 * ceiling intact. That single condition covers both ways a ceiling makes a
 * control dishonest, for a type capped to `in_app`:
 *   - `"os"` → nominal {os}, resolved {} — a switch that writes a row and
 *     delivers nothing.
 *   - `"all"` → nominal {in_app, os}, resolved {in_app} — a switch LABELLED
 *     "everywhere" that quietly means "in-app only", sitting next to the
 *     `in_app` control it is now identical to.
 *
 * Deliberately NOT a dedupe-by-resolved-set: that would be order-dependent,
 * keeping whichever of `all`/`in_app` the loop happened to reach first, and it
 * kept the misnamed `"all"` over the accurate `"in_app"`. Comparing each rule
 * against its own nominal meaning has no such dependence.
 *
 * `"mute"` is always offered — muting is meaningful for every type, and it is
 * handled before channel resolution so no ceiling applies to it.
 */
export function allowedRulesFor(
  def: NotificationDef
): NotificationRoutingRule[] {
  const ceiling = def.channelCeiling ? new Set(def.channelCeiling) : null;
  const out: NotificationRoutingRule[] = [];

  for (const rule of OFFERABLE_RULES) {
    if (rule === "mute") {
      out.push(rule);
      continue;
    }
    const nominal = RULE_CHANNELS[rule].filter((c) => DELIVERABLE.has(c));
    if (nominal.length === 0) continue;
    const resolved = ceiling ? nominal.filter((c) => ceiling.has(c)) : nominal;
    if (!sameChannelSet(nominal, resolved)) continue;
    out.push(rule);
  }
  return out;
}

function deliverable(channels: readonly DeliveryChannel[]): DeliveryChannel[] {
  return channels.filter((c) => DELIVERABLE.has(c));
}

/** Project one registry entry. Exported for the catalogue tests. */
export function catalogueEntryFor(
  def: NotificationDef
): NotificationCatalogueEntry {
  const defaults = deliverable(def.defaultChannels);
  const allowedRules = allowedRulesFor(def);
  const defaultRule =
    allowedRules.find(
      (r) =>
        r !== "mute" &&
        sameChannelSet(RULE_CHANNELS[r as "all" | "os" | "in_app"], defaults)
    ) ?? null;

  const entry: NotificationCatalogueEntry = {
    type: def.type,
    category: def.category,
    label: def.label,
    icon: def.icon,
    priority: def.priority,
    defaultChannels: defaults,
    allowedRules,
    defaultRule,
  };
  if (def.channelCeiling)
    entry.channelCeiling = deliverable(def.channelCeiling);
  return entry;
}

/**
 * Build the catalogue. Pure — no DB, no preferences, no request context — so a
 * caller can hold it as a constant and a test can assert it without a pod.
 */
export function buildNotificationCatalogue(): NotificationCatalogue {
  const backed = NOTIFICATION_REGISTRY.filter(
    (def) => !PRODUCERLESS_NOTIFICATION_TYPES.has(def.type)
  );
  const types = backed.map(catalogueEntryFor);

  const seenCategories = new Set<string>();
  const categories: NotificationCatalogueCategory[] = [];
  for (const entry of types) {
    if (seenCategories.has(entry.category)) continue;
    seenCategories.add(entry.category);
    categories.push({
      category: entry.category,
      label: resolveNotificationCategoryLabel(entry.category),
    });
  }

  return {
    types,
    categories,
    deliverableChannels: [...DELIVERABLE_CHANNELS],
    withheldProducerlessCount: NOTIFICATION_REGISTRY.length - backed.length,
  };
}
