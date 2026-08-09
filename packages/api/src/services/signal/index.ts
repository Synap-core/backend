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
  automations,
  proposals,
  links,
  tools,
  capabilities,
  channelEgress,
  MessageAuthorType,
  ProposalStatus,
} from "@synap/database";
import type { FlowDefinition } from "@synap/database";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { getCapabilityMemberParts } from "../links/links-service.js";
import { buildCapabilityComposition } from "../diagnose/capability-composition.js";
import type { CapabilityComposition } from "../diagnose/types.js";
import type { RunStatus } from "../runs/types.js";

// ── Channel-object doors (the Stack + Rerun facets) ───────────────────────────
export {
  getChannelStack,
  summarizeAutomationTrigger,
  type ChannelStackResult,
  type ChannelStackAutomation,
  type ChannelStackOrigin,
  type ChannelStackExternal,
} from "./channel-stack.js";
export {
  resolveChannelRerun,
  pickPrimaryChannelAutomation,
  type ResolvedChannelRerun,
} from "./channel-rerun.js";
export {
  classifyChannelAutomationBinding,
  matchesEventPattern,
  CHANNEL_EVENT_TYPES,
  type ChannelAutomationBinding,
} from "./channel-automation-binding.js";

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
 *   suppressed          — a run consumed the message but was SKIPPED by design: a
 *                         flow-level precondition/filter evaluated false at start,
 *                         so the run finalized (`status = 'skipped'`) before any
 *                         step executed. A CORRECT no-op ("filtered on purpose"),
 *                         NOT a failure and NOT `no_insight` (which is a run that
 *                         ran fully yet produced nothing). This is the honesty gap
 *                         Zapier calls its #1 confusion: an intentional filter must
 *                         never read as a broken pipeline.
 *   failed              — the run errored or was cancelled before producing.
 */
export type SignalFate =
  | "extracted"
  | "no_insight"
  | "no_run"
  | "unprocessed_unbound"
  | "suppressed"
  | "failed";

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
  // A SKIPPED run was gated by a flow-level precondition BEFORE any step ran
  // (automation_runs.status = 'skipped', Wave 4.V3) — an intentional filter, a
  // correct no-op. Distinct from `no_insight` (ran fully, found nothing) and from
  // `failed` (broke). A skipped run produces nothing by construction, so this is
  // checked before the produced-count branch.
  if (input.runStatus === "skipped") return "suppressed";
  if (input.producedCount > 0) return "extracted";
  // completed / still-running with nothing produced yet.
  return "no_insight";
}

/** Problems-first priority (lower = shown first). */
const FATE_PROBLEM_RANK: Record<SignalFate, number> = {
  failed: 0,
  unprocessed_unbound: 1,
  no_run: 2,
  no_insight: 3,
  extracted: 4,
  // A suppressed unit is a correct no-op — ranked last (least "problem"), below
  // even `extracted`, so an intentional filter never floats to the top of a
  // problems-first stream.
  suppressed: 5,
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
  /**
   * Drill-down: scope the returned units to a SINGLE channel. When set, the
   * keyset + order behavior is preserved within that channel's message set —
   * everything downstream (run attribution, proposal join, fate) is unchanged.
   */
  channelId?: string;
  /**
   * Capability lens: scope the stream to the channels this capability PRODUCED
   * (`resolveCapabilityChannelIds`). Composes with `channelId`. Inbound only —
   * the outbound side is the sibling `listEgress` door (P3), not a param here.
   */
  capabilityId?: string;
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
 * The floored message row shape every signal read starts from — an inbound
 * external message joined to its channel's provider + binding. Both `listPipeline`
 * and `listChannels` produce this same shape, then hand it to `assembleUnits`.
 */
interface PipelineMessageRow {
  id: string;
  channelId: string;
  ts: Date;
  content: string | null;
  channelName: string | null;
  provider: string | null;
  boundEntityId: string | null;
}

/**
 * Attribute each floored message to its extraction run + produced proposals and
 * derive its fate — the shared core of `listPipeline` (the flat stream) and
 * `listChannels` (the per-channel rollup). Keeping this ONE function guarantees
 * a channel's fate-mix agrees unit-for-unit with the pipeline's per-unit fate
 * (`classifySignalFate` stays the single fate source), and both readings reuse
 * the SAME run/proposal floor (`userVisibleWhere`) — no floor divergence.
 *
 * The caller supplies the message rows already floored by `channelVisibilityWhere`,
 * so an unseeable channel/message never reaches here.
 */
async function assembleUnits(
  msgRows: PipelineMessageRow[],
  userId: string
): Promise<SignalUnit[]> {
  if (msgRows.length === 0) return [];

  const channelIds = [...new Set(msgRows.map((m) => m.channelId))];

  // Time-window the candidate runs to the span of the messages we're classifying.
  // Without this the fetch is unbounded in time AND rows — it pulls EVERY
  // external-message run ever recorded on these channels (latent in listPipeline,
  // badly amplified by listChannels, which scans up to CHANNEL_SCAN_CAP messages
  // across the whole channel set). A run relevant to any message here must have
  // started within the attribution window of some message: attribution pins a
  // run to a message when `startedAt ∈ [msg.ts − ATTRIBUTION_SKEW_MS, msg.ts +
  // lag)`, and the matcher lag is bounded by PROVENANCE_WINDOW_MS. So across all
  // messages, only runs in `[minMsgTs − ATTRIBUTION_SKEW_MS, maxMsgTs +
  // PROVENANCE_WINDOW_MS]` can attribute. This is the INVERSE of
  // resolveProvenance's window (which anchors on a run and searches messages, so
  // its bounds are −window/+skew); here we anchor on messages and search runs, so
  // the run may start slightly BEFORE (skew) or up to a lag AFTER each message.
  const msgTimes = msgRows.map((m) => m.ts.getTime());
  const runWindowLo = new Date(Math.min(...msgTimes) - ATTRIBUTION_SKEW_MS);
  const runWindowHi = new Date(Math.max(...msgTimes) + PROVENANCE_WINDOW_MS);

  // Candidate extraction runs: external-message-triggered automation runs on
  // those channels, user-floored (same predicate listRuns uses). The trigger
  // payload records the triggering channel under `data.channelId`.
  //
  // NOTE: do NOT use `->>'channelId' = ANY(${channelIds})` — binding a JS
  // array into the SQL template serializes it as a Postgres array literal,
  // which the pod image's postgres.js driver FAULTS on (same class of gotcha
  // as `sql.json()`). An OR of scalar `=` params is the portable form
  // (mirrors playbooks.matchForEntity / automations.matchForEntity).
  // `channelIds` is always non-empty here (msgRows short-circuited above),
  // but guard anyway so a future caller can't produce an empty `or()` that
  // silently drops the channel filter and returns EVERY run.
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
              // Bound to the message span (see runWindowLo/Hi above) — the fetch
              // is now proportional to the data being classified, not all history.
              gte(automationRuns.startedAt, runWindowLo),
              lte(automationRuns.startedAt, runWindowHi),
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

  // Attribute each message to its run (channel + time-window, pure).
  const msgToRun = attributeRunsToMessages(
    msgRows.map((m) => ({ id: m.id, channelId: m.channelId, ts: m.ts })),
    runs
  );
  const attributedRunIds = [...new Set(msgToRun.values())];

  // What each attributed run PRODUCED — proposals keyed by correlationId=runId
  // (the executor's stamp). User-floored. Entity targets are the produced
  // entities (create/update proposals whose target IS an entity).
  const proposalsByRun = new Map<
    string,
    { proposalIds: string[]; entityIds: Set<string> }
  >();
  if (attributedRunIds.length > 0) {
    // Per-run cap at the DB layer via a windowed row_number, NOT a global
    // `ORDER BY correlationId LIMIT cap*numRuns`. A global limit lets ONE
    // high-volume run (lowest correlationId sorts first) consume the whole
    // budget, starving every later run to zero proposals — which misclassifies
    // an `extracted` signal as `no_insight`. row_number() PARTITIONed per run
    // guarantees each run gets its own PRODUCED_CAP slice, oldest-first.
    const ranked = db
      .select({
        id: proposals.id,
        correlationId: proposals.correlationId,
        targetType: proposals.targetType,
        targetId: proposals.targetId,
        data: proposals.data,
        rn: drizzleSql<number>`row_number() over (partition by ${proposals.correlationId} order by ${proposals.createdAt} asc)`.as(
          "rn"
        ),
      })
      .from(proposals)
      .where(
        and(
          inArray(proposals.correlationId, attributedRunIds),
          userVisibleWhere(proposals.workspaceId, userId)
        )
      )
      .as("ranked");
    const propRows = await db
      .select({
        id: ranked.id,
        correlationId: ranked.correlationId,
        targetType: ranked.targetType,
        targetId: ranked.targetId,
        data: ranked.data,
      })
      .from(ranked)
      .where(lte(ranked.rn, PRODUCED_CAP));
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

  // Assemble the units + derive fate.
  return msgRows.map((m) => {
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
}

// ── Capability lens: the channels one capability PRODUCED ─────────────────────

/**
 * Resolve the visible channels a capability is the source of — the scope every
 * `capabilityId`-filtered signal read narrows to. Derivation is a pure read-join
 * over edges the pod already writes, NO new produced writes:
 *
 *   capability --member_of<-- tool --produced--> channel        (the graph path)
 *   ∪  channels WHERE externalSource = the tool's provider slug (legacy fallback)
 *
 * The member tools' NAMES are provider slugs (`tools.name` == provider slug), so
 * the fallback catches legacy channels born with a bare `source` slug origin
 * (pre-0234) that the graph path can't yet reach. Floored by
 * `channelVisibilityWhere`, so a channel the caller can't see never enters the
 * scope. Returns `[]` when the capability produces nothing (→ empty lens).
 */
export async function resolveCapabilityChannelIds(
  userId: string,
  capabilityId: string
): Promise<string[]> {
  // The capability container's runnable member parts (tool|skill|command).
  // REUSE HAZARD: this member read and the `tools` select below are deliberately
  // NOT workspace/user-floored — the access boundary is the TERMINAL channel
  // query at the end of this function, which carries `channelVisibilityWhere`.
  // Resolving a part/tool id the caller can't "see" leaks nothing on its own; a
  // channel only enters the scope if it survives that floor. Do NOT lift these
  // two reads out of this floored context (e.g. to return tool metadata to a
  // caller) without adding a floor of their own.
  const partIds = (await getCapabilityMemberParts([capabilityId])).map(
    (p) => p.id
  );
  if (partIds.length === 0) return [];

  // Member tools' names == provider slugs (the legacy-channel fallback key).
  const toolRows = await db
    .select({ id: tools.id, name: tools.name })
    .from(tools)
    .where(inArray(tools.id, partIds));
  const providerSlugs = [
    ...new Set(toolRows.map((t) => t.name).filter((n): n is string => !!n)),
  ];

  // Channels the parts PRODUCED: part --produced--> channel (post-0234 or
  // born-with-a-tool origin).
  const producedRows = await db
    .select({ channelId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.linkType, "produced"),
        eq(links.toType, "channel"),
        inArray(links.fromId, partIds)
      )
    );
  const producedChannelIds = producedRows.map((r) => r.channelId);

  if (producedChannelIds.length === 0 && providerSlugs.length === 0) return [];

  // Floor to visible channels, unioning the produced-edge channels with legacy
  // slug-origin channels of the same provider(s).
  //
  // HONESTY: the produced-edge half is capability-PRECISE (that specific tool
  // made the channel), but the `externalSource` slug half is provider-BROAD, not
  // capability-precise — a bare-slug channel (pre-0234, or an ambiguous origin
  // that couldn't be re-stamped) surfaces under EVERY capability whose member
  // tools include one with that provider slug. This over-includes on purpose so
  // legacy channels aren't invisible to the lens; migration 0234 shrinks the
  // fuzzy half over time as each source-slug origin is re-stamped to its
  // specific tool and moves into the precise produced-edge half.
  const channelRows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        channelVisibilityWhere(userId),
        or(
          producedChannelIds.length
            ? inArray(channels.id, producedChannelIds)
            : undefined,
          providerSlugs.length
            ? inArray(channels.externalSource, providerSlugs)
            : undefined
        )
      )
    );
  return [...new Set(channelRows.map((r) => r.id))];
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

  // Capability lens: resolve the capability's visible channels up front. An
  // empty set (capability produces nothing) short-circuits to an empty page.
  let capChannelIds: string[] | null = null;
  if (input.capabilityId) {
    capChannelIds = await resolveCapabilityChannelIds(
      userId,
      input.capabilityId
    );
    if (capChannelIds.length === 0) return { units: [], nextCursor: null };
  }

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
        // Drill-down: scope to one channel (the channel-detail view). The floor
        // below still applies, so an unseeable channelId returns nothing.
        input.channelId ? eq(messages.channelId, input.channelId) : undefined,
        // Capability lens: restrict to the capability's produced channels.
        capChannelIds ? inArray(messages.channelId, capChannelIds) : undefined,
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

  const units = await assembleUnits(msgRows, userId);

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

// ── Door: per-channel rollup (channel-first navigation spine) ─────────────────

/**
 * How many recent inbound external messages the channel rollup scans. A bounded,
 * cheap prefix of the SAME floored stream `listPipeline` pages — one indexed
 * `ORDER BY timestamp DESC LIMIT` read — grouped by channel in-memory. Channels
 * whose most recent activity falls entirely outside this prefix don't surface;
 * the rollup is an attention aid over recent signal, not a full historical census.
 */
const CHANNEL_SCAN_CAP = 1000;

export type SignalChannelOrder = "problems" | "recent";

export interface SignalChannelRollup {
  channelId: string;
  name: string | null;
  provider: string | null;
  /** True when the channel is bound to a context entity. */
  bound: boolean;
  boundEntityId: string | null;
  /** Inbound external messages seen for this channel within the scan prefix. */
  messageCount: number;
  /** `extracted / messageCount * 100`, rounded to an integer (0 when empty). */
  extractionRatePct: number;
  /** Per-fate counts over the same units — sums to `messageCount`. */
  fate: Record<SignalFate, number>;
  /** Most recent inbound message on the channel within the scan prefix. */
  lastActivityAt: Date;
}

export interface ListChannelsInput {
  userId: string;
  order?: SignalChannelOrder;
  /**
   * Capability lens: restrict the rollup to the channels this capability
   * PRODUCED (`resolveCapabilityChannelIds`). Same shapes as the unfiltered
   * rollup, just narrowed. Inbound only — the outbound rollup is the sibling
   * `listEgress` door (P3).
   */
  capabilityId?: string;
}

export interface ListChannelsResult {
  channels: SignalChannelRollup[];
  /** Inbound external messages actually scanned to build this rollup. */
  scanned: number;
  /**
   * True when the scan hit `CHANNEL_SCAN_CAP` — the rollup covers only the most
   * recent `scanned` messages, so per-channel counts/rates are a partial recent
   * census, not a whole-history total, and a channel active only OUTSIDE the
   * prefix may be absent. The caller MUST disclose this ("showing recent N")
   * rather than presenting the numbers as complete.
   */
  truncated: boolean;
}

/**
 * Per-channel rollup over the same window/floors as `listPipeline`: group the
 * recent floored signal units by channel and summarize each channel's fate-mix,
 * message volume, extraction rate, and binding.
 *
 * A channel is a "problem" when it is unbound (no context entity) OR carries ≥1
 * `failed` unit. `problems` order (default) floats problems first, then lowest
 * extraction rate, then most recent; `recent` orders purely by last activity.
 *
 * Returns `{ channels, scanned, truncated }` — `truncated` is the honesty
 * signal: the rollup scans at most `CHANNEL_SCAN_CAP` recent messages, so on a
 * high-volume pod the per-channel numbers are a partial recent census and the
 * caller must say so.
 */
export async function listChannels(
  input: ListChannelsInput
): Promise<ListChannelsResult> {
  const { userId } = input;

  // Capability lens: resolve the capability's visible channels; an empty set
  // short-circuits to an empty rollup.
  let capChannelIds: string[] | null = null;
  if (input.capabilityId) {
    capChannelIds = await resolveCapabilityChannelIds(
      userId,
      input.capabilityId
    );
    if (capChannelIds.length === 0)
      return { channels: [], scanned: 0, truncated: false };
  }

  // Same floored message read as listPipeline — a bounded recent prefix, no
  // cursor. `channelVisibilityWhere` is the ONLY channel/message floor, so an
  // unseeable channel never enters the rollup.
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
        channelVisibilityWhere(userId),
        // Capability lens: restrict to the capability's produced channels.
        capChannelIds ? inArray(messages.channelId, capChannelIds) : undefined
      )
    )
    .orderBy(desc(messages.timestamp), desc(messages.id))
    .limit(CHANNEL_SCAN_CAP);

  const scanned = msgRows.length;
  const truncated = scanned === CHANNEL_SCAN_CAP;

  if (msgRows.length === 0)
    return { channels: [], scanned: 0, truncated: false };

  // Reuse the EXACT same attribution + fate classification as the flat stream,
  // so a channel's fate-mix agrees unit-for-unit with signal.pipeline.
  const units = await assembleUnits(msgRows, userId);

  const byChannel = new Map<string, SignalChannelRollup>();
  for (const u of units) {
    let roll = byChannel.get(u.channel.id);
    if (!roll) {
      roll = {
        channelId: u.channel.id,
        name: u.channel.name,
        provider: u.source,
        bound: u.channel.bound,
        boundEntityId: u.channel.boundEntityId,
        messageCount: 0,
        extractionRatePct: 0,
        fate: {
          extracted: 0,
          no_insight: 0,
          no_run: 0,
          unprocessed_unbound: 0,
          suppressed: 0,
          failed: 0,
        },
        lastActivityAt: u.ts,
      };
      byChannel.set(u.channel.id, roll);
    }
    roll.messageCount += 1;
    roll.fate[u.fate] += 1;
    if (u.ts.getTime() > roll.lastActivityAt.getTime())
      roll.lastActivityAt = u.ts;
  }

  const rollups = [...byChannel.values()];
  for (const r of rollups) {
    r.extractionRatePct =
      r.messageCount === 0
        ? 0
        : Math.round((r.fate.extracted / r.messageCount) * 100);
  }

  // A channel needs attention when it is UNBOUND (structural wiring gap) OR has
  // ≥1 failed unit (the pipeline broke on it).
  const isProblem = (r: SignalChannelRollup) => !r.bound || r.fate.failed > 0;

  if (input.order === "recent") {
    rollups.sort(
      (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime()
    );
  } else {
    // problems (default): problems first, then lowest extraction rate, then most
    // recent activity.
    rollups.sort((a, b) => {
      const ap = isProblem(a) ? 0 : 1;
      const bp = isProblem(b) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      if (a.extractionRatePct !== b.extractionRatePct)
        return a.extractionRatePct - b.extractionRatePct;
      return b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
    });
  }

  return { channels: rollups, scanned, truncated };
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

export async function getSignalSummary(
  userId: string,
  capabilityId?: string
): Promise<SignalSummary> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const externalRun = drizzleSql`${automationRuns.triggerPayload}->>'eventType' LIKE 'external_message.received%'`;

  // Capability lens: resolve the capability's visible channels once, then scope
  // every tile to them. An empty set (capability produces nothing) is an all-zero
  // summary. When `capabilityId` is omitted, every scope fragment is `undefined`
  // and each COUNT is byte-for-byte the pod-wide query it was before.
  const capChannelIds = capabilityId
    ? await resolveCapabilityChannelIds(userId, capabilityId)
    : null;
  if (capChannelIds && capChannelIds.length === 0) {
    return {
      messages24h: 0,
      extracted: 0,
      processed: 0,
      needsYou: 0,
      unboundChannels: 0,
      noRun: 0,
    };
  }
  // Message/channel-keyed scopes.
  const msgScope = capChannelIds
    ? inArray(messages.channelId, capChannelIds)
    : undefined;
  const chanScope = capChannelIds
    ? inArray(channels.id, capChannelIds)
    : undefined;
  // Run-keyed scope: the run's triggering channel (its `data.channelId`) is one
  // of the capability's channels. An OR of scalar `=` params (never a Postgres
  // array literal — same driver gotcha the run fetch documents).
  const runScope = capChannelIds
    ? or(
        ...capChannelIds.map(
          (id) =>
            drizzleSql`${automationRuns.triggerPayload}->'data'->>'channelId' = ${id}`
        )
      )
    : undefined;

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
          channelVisibilityWhere(userId),
          msgScope
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
          runScope,
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
          gte(automationRuns.startedAt, since),
          runScope
        )
      ),
    // 4. Proposals awaiting the caller's decision (pod-wide, or scoped to the
    //    capability's channels via the run that produced each proposal).
    db
      .select({ value: count() })
      .from(proposals)
      .where(
        and(
          userVisibleWhere(proposals.workspaceId, userId),
          inArray(proposals.status, [
            ProposalStatus.PENDING,
            ProposalStatus.APPROVAL_FAILED,
          ]),
          capChannelIds
            ? exists(
                db
                  .select({ one: drizzleSql`1` })
                  .from(automationRuns)
                  .where(
                    and(
                      eq(automationRuns.id, proposals.correlationId),
                      userVisibleWhere(automationRuns.workspaceId, userId),
                      runScope
                    )
                  )
              )
            : undefined
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
          chanScope,
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
          msgScope,
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

// ── Door 4: tune target (the feedback-loop deep-link) ─────────────────────────

export interface TuneTargetResult {
  /** The automation whose flow feeds this run (null if the run/automation is gone). */
  automationId: string | null;
  /** The automation's display name. */
  automationName: string | null;
  /**
   * The flow node to focus in the editor — the extraction step (an `ai.generate`
   * capability node). Null when the flow has no such node; the caller then opens
   * the flow without a focused node rather than guessing.
   */
  nodeId: string | null;
}

/**
 * The extraction node in a flow: the capability node running `ai.generate` (the
 * assessment/extraction step — e.g. arch-client-intelligence's `assess` node).
 * Falls back to the first capability/skill node, then null. NOT hardcoded to a
 * node id, so it works for any external-message extraction automation.
 */
export function findExtractionNodeId(
  flow: FlowDefinition | null | undefined
): string | null {
  const nodes = flow?.nodes;
  if (!nodes?.length) return null;
  const aiNode = nodes.find(
    (n) => n.type === "capability" && n.data?.verbId === "ai.generate"
  );
  if (aiNode) return aiNode.id;
  const anyStep = nodes.find(
    (n) => n.type === "capability" || n.type === "skill"
  );
  return anyStep?.id ?? null;
}

/**
 * Resolve a run to the flow node the user would edit to fix its extraction — the
 * "Tune extraction" deep-link target. Reads the run's owning automation (floored
 * by userVisibleWhere) and locates the `ai.generate` node in the automation's
 * CURRENT flow (not the run's snapshot — the user edits the live definition).
 * A run the caller cannot see, or one whose automation was deleted, resolves to
 * all-nulls rather than leaking.
 */
export async function resolveTuneTarget(
  userId: string,
  runId: string
): Promise<TuneTargetResult> {
  const [row] = await db
    .select({
      automationId: automations.id,
      automationName: automations.name,
      flowDefinition: automations.flowDefinition,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        eq(automationRuns.id, runId),
        userVisibleWhere(automationRuns.workspaceId, userId)
      )
    )
    .limit(1);

  if (!row) return { automationId: null, automationName: null, nodeId: null };
  return {
    automationId: row.automationId,
    automationName: row.automationName,
    nodeId: findExtractionNodeId(row.flowDefinition),
  };
}

// ── Door 5: quality-by-version (before/after the prompt change) ────────────────

/**
 * How many recent external-message runs the quality slice scans. Ordered newest-
 * first; on a high-volume pod an old version may fall outside the prefix, so the
 * result carries `truncated` for the caller to disclose (same honesty contract as
 * `listChannels`). Versions are usually days/weeks apart, so a generous cap keeps
 * both the before and after version in view without an unbounded scan.
 */
const QUALITY_RUN_SCAN_CAP = 2000;

export interface QualityVersionSlice {
  /** Automation `version` at run time (null for legacy/unsnapshotted runs). */
  version: number | null;
  /** External-message runs on this version within the scan prefix. */
  runs: number;
  /** Runs that produced ≥1 visible proposal. */
  extracted: number;
  /** `extracted / runs * 100`, rounded (0 when empty). */
  extractionRatePct: number;
  firstRunAt: Date;
  lastRunAt: Date;
}

export interface AutomationQuality {
  automationId: string;
  name: string | null;
  /** The automation's CURRENT version — the slice with this version is "now". */
  currentVersion: number | null;
  /** Version slices, newest version first; a null-version slice sorts last. */
  versions: QualityVersionSlice[];
}

export interface QualityByVersionResult {
  automations: AutomationQuality[];
  /** External-message runs scanned to build the slice. */
  scanned: number;
  /** True when the scan hit the cap — an older version may be under-counted. */
  truncated: boolean;
}

export interface QualityByVersionInput {
  userId: string;
  /** Scope to one automation; omit for all external-message automations. */
  automationId?: string;
}

/**
 * Extraction quality grouped by automation VERSION — the before/after proof that
 * a prompt change helped. For each external-message-triggered automation, split
 * its runs by the `definitionSnapshot.version` stamped at run time and report the
 * extraction rate per version. Reusing the version already stamped on every run
 * (no new ledger): after the user bumps the prompt (version++), the new version's
 * slice shows whether the rate moved. User-floored on runs AND proposals.
 */
export async function getQualityByVersion(
  input: QualityByVersionInput
): Promise<QualityByVersionResult> {
  const { userId, automationId } = input;
  const externalRun = drizzleSql`${automationRuns.triggerPayload}->>'eventType' LIKE 'external_message.received%'`;

  // 1. Recent external-message runs (floored), newest-first, capped.
  const runRows = await db
    .select({
      id: automationRuns.id,
      automationId: automationRuns.automationId,
      version: drizzleSql<
        number | null
      >`(${automationRuns.definitionSnapshot}->>'version')::int`,
      startedAt: automationRuns.startedAt,
    })
    .from(automationRuns)
    .where(
      and(
        userVisibleWhere(automationRuns.workspaceId, userId),
        externalRun,
        automationId ? eq(automationRuns.automationId, automationId) : undefined
      )
    )
    .orderBy(desc(automationRuns.startedAt))
    .limit(QUALITY_RUN_SCAN_CAP);

  const scanned = runRows.length;
  const truncated = scanned === QUALITY_RUN_SCAN_CAP;
  if (scanned === 0) return { automations: [], scanned: 0, truncated: false };

  // 2. Which of those runs produced ≥1 visible proposal (distinct correlationId).
  const runIds = runRows.map((r) => r.id);
  const producedRows = await db
    .select({ correlationId: proposals.correlationId })
    .from(proposals)
    .where(
      and(
        inArray(proposals.correlationId, runIds),
        userVisibleWhere(proposals.workspaceId, userId)
      )
    )
    .groupBy(proposals.correlationId);
  const producedRunIds = new Set(
    producedRows.map((r) => r.correlationId).filter((c): c is string => !!c)
  );

  // 3. Group in-memory by (automationId, version).
  interface Bucket {
    runs: number;
    extracted: number;
    firstRunAt: Date;
    lastRunAt: Date;
  }
  const byAutomation = new Map<string, Map<string, Bucket>>();
  for (const r of runRows) {
    const versionKey = r.version == null ? "null" : String(r.version);
    let versions = byAutomation.get(r.automationId);
    if (!versions) {
      versions = new Map();
      byAutomation.set(r.automationId, versions);
    }
    let b = versions.get(versionKey);
    if (!b) {
      b = {
        runs: 0,
        extracted: 0,
        firstRunAt: r.startedAt,
        lastRunAt: r.startedAt,
      };
      versions.set(versionKey, b);
    }
    b.runs += 1;
    if (producedRunIds.has(r.id)) b.extracted += 1;
    if (r.startedAt.getTime() < b.firstRunAt.getTime())
      b.firstRunAt = r.startedAt;
    if (r.startedAt.getTime() > b.lastRunAt.getTime())
      b.lastRunAt = r.startedAt;
  }

  // 4. Attach automation names + current version.
  const automationIds = [...byAutomation.keys()];
  const metaRows =
    automationIds.length === 0
      ? []
      : await db
          .select({
            id: automations.id,
            name: automations.name,
            version: automations.version,
          })
          .from(automations)
          .where(inArray(automations.id, automationIds));
  const metaById = new Map(metaRows.map((m) => [m.id, m]));

  const result: AutomationQuality[] = automationIds.map((aid) => {
    const meta = metaById.get(aid);
    const versions: QualityVersionSlice[] = [
      ...byAutomation.get(aid)!.entries(),
    ]
      .map(([vKey, b]) => ({
        version: vKey === "null" ? null : Number(vKey),
        runs: b.runs,
        extracted: b.extracted,
        extractionRatePct:
          b.runs === 0 ? 0 : Math.round((b.extracted / b.runs) * 100),
        firstRunAt: b.firstRunAt,
        lastRunAt: b.lastRunAt,
      }))
      // Newest version first; the null-version (legacy) slice sorts last.
      .sort((a, b) => {
        if (a.version == null) return 1;
        if (b.version == null) return -1;
        return b.version - a.version;
      });
    return {
      automationId: aid,
      name: meta?.name ?? null,
      currentVersion: meta?.version ?? null,
      versions,
    };
  });

  // Automations with the most recent activity first.
  result.sort((a, b) => {
    const aLast = Math.max(...a.versions.map((v) => v.lastRunAt.getTime()));
    const bLast = Math.max(...b.versions.map((v) => v.lastRunAt.getTime()));
    return bLast - aLast;
  });

  return { automations: result, scanned, truncated };
}

// ── Door 6: outbound egress rollup (the OUTBOUND half of the capability lens) ──
//
// The inbound reading (`listChannels`) groups `messages WHERE authorType =
// EXTERNAL` — what LANDED. Its mirror, the outbound reading, groups the SAME
// `messages` ledger the other way: `authorType IN (human, ai_agent)` on the same
// visible external channels — what the pod SENT toward the platform (an owner
// send mirrored by `sendExternalMessage`, or an approved agent reply). Zero new
// schema, the SAME `channelVisibilityWhere` floor, and — the reuse that makes it
// a true lens — the SAME `resolveCapabilityChannelIds` capability derivation P2
// uses, so a channel attributes to its capability identically in both directions.
//
// Two ledgers answer two different questions here (documented asymmetry, not a
// bug): `sentCount`/`lastSentAt` come from the `messages` ledger — universal
// across providers, a recent windowed census like `listChannels`; `failedCount`
// comes from the `channel_egress` outbox — the ONE ledger that records outbound-
// DELIVERY failure, but only for providers that route through the outbox (the
// bridge/Discord path). A provider that delivers inline (messaging via
// Unipile/Stalwart) writes no outbox row, so its `failedCount` is a genuine 0,
// never a hidden failure.

/**
 * Author types that count as OUTBOUND toward the external platform — a human send
 * or an (approved) agent reply. Excludes `external` (that IS the inbound signal)
 * and `bot` (internal system notices, not sent to the party).
 */
const OUTBOUND_AUTHOR_TYPES = [
  MessageAuthorType.HUMAN,
  MessageAuthorType.AI_AGENT,
] as const;

export type SignalEgressOrder = "problems" | "recent";

export interface SignalEgressChannelRollup {
  channelId: string;
  name: string | null;
  provider: string | null;
  /**
   * Outbound messages authored toward the platform (human + agent) within the
   * scan prefix — the symmetric mirror of the inbound `messageCount`.
   */
  sentCount: number;
  /**
   * Terminal-failed message sends (`kind = 'post_message'`, `status = 'failed'`)
   * in the `channel_egress` outbox for this channel's external target — the
   * failure counterpart of `sentCount`. 0 for providers that deliver inline
   * (which write no outbox row) — a genuine 0, not a hidden failure.
   */
  failedCount: number;
  /**
   * Most recent outbound message on the channel within the scan prefix; null when
   * the channel surfaces ONLY via a failed-egress row (every send failed, so no
   * message row was written).
   */
  lastSentAt: Date | null;
}

export interface ListEgressInput {
  userId: string;
  order?: SignalEgressOrder;
  /**
   * Capability lens: restrict the rollup to the channels this capability PRODUCED
   * (`resolveCapabilityChannelIds` — the SAME derivation the inbound doors use).
   * Omit for a pod-wide outbound rollup over the recent scan prefix.
   */
  capabilityId?: string;
}

export interface ListEgressResult {
  channels: SignalEgressChannelRollup[];
  /** Outbound messages actually scanned to build the rollup. */
  scanned: number;
  /**
   * True when the scan hit `CHANNEL_SCAN_CAP` — the per-channel `sentCount`/
   * `lastSentAt` cover only the most recent `scanned` outbound messages, so the
   * caller must disclose "showing recent N" (same honesty contract as
   * `listChannels`). `failedCount` is a full count of the outbox failure backlog,
   * not windowed.
   */
  truncated: boolean;
}

interface OutboundScanRow {
  channelId: string;
  ts: Date;
}
interface EgressChannelMeta {
  name: string | null;
  provider: string | null;
}

/**
 * Group outbound messages by channel into a sent-count + last-sent rollup, fold
 * in each channel's failed-egress count (which may introduce a channel that has
 * NO outbound message — every send failed), and order it. Pure + DB-free so the
 * grouping/ordering is unit-testable without a database.
 *
 * `problems` (default) floats channels with failed egress first, then the highest
 * failure count, then most recently active; `recent` orders purely by last send.
 */
export function aggregateEgressRollups(args: {
  outbound: OutboundScanRow[];
  meta: Map<string, EgressChannelMeta>;
  failedByChannel: Map<string, number>;
  order: SignalEgressOrder;
}): SignalEgressChannelRollup[] {
  const { outbound, meta, failedByChannel, order } = args;
  const byChannel = new Map<string, SignalEgressChannelRollup>();

  const ensure = (channelId: string): SignalEgressChannelRollup => {
    let roll = byChannel.get(channelId);
    if (!roll) {
      const m = meta.get(channelId);
      roll = {
        channelId,
        name: m?.name ?? null,
        provider: m?.provider ?? null,
        sentCount: 0,
        failedCount: 0,
        lastSentAt: null,
      };
      byChannel.set(channelId, roll);
    }
    return roll;
  };

  for (const m of outbound) {
    const roll = ensure(m.channelId);
    roll.sentCount += 1;
    if (!roll.lastSentAt || m.ts.getTime() > roll.lastSentAt.getTime())
      roll.lastSentAt = m.ts;
  }
  for (const [channelId, failedCount] of failedByChannel) {
    if (failedCount > 0) ensure(channelId).failedCount = failedCount;
  }

  const rollups = [...byChannel.values()];
  const lastTs = (r: SignalEgressChannelRollup) =>
    r.lastSentAt ? r.lastSentAt.getTime() : -Infinity;
  if (order === "recent") {
    rollups.sort((a, b) => lastTs(b) - lastTs(a));
  } else {
    // problems (default): failing channels first, then the highest failure count,
    // then the most recently active.
    rollups.sort((a, b) => {
      const ap = a.failedCount > 0 ? 0 : 1;
      const bp = b.failedCount > 0 ? 0 : 1;
      if (ap !== bp) return ap - bp;
      if (a.failedCount !== b.failedCount) return b.failedCount - a.failedCount;
      return lastTs(b) - lastTs(a);
    });
  }
  return rollups;
}

/**
 * Per-channel OUTBOUND rollup — what a capability (or the pod) SENT toward its
 * external channels. See the section header for the two-ledger contract. Floored
 * by `channelVisibilityWhere` on every terminal read; capability-scoped by the
 * SAME `resolveCapabilityChannelIds` the inbound doors use.
 */
export async function listEgress(
  input: ListEgressInput
): Promise<ListEgressResult> {
  const { userId } = input;

  // Capability lens: resolve the capability's visible channels; an empty set
  // short-circuits to an empty rollup (capability sends nothing).
  let capChannelIds: string[] | null = null;
  if (input.capabilityId) {
    capChannelIds = await resolveCapabilityChannelIds(
      userId,
      input.capabilityId
    );
    if (capChannelIds.length === 0)
      return { channels: [], scanned: 0, truncated: false };
  }

  // 1. Outbound message scan — the symmetric mirror of the inbound EXTERNAL read:
  //    human + agent messages on visible EXTERNAL channels, newest-first, capped
  //    to the same CHANNEL_SCAN_CAP recent prefix `listChannels` uses.
  const scanRows: OutboundScanRow[] = await db
    .select({ channelId: messages.channelId, ts: messages.timestamp })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(
      and(
        inArray(messages.authorType, [...OUTBOUND_AUTHOR_TYPES]),
        isNull(messages.deletedAt),
        eq(messages.ephemeral, false),
        // Only channels bound to an external system are "outbound-to-platform".
        isNotNull(channels.externalSource),
        channelVisibilityWhere(userId),
        capChannelIds ? inArray(messages.channelId, capChannelIds) : undefined
      )
    )
    .orderBy(desc(messages.timestamp), desc(messages.id))
    .limit(CHANNEL_SCAN_CAP);

  const scanned = scanRows.length;
  const truncated = scanned === CHANNEL_SCAN_CAP;

  // 2. The channel set whose metadata + egress failures we resolve: the
  //    capability's channels (when scoped, so a channel whose every send FAILED
  //    still surfaces) ∪ the channels seen in the scan. Unscoped, the scan
  //    channels alone bound it — no unbounded channel census.
  const scanChannelIds = [...new Set(scanRows.map((r) => r.channelId))];
  const candidateIds = capChannelIds
    ? [...new Set([...capChannelIds, ...scanChannelIds])]
    : scanChannelIds;

  if (candidateIds.length === 0) return { channels: [], scanned, truncated };

  // 3. Channel metadata (name, provider, external identity), floored AGAIN — this
  //    is the terminal read yielding the external target the egress join uses.
  const metaRows = await db
    .select({
      id: channels.id,
      name: channels.title,
      provider: channels.externalSource,
      externalId: channels.externalId,
      externalChannelId: channels.externalChannelId,
    })
    .from(channels)
    .where(
      and(inArray(channels.id, candidateIds), channelVisibilityWhere(userId))
    );

  const meta = new Map<string, EgressChannelMeta>();
  // Egress target `${provider}::${externalId}` → channelId. The mirror enqueues
  // with `externalId ?? externalChannelId` (see mirror-to-external.ts), so match
  // the same fallback here.
  const targetToChannel = new Map<string, string>();
  const egressTargets: { source: string; externalId: string }[] = [];
  for (const c of metaRows) {
    meta.set(c.id, { name: c.name ?? null, provider: c.provider ?? null });
    const target = c.externalId ?? c.externalChannelId ?? null;
    if (c.provider && target) {
      targetToChannel.set(`${c.provider}::${target}`, c.id);
      egressTargets.push({ source: c.provider, externalId: target });
    }
  }

  // 4. Terminal-failed outbox rows per external target. An OR of scalar composite
  //    `=` predicates — NEVER a Postgres array literal (the documented driver
  //    gotcha the run fetch calls out). Grouped by target, mapped back to channel.
  //    Scoped to `kind = 'post_message'` so `failedCount` is the failure
  //    counterpart of `sentCount` (a failed MESSAGE send) — not a failed
  //    rename/pin/scheduled-event, which the outbox also carries. Only
  //    `status = 'failed'` counts: a `pending` row is in-flight, not a failure (a
  //    correct no-op must not read as a failure).
  const failedByChannel = new Map<string, number>();
  if (egressTargets.length > 0) {
    const failedRows = await db
      .select({
        source: channelEgress.externalSource,
        externalId: channelEgress.externalId,
        value: count(),
      })
      .from(channelEgress)
      .where(
        and(
          eq(channelEgress.status, "failed"),
          eq(channelEgress.kind, "post_message"),
          or(
            ...egressTargets.map((t) =>
              and(
                eq(channelEgress.externalSource, t.source),
                eq(channelEgress.externalId, t.externalId)
              )
            )
          )
        )
      )
      .groupBy(channelEgress.externalSource, channelEgress.externalId);
    for (const r of failedRows) {
      const channelId = targetToChannel.get(`${r.source}::${r.externalId}`);
      if (channelId)
        failedByChannel.set(
          channelId,
          (failedByChannel.get(channelId) ?? 0) + r.value
        );
    }
  }

  const channelsOut = aggregateEgressRollups({
    outbound: scanRows,
    meta,
    failedByChannel,
    order: input.order ?? "problems",
  });

  return { channels: channelsOut, scanned, truncated };
}

// ── Door 7: producer mode + per-mode health (the callable-vs-standing axis) ────
//
// An external-data capability runs in one of two MODES with DIFFERENT health
// semantics:
//
//   standing — an always-on listener/webhook/bridge (Discord gateway, Proton
//              bridge). Health = LIVENESS by last-seen age, NOT insight volume.
//              A standing source with no recent data may be DEAD or merely QUIET;
//              those are indistinguishable from the pod's ledgers alone, so the
//              absence of recent data is reported as `idle` (a caution, "quiet or
//              down"), NEVER as `failed`. Only a run/egress that actually broke
//              (`fate.failed` / failed egress) is a failure.
//   callable — an invocable verb (a poll/action run on demand). Health =
//              SUCCESS-RATE over recent runs. A suppressed (correct no-op) unit is
//              excluded from the denominator so an intentional filter never drags
//              the rate down.
//
// The mode marker is resolved from the stored capability definition
// (`capabilities.metadata.mode`, the SAME marker P6's transport planner shares),
// falling back to a derived signal (a member tool whose `config.transport` marks
// an always-on bridge ⇒ standing), and finally an HONEST `unknown` — never a
// guessed default. Both readings reuse `listChannels({ capabilityId })` (which
// carries the SAME `channelVisibilityWhere` + `resolveCapabilityChannelIds`
// floors), so the health is a synthesis over already-floored data — no new SQL
// floor, no frozen shape (`SignalSummary` / `SignalChannelRollup` /
// `SignalEgressChannelRollup`) touched.

export type CapabilityProducerMode = "standing" | "callable" | "unknown";
export type CapabilityModeSource = "declared" | "derived_transport" | "unknown";

/**
 * How recently a standing source must have produced inbound signal to read
 * `live`. Beyond this, it reads `idle` — quiet OR down, indistinguishable from
 * the ledgers alone (a true bridge health-ping does not yet exist in the pod
 * schema — see the door's report). 24h aligns with the summary window.
 */
const STANDING_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a capability's producer mode. `capabilities.metadata.mode` (declared)
 * wins; else a member tool with `config.transport = 'bridge'` derives `standing`;
 * else an honest `unknown`. Floored by `userVisibleWhere` — an unseeable
 * capability yields `unknown` (and its channels are empty under the channel
 * floor anyway).
 */
export async function resolveCapabilityMode(
  userId: string,
  capabilityId: string
): Promise<{ mode: CapabilityProducerMode; source: CapabilityModeSource }> {
  const [capRow] = await db
    .select({ metadata: capabilities.metadata })
    .from(capabilities)
    .where(
      and(
        eq(capabilities.id, capabilityId),
        userVisibleWhere(capabilities.workspaceId, userId)
      )
    )
    .limit(1);
  if (!capRow) return { mode: "unknown", source: "unknown" };

  const declared = (capRow.metadata as Record<string, unknown> | null)?.mode;
  if (declared === "standing" || declared === "callable")
    return { mode: declared, source: "declared" };

  // Derive: an always-on bridge member tool ⇒ standing. `config.transport` is the
  // one concrete transport marker the catalog carries today (proton /
  // telegram-bridge tools). NOT workspace-floored on its own — a tool id the
  // caller can't act on leaks nothing here (only a mode label), and the capability
  // row above was already visibility-floored.
  const partIds = (await getCapabilityMemberParts([capabilityId])).map(
    (p) => p.id
  );
  if (partIds.length > 0) {
    const toolRows = await db
      .select({ config: tools.config })
      .from(tools)
      .where(inArray(tools.id, partIds));
    const hasBridge = toolRows.some(
      (t) =>
        ((t.config ?? {}) as Record<string, unknown>).transport === "bridge"
    );
    if (hasBridge) return { mode: "standing", source: "derived_transport" };
  }

  // No signal — honest unknown, never a guessed green.
  return { mode: "unknown", source: "unknown" };
}

export interface CapabilityStandingHealth {
  /** Most recent inbound message across the capability's channels; null = none seen. */
  lastSeenAt: Date | null;
  /** Age of `lastSeenAt` in ms; null when nothing has been seen. */
  lastSeenAgeMs: number | null;
  /**
   * `live`   — inbound within the freshness window (proves the source is alive).
   * `idle`   — no inbound within the window: QUIET or DOWN, indistinguishable
   *            from the ledgers alone. Explicitly NOT `failed`.
   * `unknown`— no inbound message has ever been recorded for this capability.
   */
  liveness: "live" | "idle" | "unknown";
  /** The freshness window (ms) beyond which a standing source reads `idle`. */
  freshnessWindowMs: number;
  /** Channels carrying ≥1 `failed` unit — real breakage, distinct from mere quiet. */
  failedChannels: number;
}

export interface CapabilityCallableHealth {
  /** Inbound units classified over the capability's channels (recent prefix). */
  messageCount: number;
  extracted: number;
  failed: number;
  /** Correct no-ops (intentional filters) — excluded from the success denominator. */
  suppressed: number;
  /**
   * `extracted / (messageCount − suppressed) * 100`, rounded; 0 when the
   * denominator is 0. Suppressed units leave the denominator so an intentional
   * filter never depresses the success rate.
   */
  successRatePct: number;
}

export interface CapabilityHealthResult {
  capabilityId: string;
  mode: CapabilityProducerMode;
  modeSource: CapabilityModeSource;
  /** Present when `mode === 'standing'`. */
  standing: CapabilityStandingHealth | null;
  /** Present when `mode === 'callable'`. */
  callable: CapabilityCallableHealth | null;
  /**
   * Fate mix across the capability's channels (includes `suppressed`) — surfaced
   * for BOTH modes so a suppressed unit is always visible as a correct no-op, not
   * folded into a failure. Sums to `messageCount`.
   */
  fate: Record<SignalFate, number>;
  messageCount: number;
  channelCount: number;
  /**
   * True when the underlying channel scan hit `CHANNEL_SCAN_CAP` — the counts are
   * a recent-prefix census, not a whole-history total (same honesty contract as
   * `listChannels`); the caller must disclose it.
   */
  truncated: boolean;
}

/**
 * Pure synthesis of per-mode health from a capability's channel rollups — the
 * DB-free core of `getCapabilityHealth`, so the liveness threshold, the
 * suppressed-excluded success rate, and the fate summation are unit-testable
 * without a database. `now` is injected for deterministic liveness tests.
 */
export function synthesizeCapabilityHealth(args: {
  capabilityId: string;
  mode: CapabilityProducerMode;
  modeSource: CapabilityModeSource;
  rollups: SignalChannelRollup[];
  truncated: boolean;
  now?: number;
}): CapabilityHealthResult {
  const { capabilityId, mode, modeSource, rollups, truncated } = args;
  const now = args.now ?? Date.now();

  // Sum the fate mix + volume across the capability's channels.
  const fate: Record<SignalFate, number> = {
    extracted: 0,
    no_insight: 0,
    no_run: 0,
    unprocessed_unbound: 0,
    suppressed: 0,
    failed: 0,
  };
  let messageCount = 0;
  let failedChannels = 0;
  let lastSeenAt: Date | null = null;
  for (const r of rollups) {
    messageCount += r.messageCount;
    for (const k of Object.keys(fate) as SignalFate[]) fate[k] += r.fate[k];
    if (r.fate.failed > 0) failedChannels += 1;
    if (!lastSeenAt || r.lastActivityAt.getTime() > lastSeenAt.getTime())
      lastSeenAt = r.lastActivityAt;
  }

  const standing: CapabilityStandingHealth | null =
    mode === "standing"
      ? {
          lastSeenAt,
          lastSeenAgeMs: lastSeenAt ? now - lastSeenAt.getTime() : null,
          liveness: !lastSeenAt
            ? "unknown"
            : now - lastSeenAt.getTime() <= STANDING_FRESHNESS_WINDOW_MS
              ? "live"
              : "idle",
          freshnessWindowMs: STANDING_FRESHNESS_WINDOW_MS,
          failedChannels,
        }
      : null;

  const callable: CapabilityCallableHealth | null =
    mode === "callable"
      ? {
          messageCount,
          extracted: fate.extracted,
          failed: fate.failed,
          suppressed: fate.suppressed,
          // Suppressed units leave the denominator (intentional no-ops don't count
          // against success). 0 when nothing actionable ran.
          successRatePct:
            messageCount - fate.suppressed <= 0
              ? 0
              : Math.round(
                  (fate.extracted / (messageCount - fate.suppressed)) * 100
                ),
        }
      : null;

  return {
    capabilityId,
    mode,
    modeSource,
    standing,
    callable,
    fate,
    messageCount,
    channelCount: rollups.length,
    truncated,
  };
}

/**
 * Producer mode + per-mode health for one capability. Synthesizes over
 * `listChannels({ capabilityId })` (already floored + capability-scoped): last-
 * seen liveness for standing, run success-rate for callable, and the full fate
 * mix (with `suppressed`) for both. Never fabricates a mode — an undeclared,
 * non-bridge capability reads `unknown` with empty per-mode health.
 */
export async function getCapabilityHealth(
  userId: string,
  capabilityId: string
): Promise<CapabilityHealthResult> {
  // Visibility gate — symmetric with `getCapabilityIssues`. A capability the
  // caller can't see yields an empty `unknown` health, never health synthesized
  // over channels it happens to see pod-wide. `resolveCapabilityMode` already
  // floors the mode read, so this is defense-in-depth + it skips the channel
  // rollup work for an unseeable capability.
  const [capRow] = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(
      and(
        eq(capabilities.id, capabilityId),
        userVisibleWhere(capabilities.workspaceId, userId)
      )
    )
    .limit(1);
  if (!capRow)
    return synthesizeCapabilityHealth({
      capabilityId,
      mode: "unknown",
      modeSource: "unknown",
      rollups: [],
      truncated: false,
    });

  const [{ mode, source }, channelsResult] = await Promise.all([
    resolveCapabilityMode(userId, capabilityId),
    listChannels({ userId, capabilityId, order: "recent" }),
  ]);
  return synthesizeCapabilityHealth({
    capabilityId,
    mode,
    modeSource: source,
    rollups: channelsResult.channels,
    truncated: channelsResult.truncated,
  });
}

// ── Door 8: intended-vs-actual DRIFT, surfaced as Issues ──────────────────────
//
// A capability DECLARES an intended behavior; the lens OBSERVES the actual. The
// GAP is DRIFT — promoted here from a log line to an actionable ISSUE (a
// severity + a human sentence + a suggested Fix + a targetRef). This door owns
// NO new store and NO new signal: it COMPOSES the drift the P1–P7 lens already
// derives into ONE ranked list. The composition is pure + testable; the async
// door just gathers the already-floored inputs and hands them over.
//
// The two drift families it consolidates:
//   · STRUCTURAL — the composition's `gaps[]` (a declared-but-unwired member, a
//     dangling member link, an archived flow). These are ALREADY human-phrased,
//     so Issues consolidates them verbatim, adding only severity + a targetRef +
//     a Fix. It does NOT re-derive them (the task's "don't duplicate gaps[]").
//   · EXTERNAL-DATA RUNTIME — from the P2–P7 signals: a produced channel whose
//     extraction FAILED (real breakage), a produced channel receiving signal but
//     NOT bound (an activation gap), an outbound target with failed deliveries, a
//     declared standing source that is silent or idle, and an undeclared mode on
//     an OBSERVED capability (config hygiene).
//
// Severity is NOT boolean (Fivetran's error-vs-warning): `error` = data is
// failing/lost, `warning` = degraded/attention, `info` = advisory hygiene.
//
// HONESTY (the no-fabrication guard). An Issue must be TRUE and ACTIONABLE:
//   · an `unknown`-mode capability with NO observed signal is UNOBSERVED, not
//     broken — it yields ZERO issues (mode_undeclared fires only when data has
//     actually moved);
//   · a `suppressed` unit is a CORRECT no-op (an intentional filter) and never
//     becomes an Issue — the runtime scans key only on `fate.failed`, unbound,
//     and failed-egress, never on suppressed or on a merely-low success rate
//     (a low rate from `no_insight` is "ran, found nothing", not a failure);
//   · a quiet standing source reads `standing_idle`/`silent_producer`, NEVER
//     `failed` (quiet vs down is indistinguishable from the ledgers alone).
//
// NOT built (the FUTURE decision): a "dataflow manifest" — an explicit
// declared-produces / declared-sends SPEC to diff SHAPE and INTEGRITY drift
// against (wrong field types, dropped records). It does not exist in the schema
// today, and inventing a speculative manifest+engine is the trap this door
// avoids. P5 scopes to the drift DERIVABLE now (structural + behavior/liveness);
// shape/integrity drift waits on a real manifest.

export type CapabilityIssueSeverity = "error" | "warning" | "info";

export type CapabilityIssueKind =
  /** A member the capability references no longer resolves to a row (structural). */
  | "member_missing"
  /** A member present but not wired into the capability — orphaned verb, archived flow (structural). */
  | "member_unwired"
  /** Extraction errored/cancelled on a produced channel (runtime breakage). */
  | "run_failure"
  /** A produced channel is receiving inbound signal but is not bound to a record (activation gap). */
  | "channel_unbound"
  /** Outbound sends to a channel's external target are failing in the delivery outbox. */
  | "delivery_failure"
  /** A declared/derived always-on source has been quiet past the freshness window. */
  | "standing_idle"
  /** A standing source has produced NO channels — intended-to-listen, actually-silent. */
  | "silent_producer"
  /** The capability moves external data but hasn't declared its producer mode (hygiene). */
  | "mode_undeclared";

/**
 * A suggested Fix mapped to an EXISTING action — never a new remedy. The frontend
 * dispatches the action through the door that already owns it:
 *   · bind_channel     → the existing channel-bind proposal (BindChannelModal);
 *   · rerun_channel    → `signal.channelRerun` (governed re-run);
 *   · open_composition → the capability's composition facet (shows gaps + remedy);
 *   · open_egress      → the outbound egress rollup (`signal.egress`);
 *   · declare_mode     → edit `capabilities.metadata.mode`.
 */
export type CapabilityIssueFixAction =
  | { kind: "bind_channel"; channelId: string }
  | { kind: "rerun_channel"; channelId: string }
  | { kind: "open_composition" }
  | { kind: "open_egress" }
  | { kind: "declare_mode" };

export interface CapabilityIssueFix {
  label: string;
  action: CapabilityIssueFixAction;
}

export interface CapabilityIssue {
  kind: CapabilityIssueKind;
  severity: CapabilityIssueSeverity;
  /** A human sentence — what drifted, in plain language. */
  title: string;
  /** One line of supporting context. */
  detail: string;
  /** The existing action that resolves it, when one maps cleanly. */
  fix?: CapabilityIssueFix;
  /** The object the Issue is about (channel / capability / member), for deep-link. */
  targetRef?: { kind: string; id: string };
}

export interface CapabilityIssuesResult {
  capabilityId: string;
  /** Ranked worst-first (severity, then a stable kind order, then title). */
  issues: CapabilityIssue[];
  /** Per-severity tallies — the facet badge reads `error + warning`. */
  counts: { error: number; warning: number; info: number };
  /**
   * True when the underlying channel scan was truncated — the runtime counts are
   * a recent-prefix census, not a whole-history total. The caller must disclose it.
   */
  truncated: boolean;
}

/** Severity ordering for the worst-first sort. */
const ISSUE_SEVERITY_RANK: Record<CapabilityIssueSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** Stable secondary ordering within a severity, so equal-severity Issues don't jitter. */
const ISSUE_KIND_RANK: Record<CapabilityIssueKind, number> = {
  member_missing: 0,
  delivery_failure: 1,
  run_failure: 2,
  channel_unbound: 3,
  member_unwired: 4,
  standing_idle: 5,
  silent_producer: 6,
  mode_undeclared: 7,
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export interface ComposeCapabilityIssuesInput {
  capabilityId: string;
  /** The composition's human-phrased structural gaps — consolidated verbatim. */
  gaps: string[];
  /** The composition's members — used to attach a targetRef to a structural Issue. */
  members: CapabilityComposition["members"];
  /** Synthesized producer-mode health (mode + standing/callable + fate + counts). */
  health: CapabilityHealthResult;
  /** Per-channel INBOUND rollups (bound flag + fate) — activation + failure signals. */
  channels: SignalChannelRollup[];
  /** Per-channel OUTBOUND rollups (failedCount) — delivery-drift signal. */
  egress: SignalEgressChannelRollup[];
  truncated: boolean;
}

/**
 * PURE composition of a capability's drift Issues from the already-derived
 * signals. DB-free so every Issue kind, the severity ranking, and the
 * no-fabrication guard are unit-testable without a database.
 */
export function composeCapabilityIssues(
  input: ComposeCapabilityIssuesInput
): CapabilityIssuesResult {
  const { capabilityId, gaps, members, health, channels, egress, truncated } =
    input;
  const issues: CapabilityIssue[] = [];

  // ── Structural drift: consolidate the composition's human-phrased gaps[]. ──
  // A gap saying "not found" is a MISSING member (a dangling reference — data is
  // broken → error); any other gap ("unwired", "archived") is a member present
  // but not wired in (degraded → warning). The gap string IS the human title.
  for (const gap of gaps) {
    const missing = /not found/i.test(gap);
    const member = members.find((m) => m.name && gap.includes(m.name));
    issues.push({
      kind: missing ? "member_missing" : "member_unwired",
      severity: missing ? "error" : "warning",
      title: gap,
      detail: missing
        ? "A member this capability references no longer resolves to a row."
        : "A member is present but not wired into the capability (it lacks its own edges).",
      fix: { label: "Open composition", action: { kind: "open_composition" } },
      ...(member ? { targetRef: { kind: member.kind, id: member.id } } : {}),
    });
  }

  // ── Runtime breakage: extraction FAILED on a produced channel (data lost). ──
  // Keyed strictly on `fate.failed` — a suppressed (correct no-op) or no_insight
  // (ran, found nothing) unit never enters here, so an intentional filter or an
  // empty inbox never fabricates a failure.
  for (const c of channels) {
    if (c.fate.failed > 0) {
      issues.push({
        kind: "run_failure",
        severity: "error",
        title: `Extraction failed on "${c.name ?? c.channelId}" (${plural(
          c.fate.failed,
          "message"
        )})`,
        detail:
          "An extraction run errored or was cancelled before producing on this channel.",
        fix: {
          label: "Re-run channel",
          action: { kind: "rerun_channel", channelId: c.channelId },
        },
        targetRef: { kind: "channel", id: c.channelId },
      });
    }
  }

  // ── Activation gap: a produced channel receiving signal but NOT bound. ──
  // Intended (a source is wired to receive) vs actual (nothing routes what lands).
  for (const c of channels) {
    if (!c.bound && c.messageCount > 0) {
      issues.push({
        kind: "channel_unbound",
        severity: "warning",
        title: `"${
          c.name ?? c.channelId
        }" is receiving signal but isn't wired to a record`,
        detail: `${plural(
          c.messageCount,
          "inbound message"
        )} landed on a channel with no context entity — nothing routes them.`,
        fix: {
          label: "Bind channel",
          action: { kind: "bind_channel", channelId: c.channelId },
        },
        targetRef: { kind: "channel", id: c.channelId },
      });
    }
  }

  // ── Delivery drift: outbound sends that terminally failed in the outbox. ──
  for (const c of egress) {
    if (c.failedCount > 0) {
      issues.push({
        kind: "delivery_failure",
        severity: "error",
        title: `${plural(
          c.failedCount,
          "outbound message"
        )} failed to deliver on "${c.name ?? c.channelId}"`,
        detail:
          "Sends to this channel's external target are failing in the delivery outbox.",
        fix: { label: "Review deliveries", action: { kind: "open_egress" } },
        targetRef: { kind: "channel", id: c.channelId },
      });
    }
  }

  // ── Standing-mode liveness drift (a declared/derived always-on source). ──
  // NEVER `failed`: quiet vs down is indistinguishable from the ledgers alone.
  if (health.mode === "standing" && health.standing) {
    if (health.channelCount === 0) {
      // Intended-to-listen, actually-silent — the flagship external-data drift.
      // Confidence-weighted: an EXPLICIT declaration + silence warrants attention;
      // a merely-DERIVED mode + silence is advisory (it may just be new).
      issues.push({
        kind: "silent_producer",
        severity: health.modeSource === "declared" ? "warning" : "info",
        title: "This listener has produced no channels yet",
        detail:
          "The capability is configured as an always-on source, but no inbound data has flowed through it — verify its connection.",
        targetRef: { kind: "capability", id: capabilityId },
      });
    } else if (health.standing.liveness === "idle") {
      issues.push({
        kind: "standing_idle",
        severity: "warning",
        title: "No inbound signal in the last 24h",
        detail:
          "This always-on source has been quiet for over 24h — it may be idle or down (indistinguishable from the pod's ledgers alone).",
        targetRef: { kind: "capability", id: capabilityId },
      });
    }
  }

  // ── Config hygiene: OBSERVED but undeclared mode. ──
  // Only when data has ACTUALLY moved (channels produced or messages seen) — an
  // unobserved unknown-mode capability is not "broken", it's unobserved.
  if (
    health.mode === "unknown" &&
    (health.messageCount > 0 || health.channelCount > 0)
  ) {
    issues.push({
      kind: "mode_undeclared",
      severity: "info",
      title: "This capability's producer mode isn't declared",
      detail:
        "It is moving external data but hasn't declared whether it's an always-on listener or an on-demand action — declare metadata.mode so its health reads correctly.",
      fix: { label: "Declare mode", action: { kind: "declare_mode" } },
      targetRef: { kind: "capability", id: capabilityId },
    });
  }

  // Rank worst-first: severity, then the stable kind order, then title.
  issues.sort((a, b) => {
    const s = ISSUE_SEVERITY_RANK[a.severity] - ISSUE_SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    const k = ISSUE_KIND_RANK[a.kind] - ISSUE_KIND_RANK[b.kind];
    if (k !== 0) return k;
    return a.title.localeCompare(b.title);
  });

  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity] += 1;

  return { capabilityId, issues, counts, truncated };
}

/**
 * Intended-vs-actual drift for ONE capability, as a ranked Issues list. Gathers
 * the already-floored drift inputs — the composition's structural gaps, the
 * producer-mode health, and the inbound/outbound channel rollups — and hands
 * them to the pure `composeCapabilityIssues`. Visibility-gated: a capability the
 * caller can't see (or that doesn't exist) resolves to an empty, all-zero result
 * rather than leaking.
 */
export async function getCapabilityIssues(
  userId: string,
  capabilityId: string
): Promise<CapabilityIssuesResult> {
  const empty: CapabilityIssuesResult = {
    capabilityId,
    issues: [],
    counts: { error: 0, warning: 0, info: 0 },
    truncated: false,
  };

  // Visibility gate + load the container row the composition build needs.
  const [capRow] = await db
    .select({
      id: capabilities.id,
      name: capabilities.name,
      approved: capabilities.approved,
      metadata: capabilities.metadata,
    })
    .from(capabilities)
    .where(
      and(
        eq(capabilities.id, capabilityId),
        userVisibleWhere(capabilities.workspaceId, userId)
      )
    )
    .limit(1);
  if (!capRow) return empty;

  const [composition, modeRes, channelsRes, egressRes] = await Promise.all([
    buildCapabilityComposition({
      userId,
      capability: {
        id: capRow.id,
        name: capRow.name,
        approved: capRow.approved,
        metadata: capRow.metadata as Record<string, unknown> | null,
      },
    }),
    resolveCapabilityMode(userId, capabilityId),
    listChannels({ userId, capabilityId, order: "recent" }),
    listEgress({ userId, capabilityId, order: "problems" }),
  ]);

  const health = synthesizeCapabilityHealth({
    capabilityId,
    mode: modeRes.mode,
    modeSource: modeRes.source,
    rollups: channelsRes.channels,
    truncated: channelsRes.truncated,
  });

  return composeCapabilityIssues({
    capabilityId,
    gaps: composition.gaps,
    members: composition.members,
    health,
    channels: channelsRes.channels,
    egress: egressRes.channels,
    truncated: channelsRes.truncated || egressRes.truncated,
  });
}
