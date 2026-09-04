/**
 * RULE DRY RUN — replay a draft rule's compiled trigger against REAL persisted
 * history and report HOW MANY STORED EVENTS MATCH IT.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * It is NOT a "would have fired N times" simulation, and it deliberately
 * returns no field by that name. A match is not a run: the live path also
 * applies cycle detection, the chain-depth ceiling, the exactly-once claim, the
 * automation's own `status`, and the governance floor on its THEN-actions —
 * none of which this replay evaluates, and several of which depend on state
 * that no longer exists. The honest sentence a caller may render is
 * "N events in the last 7 days match this", never "this would have fired N
 * times". The field is named {@link RuleDryRunMatch.matchingEventCount} so it
 * cannot be misread.
 *
 * It is also NOT `governanceRules.dryRun`. That procedure belongs to the
 * AUTHORIZATION store (`governance_rules`, migration 0215) and answers "would
 * this policy rule auto-approve or propose?". This one belongs to the RULE LOOP
 * (a `skills` row + a compiled automation) and answers "has anything in my
 * history matched this trigger?". Two different objects called "rule"; they
 * share no code and must not be merged.
 *
 * ── THE TRAP this module exists to defuse ───────────────────────────────────
 * The same real-world message is recorded under TWO DIFFERENT TYPE STRINGS, and
 * only one of them is the one the matcher was written against:
 *
 *   • LIVE firing rides a TRANSIENT pub/sub reactor
 *     (`packages/events/src/side-effects.ts`, `automationTriggerMatchReactor`)
 *     which builds `eventType` as `${subjectType}.${action}.completed` — so an
 *     inbound message reaches the matcher as
 *     `external_message.received.completed`, and an in-pod channel message as
 *     `channel_message.created.completed`.
 *   • PERSISTED history rows come from `emitMessageEvent`
 *     (`@synap/database`, 12 producers) and are typed `message.received` /
 *     `message.sent` with `subjectType: "channel"`. NOTHING enqueues a trigger
 *     match for them — `setup-event-broadcasting.ts` registers four event hooks
 *     (broadcast / domainBridge / materialization / syncRealtime) and no
 *     automation hook. `emit-message-observation.ts` says so in its own header.
 *
 * And the rule sentence grammar can only ever author the PHYSICAL string:
 * `buildEventPattern` maps `subjectCategory: "external_message"` to
 * `external_message.received.completed` (there is no alias spelling in the
 * grammar at all). So a replay that pushes stored rows straight through
 * `matchPattern` compares `"message.received"` against
 * `"external_message.received.completed"`, misses every time, and reports a
 * confident **0** for every message rule a user can write.
 *
 * That is the exact defect class this repo has shipped before — a deployed
 * expiry that expired nothing because the class matched `run` while the
 * executor wrote `capability.run`, with tests that pinned the same lie. So the
 * mapping below is TESTED BY BEHAVIOUR, not by symbol import:
 * `dry-run.tripwire.test.ts` compiles a real sentence and asserts a real
 * persisted-shape row matches it.
 *
 * ── Where the mapping lives, and why HERE ───────────────────────────────────
 * At the REPLAY BOUNDARY, not in `MESSAGE_ALIAS_PATTERNS` / `matchesMessageAlias`
 * (`@synap-core/types/events/unified.ts` + the matcher). Those are shared with
 * the LIVE matcher: teaching them that `message.received` is a physical message
 * event would change runtime semantics for every already-authored automation.
 * This module reshapes only the rows IT reads, and the four predicates it calls
 * are imported from the worker itself — never re-implemented. A duplicated
 * predicate is a fork with a countdown.
 */

import {
  db,
  events,
  automationRuns,
  and,
  eq,
  gte,
  inArray,
  like,
  desc,
  isNull,
  or,
  type AutomationTriggerConfig,
} from "@synap/database";
import type { SQL } from "drizzle-orm";
// Deep worker import, exactly like `automation-cron-scheduler.js` /
// `automation-run-reaper.js` already are from this package. The four predicates
// are the worker's OWN exports — pattern, filters, trigger-specific filters, and
// the message-envelope derivation — so replay and live firing can never fork.
import {
  matchPattern,
  matchFilters,
  matchTriggerSpecificFilters,
  deriveMessageEnvelope,
} from "@synap/jobs/workers/automation-trigger-matcher.js";

/** Hard ceiling on rows read per dry run. A hit is reported, never hidden. */
export const DRY_RUN_SCAN_LIMIT = 5000;

/** How many matched events are returned as evidence alongside the count. */
const SAMPLE_LIMIT = 5;

/**
 * The physical message event types the live matcher is written against — the
 * SAME pair as `MESSAGE_ALIAS_EVENT_TYPES` in the worker, quoted here because
 * this module maps ONTO them rather than consuming their alias semantics.
 */
export const PHYSICAL_EXTERNAL_MESSAGE = "external_message.received.completed";
export const PHYSICAL_CHANNEL_MESSAGE = "channel_message.created.completed";

/** The two types `emitMessageEvent` writes into `events`. */
export const PERSISTED_MESSAGE_TYPES = [
  "message.received",
  "message.sent",
] as const;

/** One stored row, in the only shape the replay reads. */
export interface StoredEventRow {
  id: string;
  type: string;
  data: Record<string, unknown> | null;
  timestamp: Date;
}

/** A stored row reshaped into what the live matcher would have seen. */
export interface PhysicalEvent {
  eventType: string;
  data: Record<string, unknown>;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/**
 * Reshape ONE stored row onto the physical event the live matcher is written
 * against. Non-message rows pass through untouched — their stored `type` IS the
 * type the reactor publishes (`entity.create.completed` etc.).
 *
 * Message rows are remapped:
 *   • `message.received` carrying a provider (`data.externalSource` from
 *     `inbound-recorder.ts`, or `data.provider`) → `external_message.received.completed`.
 *     Inbound-recorder is the only producer that stamps one, and it is the only
 *     producer that also emits the physical external event.
 *   • every other `message.received` / `message.sent` → `channel_message.created.completed`,
 *     which is what `send-message.ts` (user + assistant halves) and
 *     `messaging.ts` publish for an in-pod channel message.
 *
 * The projected `data` is HONEST to the stored row. `emitMessageEvent` writes
 * only small fact fields — never the body — so `content`, `participantName` and
 * `attachments` are ABSENT here even though the live physical payload carries
 * them. A shape predicate over those fields therefore under-counts on replay,
 * and {@link triggerReplayCaveats} says so out loud rather than letting the
 * number lie.
 */
export function toPhysicalEvent(row: {
  type: string;
  data: Record<string, unknown> | null;
}): PhysicalEvent {
  const d = row.data ?? {};
  if (row.type !== "message.received" && row.type !== "message.sent") {
    return { eventType: row.type, data: d };
  }

  const provider = str(d.externalSource) ?? str(d.provider);
  const isExternal = row.type === "message.received" && provider !== undefined;

  // `role` is what `insertChannelMessage` / `post-message` / the threads REST
  // door store; `authorType` is what `persist-assistant-reply` stores. Neither
  // is guaranteed — a producer that stored neither leaves `messageRole`
  // undefined, and a `messageRole` filter then simply does not match. Never
  // inferred from the `received`/`sent` type: `crud.ts` writes `message.sent`
  // for a HUMAN comment, so that correspondence does not hold.
  const role = str(d.role) ?? str(d.messageRole);
  const authorType = str(d.authorType);
  const messageRole =
    role ??
    (authorType === "ai_agent" || authorType === "ai"
      ? "assistant"
      : undefined);

  return {
    eventType: isExternal
      ? PHYSICAL_EXTERNAL_MESSAGE
      : PHYSICAL_CHANNEL_MESSAGE,
    data: {
      ...d,
      ...(provider ? { provider } : {}),
      ...(messageRole ? { messageRole } : {}),
    },
  };
}

/**
 * The predicate a dry run evaluates — the SAME three the live worker evaluates
 * at `automation-trigger-matcher.ts` (pattern → filters → trigger-specific),
 * in the same order, over the remapped event.
 *
 * Everything the live path ALSO does (cycle detection, chain depth, the
 * exactly-once claim, `automation.status`, the governance floor on THEN) is
 * deliberately NOT here — which is precisely why the result is a match count
 * and not a firing count.
 */
export function eventMatchesTrigger(
  row: { type: string; data: Record<string, unknown> | null },
  config: AutomationTriggerConfig
): boolean {
  const physical = toPhysicalEvent(row);
  if (!matchPattern(physical.eventType, config.eventPattern)) return false;
  if (!matchFilters(physical.data, config.filters)) return false;
  const envelope = deriveMessageEnvelope(physical.eventType, physical.data);
  return matchTriggerSpecificFilters(
    physical.eventType,
    physical.data,
    config,
    envelope
  );
}

/**
 * Fields the live physical message payload carries that a PERSISTED row does
 * not, because `emitMessageEvent` writes facts and never the message body.
 * A trigger whose shape predicate reads one of these can only under-count on
 * replay, and the caller is told so.
 */
const UNREPLAYABLE_SHAPE_FIELDS = new Set([
  "content",
  "participant",
  "attachments",
]);

/** Honest, user-safe notes about what this particular replay cannot see. */
export function triggerReplayCaveats(
  config: AutomationTriggerConfig
): string[] {
  const caveats: string[] = [];
  const shape = (config as { shape?: unknown }).shape;
  if (shape && typeof shape === "object") {
    const touched = JSON.stringify(shape);
    for (const field of UNREPLAYABLE_SHAPE_FIELDS) {
      if (touched.includes(field)) {
        caveats.push(
          "Stored message history records only facts about a message (channel, provider, thread), never its text or attachments — so a condition on message content can only under-count here."
        );
        break;
      }
    }
  }
  return caveats;
}

/**
 * A coarse SQL prefilter so a dry run reads a bounded slice instead of the whole
 * log. It may only ever be WIDER than `matchPattern` — narrowing here would
 * silently drop matches, which is the same lie in a different place.
 *
 * `matchPattern` requires segment-0 equality unless the pattern's first segment
 * is `*`, so a first-segment prefix is a safe over-approximation. Message
 * patterns additionally have to reach the PERSISTED spellings, which is the
 * whole point of {@link toPhysicalEvent}.
 */
export type EventTypePrefilter =
  { kind: "in"; types: string[] } | { kind: "prefix"; prefix: string } | null;

/** PURE half — the type set, so a tripwire can assert it without a database. */
export function prefilterTypesFor(eventPattern: string): EventTypePrefilter {
  const first = eventPattern.split(".")[0];
  if (!first || first === "*") return null;

  if (
    first === "external_message" ||
    first === "channel_message" ||
    first === "message"
  ) {
    return {
      kind: "in",
      types: [
        ...PERSISTED_MESSAGE_TYPES,
        PHYSICAL_EXTERNAL_MESSAGE,
        PHYSICAL_CHANNEL_MESSAGE,
      ],
    };
  }

  return { kind: "prefix", prefix: `${first}.` };
}

/** SQL half — a mechanical translation of {@link prefilterTypesFor}. */
export function eventTypePrefilter(eventPattern: string): SQL | undefined {
  const spec = prefilterTypesFor(eventPattern);
  if (!spec) return undefined;
  return spec.kind === "in"
    ? inArray(events.type, spec.types)
    : like(events.type, `${spec.prefix}%`);
}

export interface RuleDryRunMatch {
  status: "ok";
  /** The compiled pattern that was replayed — shown so the count is auditable. */
  eventPattern: string;
  windowDays: number;
  /** Inclusive lower bound of the replayed window, ISO-8601 UTC. */
  since: string;
  /**
   * Stored events in the window that MATCH the compiled trigger.
   *
   * A MATCH IS NOT A RUN. See this module's header before renaming, rounding,
   * or re-labelling this in any surface.
   */
  matchingEventCount: number;
  /** How many rows were actually read (bounded by {@link DRY_RUN_SCAN_LIMIT}). */
  scannedEventCount: number;
  /** true ⇒ the scan hit its cap; `matchingEventCount` is a FLOOR, not a total. */
  truncated: boolean;
  /** Most recent matches, as evidence for the number. */
  samples: Array<{ eventId: string; eventType: string; timestamp: string }>;
  /** What this replay provably cannot see. Render verbatim. */
  caveats: string[];
  /**
   * REAL firings recorded in `automation_runs` over the same window, for a rule
   * that ALREADY exists. Categorically different from `matchingEventCount`:
   * this one counts runs that happened. Absent when no existing rule was named.
   */
  actualRunCount?: number;
}

export type RuleDryRunResult =
  | RuleDryRunMatch
  | {
      /** The trigger has no event pattern to replay (a cron rule, a webhook). */
      status: "not_replayable";
      reason: string;
    };

export interface RuleDryRunInput {
  /** The FLOOR. Always the caller's own id; never request-supplied. */
  userId: string;
  triggerType: string;
  triggerConfig: AutomationTriggerConfig;
  windowDays: number;
  /** Narrows the caller's own events further. Cannot widen the floor. */
  workspaceId?: string | null;
  /** Automations to count REAL firings for, when replaying an existing rule. */
  automationIds?: string[];
  /** Visibility predicate for `automation_runs`, from `scopedDb().predicate()`. */
  runVisibility?: SQL | undefined;
}

/**
 * Replay `triggerConfig` over the caller's own persisted events.
 *
 * SCOPING: `events` has no `VisibilityRule` in `access/registry.ts`, so
 * `scopedDb` cannot be used here (it throws for unregistered tables, by
 * design). The floor applied instead is the strictest one available and does
 * not depend on any request field: `events.user_id = <caller>`. A supplied
 * `workspaceId` can only NARROW that — it is ANDed on, never substituted for
 * the user floor, so a forged workspace id cannot reach another user's log.
 * The `automation_runs` half DOES go through the canonical predicate.
 */
export async function runRuleDryRun(
  input: RuleDryRunInput
): Promise<RuleDryRunResult> {
  const eventPattern = input.triggerConfig.eventPattern;
  if (input.triggerType !== "event" || !eventPattern) {
    return {
      status: "not_replayable",
      reason:
        input.triggerType === "cron"
          ? "A scheduled rule has no past events to replay — it runs on a clock, not on history."
          : "This rule has no event trigger, so there is no history to replay it against.",
    };
  }

  const since = new Date(Date.now() - input.windowDays * 86_400_000);

  const conditions: SQL[] = [
    eq(events.userId, input.userId),
    gte(events.timestamp, since),
  ];
  const prefilter = eventTypePrefilter(eventPattern);
  if (prefilter) conditions.push(prefilter);
  if (input.workspaceId) {
    // Pod-wide rows (NULL workspace) are the caller's own too and are visible
    // in every lens — the same `nullWorkspaceMeans: "podGlobalConfig"` stance
    // the access registry takes for workspace-scoped tables.
    const wsFilter = or(
      eq(events.workspaceId, input.workspaceId),
      isNull(events.workspaceId)
    );
    if (wsFilter) conditions.push(wsFilter);
  }

  const rows = (await db
    .select({
      id: events.id,
      type: events.type,
      data: events.data,
      timestamp: events.timestamp,
    })
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.timestamp))
    .limit(DRY_RUN_SCAN_LIMIT)) as StoredEventRow[];

  let matchingEventCount = 0;
  const samples: RuleDryRunMatch["samples"] = [];
  for (const row of rows) {
    if (!eventMatchesTrigger(row, input.triggerConfig)) continue;
    matchingEventCount += 1;
    if (samples.length < SAMPLE_LIMIT) {
      samples.push({
        eventId: row.id,
        eventType: row.type,
        timestamp: row.timestamp.toISOString(),
      });
    }
  }

  const result: RuleDryRunMatch = {
    status: "ok",
    eventPattern,
    windowDays: input.windowDays,
    since: since.toISOString(),
    matchingEventCount,
    scannedEventCount: rows.length,
    truncated: rows.length >= DRY_RUN_SCAN_LIMIT,
    samples,
    caveats: triggerReplayCaveats(input.triggerConfig),
  };

  if (input.automationIds && input.automationIds.length > 0) {
    const runWhere: SQL[] = [
      inArray(automationRuns.automationId, input.automationIds),
      gte(automationRuns.startedAt, since),
    ];
    if (input.runVisibility) runWhere.push(input.runVisibility);
    const runRows = await db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(and(...runWhere));
    result.actualRunCount = runRows.length;
  }

  return result;
}
