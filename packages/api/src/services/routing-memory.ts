/**
 * Routing memory — the read half of the capture-routing self-improvement loop.
 *
 * The observability spine records every routing decision (`ai_decision`) and
 * every user correction (`ai_correction`), linked by a shared `correlationId`
 * that is ALSO stamped onto the created entities. This module reads that spine
 * back into a small set of few-shot examples the router can learn from:
 *
 *   - `corrections` (NEGATIVE examples): the user moved the AI's pick to a
 *     different workspace. The strongest signal — a labeled `(text → wrong →
 *     right)` triple. Reconstructed from the `ai_correction` (kind=route)
 *     event's `entityId` (→ the mis-routed entity's text) + `fromWorkspaceId`
 *     / `toWorkspaceId`.
 *   - `confirmations` (POSITIVE examples): an auto-applied decision the user
 *     did NOT correct — a route the AI got right. Text comes from the entity
 *     stamped with the decision's `correlationId`.
 *
 * Threaded into `captureRouter.structure` as a hint, so EVERY interactive
 * capture door (MCP, REST, CLI, Raycast, tRPC) learns from it for free — a
 * correction today shapes routing tomorrow. Best-effort by contract: callers
 * must treat a throw/empty as "no memory" and never fail a capture over it.
 *
 * The event vocabulary + join key + window clamp + gate tunables come from the
 * `lib/ai-events` SSOT (a typo there would silently break the flywheel).
 */

import {
  db,
  events,
  entities,
  workspaces,
  eq,
  and,
  gte,
  desc,
  inArray,
  drizzleSql,
} from "@synap/database";
import {
  AI_DECISION,
  AI_CORRECTION,
  AI_KIND,
  AUTO_ROUTE_MIN_CONFIDENCE,
  ROUTE_TUNING_CEIL,
  MATURITY_DAYS,
  clampWindowDays,
  decisionCorrelationKeyExpr,
  eventKindExpr,
} from "../lib/ai-events.js";
import { lte } from "@synap/database";

export interface RoutingMemoryExample {
  /** A short snippet of the captured text (title/preview), for the prompt. */
  textSnippet: string;
  /** The workspace the item should live in (where the user put it / kept it). */
  correctWorkspaceName: string;
  /** Present for NEGATIVE examples only — where the AI wrongly filed it. */
  wrongWorkspaceName?: string;
}

export interface RoutingMemory {
  corrections: RoutingMemoryExample[];
  confirmations: RoutingMemoryExample[];
}

const DEFAULT_CORRECTION_LIMIT = 5;
const DEFAULT_CONFIRMATION_LIMIT = 3;
const SNIPPET_MAX = 120;
/** Over-fetch factor: rows drop out when their text/workspace can't resolve or
 *  a duplicate entity is deduped, so we fetch a multiple of the target. */
const OVERFETCH_FACTOR = 3;

/** Collapse whitespace + cap length so a snippet is cheap in the prompt. */
function toSnippet(text: string | null | undefined): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX - 1)}…` : t;
}

/**
 * Read recent routing corrections + confirmations for a user as few-shot
 * examples. Never throws for empty data — returns `{ corrections: [],
 * confirmations: [] }`. The caller (structure()) wraps this in try/catch so an
 * infra hiccup degrades to "no memory", never a failed capture.
 */
export async function fetchRoutingMemory(
  userId: string,
  opts?: {
    windowDays?: number;
    correctionLimit?: number;
    confirmationLimit?: number;
  }
): Promise<RoutingMemory> {
  const windowDays = clampWindowDays(opts?.windowDays);
  const correctionLimit = opts?.correctionLimit ?? DEFAULT_CORRECTION_LIMIT;
  const confirmationLimit =
    opts?.confirmationLimit ?? DEFAULT_CONFIRMATION_LIMIT;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // 1. Recent reroute corrections, newest first. Over-fetch: rows drop when
  //    text/workspace can't resolve OR an entity was moved MORE THAN ONCE (only
  //    its latest correction is kept — see the dedup in the build loop).
  const correctionRows = await db
    .select({
      entityId: drizzleSql<string | null>`${events.data}->>'entityId'`,
      fromWorkspaceId: drizzleSql<
        string | null
      >`${events.data}->>'fromWorkspaceId'`,
      toWorkspaceId: drizzleSql<
        string | null
      >`${events.data}->>'toWorkspaceId'`,
    })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.subjectType, AI_CORRECTION),
        drizzleSql`${eventKindExpr} = ${AI_KIND.ROUTE}`,
        gte(events.timestamp, since)
      )
    )
    .orderBy(desc(events.timestamp))
    .limit(correctionLimit * OVERFETCH_FACTOR);

  // 2. ALL corrected decision correlationIds in-window — so a positive example
  //    is only an UN-corrected route (a decision that survived). No kind filter:
  //    a delete/revert also disqualifies a positive.
  const correctedIdRows = await db
    .select({ cid: decisionCorrelationKeyExpr })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.subjectType, AI_CORRECTION),
        gte(events.timestamp, since)
      )
    );
  const correctedIds = new Set(
    correctedIdRows.map((r) => r.cid).filter((x): x is string => !!x)
  );

  // 3. Auto-applied decisions that MATURED without correction — positives
  //    candidates. The maturity gate is load-bearing: a fresh auto-route the
  //    user simply hasn't looked at yet is NOT a confirmation. Without it, an
  //    uncorrected MIS-route becomes a "confirmed" positive example and teaches
  //    the model the wrong thing (caught by dogfooding: a fashion signal
  //    mis-filed to CRM, uncorrected, started pulling later signals to CRM).
  //    Only a decision old enough to have been corrected but wasn't is trusted.
  const maturedBefore = new Date(
    Date.now() - MATURITY_DAYS * 24 * 60 * 60 * 1000
  );
  const decisionRows = await db
    .select({
      correlationId: events.correlationId,
      chosenWorkspaceId: drizzleSql<
        string | null
      >`${events.data}->>'chosenWorkspaceId'`,
    })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.subjectType, AI_DECISION),
        drizzleSql`${eventKindExpr} = ${AI_KIND.ROUTE}`,
        drizzleSql`${events.data}->>'applied' = 'true'`,
        gte(events.timestamp, since),
        lte(events.timestamp, maturedBefore)
      )
    )
    .orderBy(desc(events.timestamp))
    .limit(confirmationLimit * OVERFETCH_FACTOR);
  const confirmedDecisions = decisionRows
    .filter((d) => d.correlationId && !correctedIds.has(d.correlationId))
    .slice(0, confirmationLimit * OVERFETCH_FACTOR);

  // 4. Batch-resolve entity texts + workspace names.
  const entityIds = correctionRows
    .map((r) => r.entityId)
    .filter((x): x is string => !!x);
  const confirmCids = confirmedDecisions
    .map((d) => d.correlationId)
    .filter((x): x is string => !!x);

  const [correctionEntities, confirmEntities] = await Promise.all([
    entityIds.length
      ? db
          .select({
            id: entities.id,
            title: entities.title,
            preview: entities.preview,
          })
          .from(entities)
          .where(inArray(entities.id, entityIds))
      : Promise.resolve([]),
    confirmCids.length
      ? db
          .select({
            correlationId: entities.correlationId,
            title: entities.title,
            preview: entities.preview,
          })
          .from(entities)
          .where(inArray(entities.correlationId, confirmCids))
      : Promise.resolve([]),
  ]);
  const textByEntityId = new Map(
    correctionEntities.map((e) => [e.id, toSnippet(e.title ?? e.preview)])
  );
  const textByCid = new Map(
    confirmEntities
      .filter((e) => e.correlationId)
      .map((e) => [e.correlationId as string, toSnippet(e.title ?? e.preview)])
  );

  const wsIds = [
    ...new Set(
      [
        ...correctionRows.flatMap((r) => [r.fromWorkspaceId, r.toWorkspaceId]),
        ...confirmedDecisions.map((d) => d.chosenWorkspaceId),
      ].filter((x): x is string => !!x)
    ),
  ];
  const wsRows = wsIds.length
    ? await db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          workspaceType: workspaces.workspaceType,
        })
        .from(workspaces)
        .where(inArray(workspaces.id, wsIds))
    : [];
  const wsById = new Map(wsRows.map((w) => [w.id, w]));

  // Build examples — skip operational workspaces (never surface Pod Admin as a
  // routing target) and any unresolved text. DEDUP by entity: an item moved
  // more than once (A→B→C) emits multiple corrections sharing the decision's
  // correlationId; keeping all of them would assert contradictory labels ("B is
  // right" AND "B is wrong"). Rows are newest-first, so the FIRST row per entity
  // is the LATEST move — its `to` is the final home. Keep only that one.
  const corrections: RoutingMemoryExample[] = [];
  const seenEntities = new Set<string>();
  for (const r of correctionRows) {
    if (corrections.length >= correctionLimit) break;
    if (!r.entityId || !r.fromWorkspaceId || !r.toWorkspaceId) continue;
    if (seenEntities.has(r.entityId)) continue;
    seenEntities.add(r.entityId);
    const from = wsById.get(r.fromWorkspaceId);
    const to = wsById.get(r.toWorkspaceId);
    const text = textByEntityId.get(r.entityId);
    if (!from || !to || !text) continue;
    if (
      from.workspaceType === "operational" ||
      to.workspaceType === "operational"
    )
      continue;
    corrections.push({
      textSnippet: text,
      wrongWorkspaceName: from.name,
      correctWorkspaceName: to.name,
    });
  }

  const confirmations: RoutingMemoryExample[] = [];
  for (const d of confirmedDecisions) {
    if (confirmations.length >= confirmationLimit) break;
    if (!d.chosenWorkspaceId || !d.correlationId) continue;
    const ws = wsById.get(d.chosenWorkspaceId);
    const text = textByCid.get(d.correlationId);
    if (!ws || !text) continue;
    if (ws.workspaceType === "operational") continue;
    confirmations.push({ textSnippet: text, correctWorkspaceName: ws.name });
  }

  return { corrections, confirmations };
}

// Auto-tuned per-workspace gate. Below this many decisions to a workspace the
// correction rate is noise — don't tune (product review: byTargetWorkspace
// rates are meaningless at low n). Tuning only ever RAISES the gate (never
// below the flat floor): a workspace the user frequently corrects earns a
// higher bar; a trusted one keeps today's behavior.
const MIN_TUNING_VOLUME = 5;

/**
 * The auto-apply confidence gate for routing TO `workspaceId`, tuned from that
 * workspace's live correction rate. Returns `undefined` (→ caller uses the flat
 * default) when there isn't enough volume to tune. Reads a move (kind=route) OR
 * delete (kind=extract) of a decision that routed to this workspace as a miss.
 */
export async function fetchWorkspaceRoutingThreshold(
  userId: string,
  workspaceId: string,
  opts?: { windowDays?: number }
): Promise<number | undefined> {
  const windowDays = clampWindowDays(opts?.windowDays);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const decisions = await db
    .select({ correlationId: events.correlationId })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.subjectType, AI_DECISION),
        drizzleSql`${eventKindExpr} = ${AI_KIND.ROUTE}`,
        drizzleSql`${events.data}->>'chosenWorkspaceId' = ${workspaceId}`,
        gte(events.timestamp, since)
      )
    );
  if (decisions.length < MIN_TUNING_VOLUME) return undefined;

  const decisionIds = new Set(
    decisions.map((d) => d.correlationId).filter((x): x is string => !!x)
  );
  const corrections = await db
    .select({ cid: decisionCorrelationKeyExpr })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.subjectType, AI_CORRECTION),
        drizzleSql`${eventKindExpr} IN (${AI_KIND.ROUTE}, ${AI_KIND.EXTRACT})`,
        gte(events.timestamp, since)
      )
    );
  const correctedHere = new Set(
    corrections
      .map((c) => c.cid)
      .filter((x): x is string => !!x && decisionIds.has(x))
  );

  const rate = correctedHere.size / decisions.length;
  const threshold =
    AUTO_ROUTE_MIN_CONFIDENCE +
    rate * (ROUTE_TUNING_CEIL - AUTO_ROUTE_MIN_CONFIDENCE);
  return Math.min(
    ROUTE_TUNING_CEIL,
    Math.max(AUTO_ROUTE_MIN_CONFIDENCE, threshold)
  );
}
