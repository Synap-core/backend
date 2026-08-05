/**
 * Signal — pod-wide pipeline observability read layer.
 *
 * ONE reading over the inbound-message → AI-extraction → entities/proposals
 * pipeline: "a message landed, then WHAT happened to it". It does NOT own a
 * table. It joins three existing ledgers the pipeline already writes:
 *
 *   1. `messages` (authorType=external)   — the inbound SIGNAL that landed
 *      (recorded by services/connectors/inbound-recorder.ts).
 *   2. `automation_runs`                  — the extraction run the inbound event
 *      opened (automation-trigger-matcher fires it from
 *      `external_message.received`; the run's `trigger_payload.data.channelId`
 *      is the channel that triggered it — see automation-trigger-matcher.ts's
 *      `fireAutomation({ eventType, subjectId, data, ... })`).
 *   3. `proposals`                        — what the run PRODUCED. The executor
 *      stamps `proposals.correlationId = automationContext.rootRunId` (== the
 *      run id for a root run — automation-executor.ts), so a run's produced
 *      proposals are exactly `proposals WHERE correlationId = run.id`.
 *
 * The message↔run join key. The native provider message id is NOT a column on
 * `messages` (it is folded into `messages.hash`), and `automation_runs` has no
 * correlationId column, so there is no direct row-to-row FK from a message to
 * its run. The honest, cross-provider join this reading uses is
 * CHANNEL + TIME-WINDOW: a message m on channel c is attributed to the earliest
 * external-message-triggered run on c whose `startedAt` falls in
 * `[m.timestamp, nextMessageOnChannel.timestamp)`. That window is exact per
 * message because `external_message.received` fires the matcher once per inbound
 * message, so each matched message opens its own run. (Documented approximation:
 * a run that started before its own message's stored timestamp — clock skew — or
 * two messages between two runs are attributed best-effort.)
 *
 * Access floor. Messages are floored by `channelVisibilityWhere` (the SAME
 * predicate every channel/message read uses — hub-protocol/context.ts), runs and
 * proposals by `userVisibleWhere` (the SAME predicate proposals.list /
 * activity.summary / listRuns use). No new resolver is introduced.
 */

import {
  db,
  and,
  or,
  eq,
  lt,
  gte,
  lte,
  desc,
  count,
  exists,
  not,
  isNull,
  isNotNull,
  inArray,
  drizzleSql,
  messages,
  channels,
  automationRuns,
  proposals,
  MessageAuthorType,
  ProposalStatus,
} from "@synap/database";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import type { RunStatus } from "../runs/types.js";

/**
 * The outcome of a signal unit — WHAT happened to an inbound message.
 *
 *   extracted           — an extraction run produced ≥1 entity/proposal.
 *   no_insight          — a run ran to a terminal, non-error end but produced
 *                         nothing (completed/skipped with 0 proposals; a still-
 *                         running run also folds here until it produces).
 *   no_run              — the message landed on a channel that IS bound to a
 *                         context entity (wired to a client), but NO extraction
 *                         run consumed it. A real miss: the wiring exists, yet
 *                         nothing ran.
 *   unprocessed_unbound — the message landed but NO extraction run consumed it
 *                         AND the channel is not bound to any context entity
 *                         (never wired to a client). THE structural-gap view.
 *   failed              — the run errored or was cancelled before producing.
 */
export type SignalFate =
  "extracted" | "no_insight" | "no_run" | "unprocessed_unbound" | "failed";

export interface SignalLinks {
  /** The extraction run this message opened (null when unprocessed_unbound). */
  runId: string | null;
  /** The run's correlationId (== runId for a root automation run); null if none. */
  correlationId: string | null;
  /** Entities the run's proposals target/materialized (capped). */
  producedEntityIds: string[];
  /** The run's produced proposals (`correlationId = runId`), capped. */
  proposalIds: string[];
  /** The inbound message row this unit is about (`messages.id`). */
  sourceMessageId: string;
}

export interface SignalUnit {
  /** Stable id for the unit = the source message id. */
  id: string;
  /** Provider the inbound came from (channels.externalSource). */
  source: string | null;
  channel: {
    id: string;
    name: string | null;
    /** The context entity the channel is bound to, if any. */
    boundEntityId: string | null;
    /** True when the channel is bound to a context entity. */
    bound: boolean;
  };
  /** When the inbound message landed. */
  ts: Date;
  fate: SignalFate;
  links: SignalLinks;
  /** One-line preview of the inbound content. */
  summary: string | null;
}

// ── Pure classifiers (unit-testable without a DB) ─────────────────────────────

/**
 * Derive a signal unit's fate from its attributed run + produced-proposal count.
 * Pure: the query layer feeds it the facts it already loaded.
 */
export function classifySignalFate(input: {
  hasRun: boolean;
  /** Whether the message's channel is bound to a context entity. */
  bound: boolean;
  runStatus: RunStatus | null;
  producedCount: number;
}): SignalFate {
  if (!input.hasRun)
    // No run consumed the message. Split on wiring: a BOUND channel that ran
    // nothing is a real miss (`no_run`); an UNBOUND channel was never wired.
    return input.bound ? "no_run" : "unprocessed_unbound";
  // A terminal non-success end (errored or aborted) never produced a clean
  // outcome — the pipeline broke on this message.
  if (input.runStatus === "failed" || input.runStatus === "cancelled")
    return "failed";
  if (input.producedCount > 0) return "extracted";
  // completed / skipped / still-running with nothing produced yet.
  return "no_insight";
}

/** Problems-first priority (lower = shown first). */
const FATE_PROBLEM_RANK: Record<SignalFate, number> = {
  failed: 0,
  unprocessed_unbound: 1,
  no_run: 2,
  no_insight: 3,
  extracted: 4,
};

interface AttributableMessage {
  id: string;
  channelId: string;
  ts: Date;
}
interface AttributableRun {
  id: string;
  channelId: string;
  startedAt: Date;
}

/**
 * Attribute each message to the run it opened: the earliest run on the same
 * channel whose `startedAt` is at/after the message and strictly before the NEXT
 * message on that channel. Pure + deterministic. Returns messageId → runId.
 *
 * A small negative skew is tolerated on the lower bound so a run whose
 * `startedAt` is a beat before the message's stored `timestamp` (clock skew
 * across the ingest → matcher hop) still attributes to that message.
 */
const ATTRIBUTION_SKEW_MS = 5_000;

/**
 * How far BEFORE a run's `startedAt` its source message may have landed, for the
 * reverse-provenance window. Each inbound external message opens its own run
 * almost immediately, but the matcher hop can lag under queue pressure — a
 * generous few minutes covers it without dragging in unrelated recent traffic.
 * The UPPER bound is `startedAt + ATTRIBUTION_SKEW_MS` (a run can't be fed by a
 * message that landed after it, modulo clock skew) — this is what stops a
 * months-old run from resolving to today's messages on the same channel.
 */
const PROVENANCE_WINDOW_MS = 5 * 60_000;

export function attributeRunsToMessages(
  msgs: AttributableMessage[],
  runs: AttributableRun[]
): Map<string, string> {
  const out = new Map<string, string>();
  // Group + sort ascending per channel so windows are contiguous.
  const msgsByChannel = new Map<string, AttributableMessage[]>();
  for (const m of msgs) {
    const arr = msgsByChannel.get(m.channelId) ?? [];
    arr.push(m);
    msgsByChannel.set(m.channelId, arr);
  }
  const runsByChannel = new Map<string, AttributableRun[]>();
  for (const r of runs) {
    const arr = runsByChannel.get(r.channelId) ?? [];
    arr.push(r);
    runsByChannel.set(r.channelId, arr);
  }
  for (const [channelId, channelMsgs] of msgsByChannel) {
    const channelRuns = (runsByChannel.get(channelId) ?? [])
      .slice()
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    if (channelRuns.length === 0) continue;
    const ordered = channelMsgs
      .slice()
      .sort((a, b) => a.ts.getTime() - b.ts.getTime());
    const takenRuns = new Set<string>();
    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i];
      const lower = m.ts.getTime() - ATTRIBUTION_SKEW_MS;
      const upper = ordered[i + 1]?.ts.getTime() ?? Infinity;
      const hit = channelRuns.find(
        (r) =>
          !takenRuns.has(r.id) &&
          r.startedAt.getTime() >= lower &&
          r.startedAt.getTime() < upper
      );
      if (hit) {
        out.set(m.id, hit.id);
        takenRuns.add(hit.id);
      }
    }
  }
  return out;
}

// ── Query layer ───────────────────────────────────────────────────────────────

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
const PRODUCED_CAP = 50;

export interface ListPipelineInput {
  userId: string;
  limit?: number;
  /**
   * Composite keyset lower bound (the prior page's last unit). `messages.timestamp`
   * is NOT unique (bulk imports share a millisecond), so the cursor carries the
   * timestamp AND the tie-breaking message id; the read continues at
   * `(timestamp < before) OR (timestamp = before AND id < beforeId)`.
   */
  before?: Date;
  beforeId?: string;
  /** `recent` = newest-first (default). `problems` = failed/misses first (page-local). */
  order?: "recent" | "problems";
}

export interface SignalPipelinePage {
  units: SignalUnit[];
  /**
   * Composite cursor for the next page — `"<iso>|<lastMessageId>"`; null at the
   * end. Carries the tie-breaker id so equal-timestamp rows never straddle a
   * page boundary (dropped or duplicated).
   */
  nextCursor: string | null;
}

/**
 * The unified signal stream: recent inbound external messages joined to their
 * extraction outcome. Newest-first (or problems-first within the page).
 */
export async function listPipeline(
  input: ListPipelineInput
): Promise<SignalPipelinePage> {
  const { userId } = input;
  const limit = Math.min(input.limit ?? DEFAULT_PAGE, MAX_PAGE);

  // 1. Page of inbound external messages, floored by channelVisibilityWhere
  //    (the canonical channel read predicate) — a message is visible iff its
  //    channel is. Joined to channels for provider + binding metadata.
  const msgRows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      ts: messages.timestamp,
      content: messages.content,
      channelName: channels.title,
      provider: channels.externalSource,
      boundEntityId: channels.contextObjectId,
    })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(
      and(
        eq(messages.authorType, MessageAuthorType.EXTERNAL),
        isNull(messages.deletedAt),
        eq(messages.ephemeral, false),
        // Composite keyset on (timestamp, id): strictly-earlier timestamps, plus
        // the equal-timestamp rows whose id sorts before the cursor's — so a page
        // boundary that lands mid-way through a block of equal-timestamp rows
        // (bulk import) neither drops nor duplicates any of them.
        input.before
          ? input.beforeId
            ? or(
                lt(messages.timestamp, input.before),
                and(
                  eq(messages.timestamp, input.before),
                  lt(messages.id, input.beforeId)
                )
              )
            : lt(messages.timestamp, input.before)
          : undefined,
        // Access floor — identical predicate to every channel/message read.
        channelVisibilityWhere(userId)
      )
    )
    .orderBy(desc(messages.timestamp), desc(messages.id))
    .limit(limit);

  if (msgRows.length === 0) return { units: [], nextCursor: null };

  const channelIds = [...new Set(msgRows.map((m) => m.channelId))];

  // 2. Candidate extraction runs: external-message-triggered automation runs on
  //    those channels, user-floored (same predicate listRuns uses). The trigger
  //    payload records the triggering channel under `data.channelId`.
  //
  //    NOTE: do NOT use `->>'channelId' = ANY(${channelIds})` — binding a JS
  //    array into the SQL template serializes it as a Postgres array literal,
  //    which the pod image's postgres.js driver FAULTS on (same class of gotcha
  //    as `sql.json()`). An OR of scalar `=` params is the portable form
  //    (mirrors playbooks.matchForEntity / automations.matchForEntity).
  //    `channelIds` is always non-empty here (msgRows short-circuited above),
  //    but guard anyway so a future caller can't produce an empty `or()` that
  //    silently drops the channel filter and returns EVERY run.
  const runRows =
    channelIds.length === 0
      ? []
      : await db
          .select({
            id: automationRuns.id,
            status: automationRuns.status,
            startedAt: automationRuns.startedAt,
            channelId: drizzleSql<
              string | null
            >`${automationRuns.triggerPayload}->'data'->>'channelId'`,
          })
          .from(automationRuns)
          .where(
            and(
              userVisibleWhere(automationRuns.workspaceId, userId),
              drizzleSql`${automationRuns.triggerPayload}->>'eventType' LIKE 'external_message.received%'`,
              or(
                ...channelIds.map(
                  (id) =>
                    drizzleSql`${automationRuns.triggerPayload}->'data'->>'channelId' = ${id}`
                )
              )
            )
          )
          .orderBy(desc(automationRuns.startedAt));

  const runs: AttributableRun[] = runRows
    .filter((r): r is typeof r & { channelId: string } => !!r.channelId)
    .map((r) => ({ id: r.id, channelId: r.channelId, startedAt: r.startedAt }));
  const runStatusById = new Map<string, RunStatus>(
    runRows.map((r) => [r.id, r.status as RunStatus])
  );

  // 3. Attribute each message to its run (channel + time-window, pure).
  const msgToRun = attributeRunsToMessages(
    msgRows.map((m) => ({ id: m.id, channelId: m.channelId, ts: m.ts })),
    runs
  );
  const attributedRunIds = [...new Set(msgToRun.values())];

  // 4. What each attributed run PRODUCED — proposals keyed by correlationId=runId
  //    (the executor's stamp). User-floored. Entity targets are the produced
  //    entities (create/update proposals whose target IS an entity).
  const proposalsByRun = new Map<
    string,
    { proposalIds: string[]; entityIds: Set<string> }
  >();
  if (attributedRunIds.length > 0) {
    const propRows = await db
      .select({
        id: proposals.id,
        correlationId: proposals.correlationId,
        targetType: proposals.targetType,
        targetId: proposals.targetId,
        data: proposals.data,
      })
      .from(proposals)
      .where(
        and(
          inArray(proposals.correlationId, attributedRunIds),
          userVisibleWhere(proposals.workspaceId, userId)
        )
      )
      // Deterministic order: an UNORDERED limit lets Postgres return an
      // arbitrary slice, which can zero out a run's proposals and misclassify
      // an extracted signal as `no_insight`. Group by run, oldest-first within.
      .orderBy(proposals.correlationId, proposals.createdAt)
      .limit(PRODUCED_CAP * Math.max(attributedRunIds.length, 1));
    for (const p of propRows) {
      if (!p.correlationId) continue;
      const bucket = proposalsByRun.get(p.correlationId) ?? {
        proposalIds: [],
        entityIds: new Set<string>(),
      };
      if (bucket.proposalIds.length < PRODUCED_CAP)
        bucket.proposalIds.push(p.id);
      if (p.targetType === "entity" && p.targetId)
        bucket.entityIds.add(p.targetId);
      // Capture-graph proposals carry their materialized entities in the blob.
      const materialized = (
        p.data as { materialized?: { entityIds?: unknown } }
      )?.materialized;
      if (Array.isArray(materialized?.entityIds)) {
        for (const eid of materialized.entityIds)
          if (typeof eid === "string") bucket.entityIds.add(eid);
      }
      proposalsByRun.set(p.correlationId, bucket);
    }
  }

  // 5. Assemble the units + derive fate.
  const units: SignalUnit[] = msgRows.map((m) => {
    const runId = msgToRun.get(m.id) ?? null;
    const produced = runId ? proposalsByRun.get(runId) : undefined;
    const producedCount = produced?.proposalIds.length ?? 0;
    const fate = classifySignalFate({
      hasRun: runId != null,
      bound: m.boundEntityId != null,
      runStatus: runId ? (runStatusById.get(runId) ?? null) : null,
      producedCount,
    });
    return {
      id: m.id,
      source: m.provider ?? null,
      channel: {
        id: m.channelId,
        name: m.channelName ?? null,
        boundEntityId: m.boundEntityId ?? null,
        bound: m.boundEntityId != null,
      },
      ts: m.ts,
      fate,
      links: {
        runId,
        // A root automation run's produced proposals carry correlationId=runId.
        correlationId: runId,
        producedEntityIds: produced ? [...produced.entityIds] : [],
        proposalIds: produced?.proposalIds ?? [],
        sourceMessageId: m.id,
      },
      summary: m.content ? m.content.slice(0, 120) : null,
    };
  });

  if (input.order === "problems") {
    // Page-local reorder: surface failures + misses first, then newest-first.
    units.sort((a, b) => {
      const rank = FATE_PROBLEM_RANK[a.fate] - FATE_PROBLEM_RANK[b.fate];
      return rank !== 0 ? rank : b.ts.getTime() - a.ts.getTime();
    });
  }

  // Cursor is always keyed on the DB sort — the composite `(timestamp, id)`
  // keyset — independent of page order. Carrying the id tie-breaks equal
  // timestamps so the next page resumes exactly where this one ended.
  const oldest = msgRows[msgRows.length - 1];
  const nextCursor =
    msgRows.length === limit ? `${oldest.ts.toISOString()}|${oldest.id}` : null;

  return { units, nextCursor };
}

// ── Door 2: reverse provenance ────────────────────────────────────────────────

export type ProvenanceRefKind = "proposal" | "entity" | "run";

export interface ProvenanceInput {
  userId: string;
  kind: ProvenanceRefKind;
  id: string;
}

export interface ProvenanceMessage {
  id: string;
  channelId: string;
  channelName: string | null;
  provider: string | null;
  ts: Date;
  preview: string | null;
  boundEntityId: string | null;
}

export interface ProvenanceResult {
  /** The run the ref resolved through (when one exists). */
  runId: string | null;
  correlationId: string | null;
  /** The source message(s) that fed the run/proposal. */
  messages: ProvenanceMessage[];
}

/**
 * The inverse of the forward pipeline: given a proposal / entity / run id,
 * resolve BACK to the inbound source message(s) + their channel. Every read is
 * access-floored (userVisibleWhere on proposals/runs, channelVisibilityWhere on
 * messages), so a ref the caller cannot see resolves to nothing rather than
 * leaking a source.
 */
export async function resolveProvenance(
  input: ProvenanceInput
): Promise<ProvenanceResult> {
  const { userId, kind, id } = input;

  // Resolve to a set of candidate run ids + a direct sourceMessageId (if any).
  let runIds: string[] = [];
  let directMessageId: string | null = null;
  let correlationId: string | null = null;

  if (kind === "run") {
    runIds = [id];
    correlationId = id;
  } else if (kind === "proposal") {
    const [p] = await db
      .select({
        sourceMessageId: proposals.sourceMessageId,
        correlationId: proposals.correlationId,
        threadId: proposals.threadId,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.id, id),
          userVisibleWhere(proposals.workspaceId, userId)
        )
      )
      .limit(1);
    if (!p) return { runId: null, correlationId: null, messages: [] };
    directMessageId = p.sourceMessageId ?? null;
    correlationId = p.correlationId ?? null;
    // The correlationId of an automation-produced proposal IS its run id.
    if (p.correlationId) runIds = [p.correlationId];
  } else {
    // entity — find the proposals that produced it, then their runs.
    const propRows = await db
      .select({
        correlationId: proposals.correlationId,
        sourceMessageId: proposals.sourceMessageId,
      })
      .from(proposals)
      .where(
        and(
          or(
            and(eq(proposals.targetType, "entity"), eq(proposals.targetId, id)),
            drizzleSql`${proposals.data}->'materialized'->'entityIds' @> ${JSON.stringify(
              [id]
            )}::jsonb`
          ),
          userVisibleWhere(proposals.workspaceId, userId)
        )
      )
      .limit(PRODUCED_CAP);
    runIds = [
      ...new Set(
        propRows
          .map((p) => p.correlationId)
          .filter((c): c is string => typeof c === "string")
      ),
    ];
    directMessageId =
      propRows.find((p) => p.sourceMessageId)?.sourceMessageId ?? null;
    correlationId = runIds[0] ?? null;
  }

  const provMessages = new Map<string, ProvenanceMessage>();
  const addMessages = async (where: ReturnType<typeof and>) => {
    const rows = await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        ts: messages.timestamp,
        content: messages.content,
        channelName: channels.title,
        provider: channels.externalSource,
        boundEntityId: channels.contextObjectId,
      })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(where)
      .orderBy(desc(messages.timestamp))
      .limit(PRODUCED_CAP);
    for (const r of rows) {
      provMessages.set(r.id, {
        id: r.id,
        channelId: r.channelId,
        channelName: r.channelName ?? null,
        provider: r.provider ?? null,
        ts: r.ts,
        preview: r.content ? r.content.slice(0, 120) : null,
        boundEntityId: r.boundEntityId ?? null,
      });
    }
  };

  // Direct link — a proposal that recorded its own sourceMessageId (chat/agent
  // turn path). Access-floored via channelVisibilityWhere.
  if (directMessageId) {
    await addMessages(
      and(eq(messages.id, directMessageId), channelVisibilityWhere(userId))
    );
  }

  // Run-derived link — the channel(s) the run's trigger fired from, and the
  // inbound external messages on that channel WITHIN THE RUN'S TIME WINDOW.
  // Without the window this returned the newest messages on the channel
  // regardless of the run's age, so a months-old run resolved to today's
  // traffic. We bound to `[min(startedAt) - window, max(startedAt) + skew]`,
  // then prefer the exactly-attributed source message when the forward
  // channel+time-window map identifies it (falling back to the whole window).
  if (runIds.length > 0) {
    const runRows = await db
      .select({
        id: automationRuns.id,
        startedAt: automationRuns.startedAt,
        channelId: drizzleSql<
          string | null
        >`${automationRuns.triggerPayload}->'data'->>'channelId'`,
      })
      .from(automationRuns)
      .where(
        and(
          inArray(automationRuns.id, runIds),
          userVisibleWhere(automationRuns.workspaceId, userId)
        )
      );
    const runChannelIds = [
      ...new Set(
        runRows.map((r) => r.channelId).filter((c): c is string => !!c)
      ),
    ];
    if (runChannelIds.length > 0) {
      const startedTimes = runRows.map((r) => r.startedAt.getTime());
      const windowLo = new Date(
        Math.min(...startedTimes) - PROVENANCE_WINDOW_MS
      );
      const windowHi = new Date(
        Math.max(...startedTimes) + ATTRIBUTION_SKEW_MS
      );
      const candidates = await db
        .select({
          id: messages.id,
          channelId: messages.channelId,
          ts: messages.timestamp,
          content: messages.content,
          channelName: channels.title,
          provider: channels.externalSource,
          boundEntityId: channels.contextObjectId,
        })
        .from(messages)
        .innerJoin(channels, eq(channels.id, messages.channelId))
        .where(
          and(
            inArray(messages.channelId, runChannelIds),
            eq(messages.authorType, MessageAuthorType.EXTERNAL),
            isNull(messages.deletedAt),
            gte(messages.timestamp, windowLo),
            lte(messages.timestamp, windowHi),
            channelVisibilityWhere(userId)
          )
        )
        .orderBy(desc(messages.timestamp))
        .limit(PRODUCED_CAP);

      // Prefer the exact source: the forward channel+time-window attribution
      // pins each run to one message; when it resolves any, return only those.
      const exactMap = attributeRunsToMessages(
        candidates.map((m) => ({ id: m.id, channelId: m.channelId, ts: m.ts })),
        runRows
          .filter((r): r is typeof r & { channelId: string } => !!r.channelId)
          .map((r) => ({
            id: r.id,
            channelId: r.channelId,
            startedAt: r.startedAt,
          }))
      );
      const exactIds = new Set(exactMap.keys());
      const chosen =
        exactIds.size > 0
          ? candidates.filter((m) => exactIds.has(m.id))
          : candidates;
      for (const r of chosen) {
        provMessages.set(r.id, {
          id: r.id,
          channelId: r.channelId,
          channelName: r.channelName ?? null,
          provider: r.provider ?? null,
          ts: r.ts,
          preview: r.content ? r.content.slice(0, 120) : null,
          boundEntityId: r.boundEntityId ?? null,
        });
      }
    }
  }

  return {
    runId: runIds[0] ?? null,
    correlationId,
    messages: [...provMessages.values()].sort(
      (a, b) => b.ts.getTime() - a.ts.getTime()
    ),
  };
}

// ── Door 3: pod-wide summary ──────────────────────────────────────────────────

/**
 * Pod-wide signal aggregates for the attention band. The band must show GLOBAL
 * totals, not a rollup over the units currently paged in (which reads as global
 * but isn't). Each field is an independent, cheap COUNT, floored by the SAME
 * predicates the pipeline uses — `channelVisibilityWhere` for message/channel
 * reads, `userVisibleWhere` for run/proposal reads. They are NOT a partition of
 * `messages24h` (each answers its own question); the browser presents them as
 * distinct tiles, not a stacked bar.
 */
export interface SignalSummary {
  /** Inbound external messages that landed in the last 24h. */
  messages24h: number;
  /**
   * External-message-triggered runs in the last 24h that produced ≥1 proposal
   * (the pipeline yielded insight). Includes bookmark runs — documented
   * contract; the UI copy caveats it.
   */
  extracted: number;
  /** External-message-triggered runs that ran at all in the last 24h. */
  processed: number;
  /**
   * Proposals awaiting the caller's decision (PENDING + APPROVAL_FAILED),
   * pod-wide — the same actionable set `notif-center.pendingDecisionCount` and
   * `proposals.list` (default status) return.
   */
  needsYou: number;
  /**
   * Channels receiving external signal in the last 24h that are NOT bound to a
   * context entity — the structural wiring gap (`unprocessed_unbound` fate).
   */
  unboundChannels: number;
  /**
   * Inbound external messages (last 24h) on BOUND channels for which no
   * external-message run exists on that channel — the `no_run` miss, pod-wide.
   */
  noRun: number;
}

export async function getSignalSummary(userId: string): Promise<SignalSummary> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const externalRun = drizzleSql`${automationRuns.triggerPayload}->>'eventType' LIKE 'external_message.received%'`;

  const [
    messages24hRow,
    extractedRow,
    processedRow,
    needsYouRow,
    unboundChannelsRow,
    noRunRow,
  ] = await Promise.all([
    // 1. Inbound external messages in the window.
    db
      .select({ value: count() })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          eq(messages.authorType, MessageAuthorType.EXTERNAL),
          isNull(messages.deletedAt),
          eq(messages.ephemeral, false),
          gte(messages.timestamp, since),
          channelVisibilityWhere(userId)
        )
      ),
    // 2. External-message runs (window) that produced ≥1 proposal.
    db
      .select({ value: count() })
      .from(automationRuns)
      .where(
        and(
          userVisibleWhere(automationRuns.workspaceId, userId),
          externalRun,
          gte(automationRuns.startedAt, since),
          exists(
            db
              .select({ one: drizzleSql`1` })
              .from(proposals)
              .where(
                and(
                  eq(proposals.correlationId, automationRuns.id),
                  userVisibleWhere(proposals.workspaceId, userId)
                )
              )
          )
        )
      ),
    // 3. External-message runs that ran at all in the window.
    db
      .select({ value: count() })
      .from(automationRuns)
      .where(
        and(
          userVisibleWhere(automationRuns.workspaceId, userId),
          externalRun,
          gte(automationRuns.startedAt, since)
        )
      ),
    // 4. Proposals awaiting the caller's decision (pod-wide).
    db
      .select({ value: count() })
      .from(proposals)
      .where(
        and(
          userVisibleWhere(proposals.workspaceId, userId),
          inArray(proposals.status, [
            ProposalStatus.PENDING,
            ProposalStatus.APPROVAL_FAILED,
          ])
        )
      ),
    // 5. Channels with recent external signal that are NOT bound to a context
    //    entity — count the channels, not the messages.
    db
      .select({ value: count() })
      .from(channels)
      .where(
        and(
          isNotNull(channels.externalSource),
          isNull(channels.contextObjectId),
          channelVisibilityWhere(userId),
          exists(
            db
              .select({ one: drizzleSql`1` })
              .from(messages)
              .where(
                and(
                  eq(messages.channelId, channels.id),
                  eq(messages.authorType, MessageAuthorType.EXTERNAL),
                  isNull(messages.deletedAt),
                  gte(messages.timestamp, since)
                )
              )
          )
        )
      ),
    // 6. Inbound external messages (window) on BOUND channels with no
    //    external-message run on that channel — the pod-wide `no_run` miss.
    db
      .select({ value: count() })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          eq(messages.authorType, MessageAuthorType.EXTERNAL),
          isNull(messages.deletedAt),
          eq(messages.ephemeral, false),
          gte(messages.timestamp, since),
          isNotNull(channels.contextObjectId),
          channelVisibilityWhere(userId),
          not(
            exists(
              db
                .select({ one: drizzleSql`1` })
                .from(automationRuns)
                .where(
                  and(
                    userVisibleWhere(automationRuns.workspaceId, userId),
                    externalRun,
                    drizzleSql`${automationRuns.triggerPayload}->'data'->>'channelId' = ${messages.channelId}::text`
                  )
                )
            )
          )
        )
      ),
  ]);

  return {
    messages24h: messages24hRow[0]?.value ?? 0,
    extracted: extractedRow[0]?.value ?? 0,
    processed: processedRow[0]?.value ?? 0,
    needsYou: needsYouRow[0]?.value ?? 0,
    unboundChannels: unboundChannelsRow[0]?.value ?? 0,
    noRun: noRunRow[0]?.value ?? 0,
  };
}
