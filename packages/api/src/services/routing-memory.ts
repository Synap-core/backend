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

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_CORRECTION_LIMIT = 5;
const DEFAULT_CONFIRMATION_LIMIT = 3;
const SNIPPET_MAX = 120;

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
  const windowDays = Math.min(
    365,
    Math.max(1, opts?.windowDays ?? DEFAULT_WINDOW_DAYS)
  );
  const correctionLimit = opts?.correctionLimit ?? DEFAULT_CORRECTION_LIMIT;
  const confirmationLimit =
    opts?.confirmationLimit ?? DEFAULT_CONFIRMATION_LIMIT;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // 1. Recent reroute corrections — over-fetch (×3): some won't resolve a text
  //    or a non-operational workspace pair and get dropped when building.
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
        eq(events.subjectType, "ai_correction"),
        drizzleSql`${events.data}->>'kind' = 'route'`,
        gte(events.timestamp, since)
      )
    )
    .orderBy(desc(events.timestamp))
    .limit(correctionLimit * 3);

  // 2. ALL corrected decision correlationIds in-window — so a positive example
  //    is only an UN-corrected route (a decision that survived).
  const correctedIdRows = await db
    .select({
      cid: drizzleSql<string | null>`${events.data}->>'correlationId'`,
    })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.subjectType, "ai_correction"),
        gte(events.timestamp, since)
      )
    );
  const correctedIds = new Set(
    correctedIdRows.map((r) => r.cid).filter((x): x is string => !!x)
  );

  // 3. Recent auto-applied decisions — positives candidates (filter out
  //    corrected + over-fetch for the same drop-on-resolve reason).
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
        eq(events.subjectType, "ai_decision"),
        drizzleSql`${events.data}->>'kind' = 'route'`,
        drizzleSql`${events.data}->>'applied' = 'true'`,
        gte(events.timestamp, since)
      )
    )
    .orderBy(desc(events.timestamp))
    .limit(confirmationLimit * 5);
  const confirmedDecisions = decisionRows
    .filter((d) => d.correlationId && !correctedIds.has(d.correlationId))
    .slice(0, confirmationLimit * 3);

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
  // routing target, mirroring the capture hint filter) and any unresolved text.
  const corrections: RoutingMemoryExample[] = [];
  for (const r of correctionRows) {
    if (corrections.length >= correctionLimit) break;
    if (!r.entityId || !r.fromWorkspaceId || !r.toWorkspaceId) continue;
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
