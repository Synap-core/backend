/**
 * Pod Hygiene — Near-Duplicate Scan Worker (W0 PR3–4)
 *
 * Detects near-duplicate entities of the same kind within a single user+workspace
 * and files PENDING `merge` proposals. Never auto-merges; never calls mergeEntities.
 *
 * Detection methods:
 *   1. exact_title — normalized title (lower + trim) match, same type+user+workspace
 *   2. strong_signal — same normalized email in properties.email (strong-signal proxy)
 *      Note: entity_identity_signals enforces unique (type,value), so two live entities
 *      cannot own the same signal row — property-level email is the residual detector.
 *   3. embedding ANN — cosine similarity ≥ 0.92 (distance ≤ 0.08) over entity_vectors,
 *      same kind + user + workspace, bounded to the in-memory sample.
 *
 * Confidence (channel priority: email > embedding > exact_title):
 *   exact_title alone                 → 0.75  (method: exact_title)
 *   embedding ANN                     → 0.85  (method: embedding)
 *   email property / strong_signal    → 0.95  (method: strong_signal)
 *   exact_title + email               → 0.95  (method: strong_signal + signalsMatched)
 *
 * Caps / guardrails:
 *   - Max 10 merge proposals per user per UTC day
 *   - Soft-deleted entities excluded
 *   - Same kind only; no cross-workspace
 *   - Sample cap: 500 entities per kind per user
 *   - Dedup: no second PENDING proposal for the same unordered pair
 *   - Embedding ANN degrades gracefully if entity_vectors empty or query fails
 *   - Resilient per-user: one failure does not abort the batch
 *
 * Queue: pod-hygiene.near-dup-scan
 * Cron:  daily 15 3 * * *
 *
 * TODO(proactive digest): if any proposals created in a run, optionally post one
 * proactive_post summary ("N merge proposals ready") — skipped for W0 complexity.
 *
 * H0 identity patterns (sentinel titles, property-key aliases): pure detectors
 * live in `./hygiene-identity-patterns.ts`. Wire into this worker in a follow-up
 * to file retitle/merge proposals — do not auto-merge.
 */

import {
  db,
  entities,
  entityVectors,
  proposals,
  insertPendingProposal,
  pickMergeWinner,
  buildPropertyUnion,
  eq,
  and,
  isNull,
  inArray,
  gte,
  lt,
  desc,
  drizzleSql,
  ProposalStatus,
} from "@synap/database";
import { alias } from "drizzle-orm/pg-core";
import type {
  EntityMergeMethod,
  EntityMergeProposalData,
} from "@synap-core/types";
import { isEntityMergeProposalData } from "@synap-core/types";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";

const logger = createLogger({ module: "pod-hygiene-near-dup" });

export const POD_HYGIENE_NEAR_DUP_QUEUE = "pod-hygiene.near-dup-scan";

/** After pattern-detect at 03:00 — keep hygiene jobs clustered in the 03:xx window. */
export const POD_HYGIENE_NEAR_DUP_CRON = "15 3 * * *";

/** Prefer people/orgs first — residual kinds can expand later. */
// 'contact' is a role (facet), not a kind — person entities + contact facet are already deduped in the 'person' bucket; a facet is not a dedup axis.
const SCAN_KINDS = ["person", "company"] as const;

/** Cap entities loaded per kind per user to bound O(n²) pair work. */
const MAX_ENTITIES_PER_KIND = 500;

/**
 * Global per-user daily proposal budget (UTC day).
 *
 * DELIBERATELY NOT consolidated with `DEFAULT_DAILY_WRITE_CEILING`
 * (@synap/governance-policy, rung 2.56 governance_ceilings): despite both being
 * "10-ish per-UTC-day" caps, they are DIFFERENT concepts —
 *   • THIS caps how many MERGE PROPOSALS this scanner FILES for one HUMAN user
 *     per night (bounds inbox spam from the near-dup cron).
 *   • The ceiling caps how many WRITES one AGENT may AUTO-EXECUTE per day
 *     (governance backpressure, resolved in the shared agent-governance ladder).
 * Different population (proposals filed vs writes executed), principal (user vs
 * agent), and axis. Merging them would couple two unrelated policies.
 */
const MAX_PROPOSALS_PER_USER_PER_DAY = 10;

/**
 * Cooldown after a NEGATIVE decision on a pair. loadPendingPairKeys only skips
 * PENDING proposals, so a rejected/withdrawn "Merge A into B" freed the pair and
 * the very next nightly scan re-proposed the SAME merge — a self-repeating loop
 * that spammed the inbox with a decision the user already made. A pair whose
 * merge was rejected/withdrawn within this window is suppressed. Approved merges
 * soft-delete the loser (isNull(deletedAt) drops it from the sample), so they
 * need no cooldown.
 */
const RESOLVED_PAIR_COOLDOWN_DAYS = 30;

/** Cap pairs considered per user before ranking (extra safety). */
const MAX_PAIRS_CONSIDERED = 200;

/**
 * ANN cosine similarity floor. pgvector `<=>` returns cosine *distance*
 * (= 1 − similarity), so the SQL threshold is EMBEDDING_MAX_DISTANCE.
 */
export const EMBEDDING_MIN_SIMILARITY = 0.92;
export const EMBEDDING_MAX_DISTANCE = 0.08; // 1 - 0.92

const CONFIDENCE_EXACT_TITLE = 0.75;
export const CONFIDENCE_EMBEDDING = 0.85;
const CONFIDENCE_STRONG_SIGNAL = 0.95;
/** Handle/alias overlap (Oscar/0scr) — medium; proposal only. */
const CONFIDENCE_HANDLE_ALIAS = 0.8;

/** Db handle for the embedding ANN helper (injectable for tests). */
export type NearDupDb = typeof db;

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/** Internal detection channel before mapping onto EntityMergeMethod. */
export type NearDupDetectChannel =
  | "exact_title"
  | "email_property"
  | "embedding"
  /** Title of one entity matches discord-handle / aliases of the other (Oscar/0scr). */
  | "handle_alias";

export interface NearDupEntity {
  id: string;
  title: string | null;
  type: string;
  properties: Record<string, unknown> | null;
  workspaceId: string | null;
  userId: string;
  createdAt: Date;
}

export interface NearDupPair {
  a: NearDupEntity;
  b: NearDupEntity;
  /** Detection channels that fired for this pair. */
  channels: Set<NearDupDetectChannel>;
  /** Matched signal labels for review UI (e.g. "email:a@b.com"). */
  signalsMatched: string[];
}

/** Normalize display title for exact-match grouping. */
export function normalizeTitle(
  title: string | null | undefined
): string | null {
  if (title == null) return null;
  const n = title.trim().toLowerCase();
  return n.length > 0 ? n : null;
}

/** Normalize email for property-level matching (mirrors identity signal email). */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!v.includes("@") || v.length < 3) return null;
  return v;
}

/** Canonical unordered pair key for dedup sets. */
export function pairKey(id1: string, id2: string): string {
  return id1 < id2 ? `${id1}:${id2}` : `${id2}:${id1}`;
}

/**
 * Same-workspace equality for W0 (no cross-workspace merge).
 * null workspace (pod-global) only pairs with null.
 */
export function sameWorkspace(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Map detection channels → official EntityMergeMethod + confidence.
 * Priority: email_property > embedding > handle_alias > exact_title.
 */
export function resolveMethodAndConfidence(pair: NearDupPair): {
  method: EntityMergeMethod;
  confidence: number;
} {
  if (pair.channels.has("email_property")) {
    return {
      method: "strong_signal",
      confidence: CONFIDENCE_STRONG_SIGNAL,
    };
  }
  if (pair.channels.has("embedding")) {
    return {
      method: "embedding",
      confidence: CONFIDENCE_EMBEDDING,
    };
  }
  if (pair.channels.has("handle_alias")) {
    // Not a strong signal in identity policy — surface as exact_title family
    // for UI method chips if embedding isn't set; confidence is the differentiator.
    return {
      method: "exact_title",
      confidence: CONFIDENCE_HANDLE_ALIAS,
    };
  }
  return {
    method: "exact_title",
    confidence: CONFIDENCE_EXACT_TITLE,
  };
}

/** Normalize handle/alias tokens for Oscar-style nickname matching. */
export function normalizeHandleToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.trim().toLowerCase().replace(/^@+/, "");
  return n.length >= 2 ? n : null;
}

/** Collect title + discord-handle + aliases[] as a normalized token set. */
export function collectHandleTokens(e: NearDupEntity): Set<string> {
  const tokens = new Set<string>();
  const t = normalizeTitle(e.title);
  if (t) tokens.add(t);
  const props = e.properties ?? {};
  const dh =
    normalizeHandleToken(props["discord-handle"]) ??
    normalizeHandleToken(props.discordHandle);
  if (dh) tokens.add(dh);
  const aliases = props.aliases;
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      const tok = normalizeHandleToken(a);
      if (tok) tokens.add(tok);
    }
  }
  return tokens;
}

/**
 * Merge pair lists by unordered key, unioning channels + signalsMatched.
 * Re-ranks by confidence and applies MAX_PAIRS_CONSIDERED.
 */
export function mergeNearDupPairLists(
  ...lists: NearDupPair[][]
): NearDupPair[] {
  const best = new Map<string, NearDupPair>();

  for (const list of lists) {
    for (const p of list) {
      if (p.a.id === p.b.id) continue;
      if (!sameWorkspace(p.a.workspaceId, p.b.workspaceId)) continue;
      if (p.a.type !== p.b.type) continue;

      const key = pairKey(p.a.id, p.b.id);
      let pair = best.get(key);
      if (!pair) {
        pair = {
          a: p.a,
          b: p.b,
          channels: new Set(p.channels),
          signalsMatched: [...p.signalsMatched],
        };
        best.set(key, pair);
        continue;
      }
      for (const c of p.channels) pair.channels.add(c);
      for (const s of p.signalsMatched) {
        if (!pair.signalsMatched.includes(s)) pair.signalsMatched.push(s);
      }
    }
  }

  const pairs = Array.from(best.values());
  pairs.sort((p, q) => {
    const pc = resolveMethodAndConfidence(p).confidence;
    const qc = resolveMethodAndConfidence(q).confidence;
    return qc - pc;
  });
  return pairs.slice(0, MAX_PAIRS_CONSIDERED);
}

/**
 * Find candidate near-dup pairs from an in-memory entity sample (same kind).
 * Pure — title + email channels only. Embedding ANN is async (see
 * findEmbeddingNearDupPairs) and merged via mergeNearDupPairLists.
 */
export function findNearDupPairs(sample: NearDupEntity[]): NearDupPair[] {
  const best = new Map<string, NearDupPair>();

  const touch = (
    a: NearDupEntity,
    b: NearDupEntity,
    channel: NearDupDetectChannel,
    signalLabel?: string
  ) => {
    if (a.id === b.id) return;
    if (!sameWorkspace(a.workspaceId, b.workspaceId)) return;
    if (a.type !== b.type) return;

    const key = pairKey(a.id, b.id);
    let pair = best.get(key);
    if (!pair) {
      pair = {
        a,
        b,
        channels: new Set(),
        signalsMatched: [],
      };
      best.set(key, pair);
    }
    pair.channels.add(channel);
    if (signalLabel && !pair.signalsMatched.includes(signalLabel)) {
      pair.signalsMatched.push(signalLabel);
    }
  };

  // Method 1: exact title groups (scoped by workspace)
  const byTitle = new Map<string, NearDupEntity[]>();
  for (const e of sample) {
    const t = normalizeTitle(e.title);
    if (!t) continue;
    const bucket = `${e.workspaceId ?? "∅"}::${t}`;
    let list = byTitle.get(bucket);
    if (!list) {
      list = [];
      byTitle.set(bucket, list);
    }
    list.push(e);
  }
  for (const group of byTitle.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        touch(group[i]!, group[j]!, "exact_title");
      }
    }
  }

  // Method 2: shared email property (strong-signal proxy)
  const byEmail = new Map<string, NearDupEntity[]>();
  for (const e of sample) {
    const email = normalizeEmail(e.properties?.email);
    if (!email) continue;
    const bucket = `${e.workspaceId ?? "∅"}::${email}`;
    let list = byEmail.get(bucket);
    if (!list) {
      list = [];
      byEmail.set(bucket, list);
    }
    list.push(e);
  }
  for (const [bucket, group] of byEmail.entries()) {
    const email = bucket.split("::")[1] ?? "";
    const signalLabel = `email:${email}`;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        touch(group[i]!, group[j]!, "email_property", signalLabel);
      }
    }
  }

  // Method 3: handle/alias overlap (title of A equals handle/alias of B).
  // Catches 0scr ↔ Oscar when the handle is stored on properties.discord-handle
  // or aliases[]. Same workspace only. Never auto-merge — proposal only.
  for (let i = 0; i < sample.length; i++) {
    // `a` and its handle tokens are invariant across the whole inner loop —
    // hoist them so collectHandleTokens(a) runs once per i, not once per (i,j).
    const a = sample[i]!;
    const aTok = collectHandleTokens(a);
    for (let j = i + 1; j < sample.length; j++) {
      const b = sample[j]!;
      if (!sameWorkspace(a.workspaceId, b.workspaceId)) continue;
      const bTok = collectHandleTokens(b);
      const overlap: string[] = [];
      for (const t of aTok) {
        if (bTok.has(t)) overlap.push(t);
      }
      // Require at least one shared token AND not already same exact title only
      // (exact_title already covers pure title-title). Prefer when one side has
      // a non-title handle token (discord/aliases).
      if (overlap.length === 0) continue;
      const aTitle = normalizeTitle(a.title);
      const bTitle = normalizeTitle(b.title);
      const pureTitleDup =
        aTitle &&
        bTitle &&
        aTitle === bTitle &&
        overlap.length === 1 &&
        overlap[0] === aTitle;
      if (pureTitleDup) continue; // already covered by exact_title
      const label = `handle:${overlap.join(",")}`;
      touch(a, b, "handle_alias", label);
    }
  }

  const pairs = Array.from(best.values());
  pairs.sort((p, q) => {
    const pc = resolveMethodAndConfidence(p).confidence;
    const qc = resolveMethodAndConfidence(q).confidence;
    return qc - pc;
  });
  return pairs.slice(0, MAX_PAIRS_CONSIDERED);
}

/**
 * Find near-dup pairs via embedding ANN (cosine distance ≤ EMBEDDING_MAX_DISTANCE).
 *
 * Only considers entities that appear in `sample` and have rows in entity_vectors.
 * Same user + entityType enforced in SQL; same workspace filtered via sample map.
 * Degrades to [] on empty sample, empty vectors, or query failure.
 */
export async function findEmbeddingNearDupPairs(
  database: NearDupDb,
  userId: string,
  kind: string,
  sample: NearDupEntity[]
): Promise<NearDupPair[]> {
  if (sample.length < 2) return [];

  const byId = new Map(sample.map((e) => [e.id, e]));
  const sampleIds = sample.map((e) => e.id);

  try {
    // Self-join bounded to the sample set — unordered pairs only (a.entity_id < b).
    const vecA = alias(entityVectors, "near_dup_ev_a");
    const vecB = alias(entityVectors, "near_dup_ev_b");

    const rows = await database
      .select({
        aId: vecA.entityId,
        bId: vecB.entityId,
      })
      .from(vecA)
      .innerJoin(
        vecB,
        and(
          eq(vecA.userId, vecB.userId),
          eq(vecA.entityType, vecB.entityType),
          lt(vecA.entityId, vecB.entityId)
        )
      )
      .where(
        and(
          eq(vecA.userId, userId),
          eq(vecA.entityType, kind),
          inArray(vecA.entityId, sampleIds),
          inArray(vecB.entityId, sampleIds),
          drizzleSql`${vecA.embedding} <=> ${vecB.embedding} <= ${EMBEDDING_MAX_DISTANCE}`
        )
      )
      .limit(MAX_PAIRS_CONSIDERED);

    const pairs: NearDupPair[] = [];
    for (const row of rows) {
      const a = byId.get(row.aId);
      const b = byId.get(row.bId);
      if (!a || !b) continue;
      if (!sameWorkspace(a.workspaceId, b.workspaceId)) continue;
      if (a.type !== b.type) continue;
      pairs.push({
        a,
        b,
        channels: new Set<NearDupDetectChannel>(["embedding"]),
        signalsMatched: [],
      });
    }
    return pairs;
  } catch (err) {
    logger.warn(
      { err, userId, kind },
      "pod-hygiene.near-dup: embedding ANN query failed (non-fatal)"
    );
    return [];
  }
}

/**
 * Build official EntityMergeProposalData for insertPendingProposal.
 * Uses pickMergeWinner + buildPropertyUnion from EntityMergeService (SSOT).
 */
export function buildMergeProposalData(
  pair: NearDupPair
): EntityMergeProposalData {
  const propsA = pair.a.properties ?? {};
  const propsB = pair.b.properties ?? {};
  const { winnerId, loserId } = pickMergeWinner(
    {
      id: pair.a.id,
      createdAt: pair.a.createdAt,
      properties: propsA,
      title: pair.a.title,
    },
    {
      id: pair.b.id,
      createdAt: pair.b.createdAt,
      properties: propsB,
      title: pair.b.title,
    }
  );

  const winner = winnerId === pair.a.id ? pair.a : pair.b;
  const loser = loserId === pair.a.id ? pair.a : pair.b;
  const winnerProps = winner.properties ?? {};
  const loserProps = loser.properties ?? {};
  const { filled, conflicts } = buildPropertyUnion(winnerProps, loserProps);
  const { method, confidence } = resolveMethodAndConfidence(pair);

  const wTitle = winner.title?.trim() || winner.id.slice(0, 8);
  const lTitle = loser.title?.trim() || loser.id.slice(0, 8);
  const methodLabel =
    method === "strong_signal"
      ? pair.channels.has("exact_title")
        ? "identical titles and matching email"
        : "matching email"
      : method === "embedding"
        ? pair.channels.has("exact_title")
          ? "similar embeddings (and matching titles)"
          : "similar embeddings"
        : "identical titles";

  const data: EntityMergeProposalData = {
    winnerId,
    loserId,
    confidence,
    method,
    // Entity title is `string | null`; proposal type uses optional string.
    winnerTitle: winner.title ?? undefined,
    loserTitle: loser.title ?? undefined,
    // Owner of the data — canReviewProposal treats sourceId === approver as owner.
    sourceId: winner.userId,
    summary: `Merge “${lTitle}” into “${wTitle}” (${pair.a.type})`,
    reasoning: `Pod hygiene near-dup scan found ${methodLabel} on two ${pair.a.type} entities in the same workspace (confidence ${confidence.toFixed(2)}). No data is merged until you approve — the loser would be soft-deleted after property/relation/facet union.`,
    propertyPlan: {
      filled,
      conflicts,
    },
    previousWinnerSnapshot: {
      title: winner.title,
      profileSlug: winner.type,
      properties: winnerProps,
    },
    previousLoserSnapshot: {
      title: loser.title,
      profileSlug: loser.type,
      properties: loserProps,
    },
  };

  if (pair.signalsMatched.length > 0) {
    data.signalsMatched = pair.signalsMatched;
  }

  return data;
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function listUserIdsWithScanKinds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: entities.userId })
    .from(entities)
    .where(
      and(inArray(entities.type, [...SCAN_KINDS]), isNull(entities.deletedAt))
    );
  return rows.map((r) => r.userId).filter((u): u is string => !!u);
}

async function loadEntitySample(
  userId: string,
  kind: string
): Promise<NearDupEntity[]> {
  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      type: entities.type,
      properties: entities.properties,
      workspaceId: entities.workspaceId,
      userId: entities.userId,
      createdAt: entities.createdAt,
    })
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.type, kind),
        isNull(entities.deletedAt)
      )
    )
    .orderBy(desc(entities.updatedAt))
    .limit(MAX_ENTITIES_PER_KIND);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    properties: (r.properties ?? {}) as Record<string, unknown>,
    workspaceId: r.workspaceId,
    userId: r.userId,
    createdAt: r.createdAt,
  }));
}

function startOfUtcDay(d = new Date()): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)
  );
}

/**
 * Count entity-merge proposals created for this user today (UTC).
 * Uses createdBy = userId (hygiene stamps the entity owner as author).
 * Ignores other merge proposal types (e.g. channel branch merges) via the
 * isEntityMergeProposalData guard.
 */
async function countTodayMergeProposals(userId: string): Promise<number> {
  const since = startOfUtcDay();
  const rows = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.createdBy, userId),
        eq(proposals.proposalType, "merge"),
        gte(proposals.createdAt, since)
      )
    );
  return rows.filter((r) => isEntityMergeProposalData(r.data)).length;
}

/**
 * Pending entity-merge pairs already filed for this user (any age) — avoid re-proposing.
 */
async function loadPendingPairKeys(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.createdBy, userId),
        eq(proposals.proposalType, "merge"),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );

  const keys = new Set<string>();
  for (const row of rows) {
    if (!isEntityMergeProposalData(row.data)) continue;
    keys.add(pairKey(row.data.winnerId, row.data.loserId));
  }
  return keys;
}

/**
 * Pairs whose merge was REJECTED or WITHDRAWN within the cooldown window — the
 * user (or proposer) already said "no", so re-proposing them is noise. This is
 * the missing half of the dedup: pending-only skipping let the next scan re-file
 * a just-rejected merge. Ordering is unordered pairKey, same as the pending set.
 */
async function loadRecentlyResolvedPairKeys(
  userId: string
): Promise<Set<string>> {
  const cutoff = new Date(
    Date.now() - RESOLVED_PAIR_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  );
  const rows = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.createdBy, userId),
        eq(proposals.proposalType, "merge"),
        inArray(proposals.status, [
          ProposalStatus.REJECTED,
          ProposalStatus.WITHDRAWN,
        ]),
        // updatedAt is bumped on the status transition — the decision time.
        gte(proposals.updatedAt, cutoff)
      )
    );

  const keys = new Set<string>();
  for (const row of rows) {
    if (!isEntityMergeProposalData(row.data)) continue;
    keys.add(pairKey(row.data.winnerId, row.data.loserId));
  }
  return keys;
}

async function scanUser(userId: string): Promise<number> {
  const alreadyToday = await countTodayMergeProposals(userId);
  if (alreadyToday >= MAX_PROPOSALS_PER_USER_PER_DAY) {
    logger.debug(
      { userId, alreadyToday },
      "pod-hygiene.near-dup: daily cap already reached, skip user"
    );
    return 0;
  }

  let remaining = MAX_PROPOSALS_PER_USER_PER_DAY - alreadyToday;
  // Skip set = still-open proposals (any age) ∪ recently rejected/withdrawn.
  // The second half stops the self-repeating loop: without it a rejected merge
  // was re-proposed on the next run because the pending peek no longer saw it.
  const pendingKeys = await loadPendingPairKeys(userId);
  const resolvedKeys = await loadRecentlyResolvedPairKeys(userId);
  const suppressedKeys = new Set<string>([...pendingKeys, ...resolvedKeys]);

  // Collect pairs across kinds, then rank globally so high-confidence signal
  // matches beat weak title/embedding matches when the daily budget is tight.
  const allPairs: NearDupPair[] = [];
  for (const kind of SCAN_KINDS) {
    const sample = await loadEntitySample(userId, kind);
    if (sample.length < 2) continue;
    const titleEmailPairs = findNearDupPairs(sample);
    // Additive ANN channel — degrades to [] on empty vectors / query failure.
    const embeddingPairs = await findEmbeddingNearDupPairs(
      db,
      userId,
      kind,
      sample
    );
    allPairs.push(...mergeNearDupPairLists(titleEmailPairs, embeddingPairs));
  }

  allPairs.sort((p, q) => {
    const pc = resolveMethodAndConfidence(p).confidence;
    const qc = resolveMethodAndConfidence(q).confidence;
    return qc - pc;
  });

  let created = 0;
  const seenThisRun = new Set<string>();

  for (const pair of allPairs) {
    if (remaining <= 0) break;

    const data = buildMergeProposalData(pair);
    // Self-merge guard: winner === loser is a no-op "Merge X into X" that would
    // never resolve. Pairs are distinct entities by construction, but a data
    // glitch (same id sampled twice, an alias collision) must never file one.
    if (data.winnerId === data.loserId) {
      logger.warn(
        { userId, entityId: data.winnerId },
        "pod-hygiene.near-dup: skipping self-merge (winner === loser)"
      );
      continue;
    }
    const key = pairKey(data.winnerId, data.loserId);
    if (suppressedKeys.has(key) || seenThisRun.has(key)) continue;
    seenThisRun.add(key);

    // Workspace of the winner (entities are same-ws by construction).
    const winnerEntity = data.winnerId === pair.a.id ? pair.a : pair.b;
    const workspaceId = winnerEntity.workspaceId;

    const { proposal } = await insertPendingProposal({
      workspaceId,
      targetType: "entity",
      targetId: data.winnerId,
      proposalType: "merge",
      data: data as unknown as Record<string, unknown>,
      // Entity owner is the human who should review; system is the producer.
      createdBy: userId,
      proposedByUserId: null,
    });

    // Mirror createPendingProposal's proposal.created side-effects so inbox /
    // reactors see the row. Jobs cannot import @synap/api; emitSideEffects is
    // the W0 path (broadcastNotification lives in jobs but is optional for W0).
    // Fire-and-forget — never fail the scan on notification errors.
    void emitSideEffects({
      subjectType: "proposal",
      action: "created",
      subjectId: proposal.id,
      userId,
      workspaceId: workspaceId ?? undefined,
      data: {
        proposalStatus: "created",
        targetType: "entity",
        changeType: "merge",
      },
    }).catch((err) => {
      logger.warn(
        { err, proposalId: proposal.id, userId },
        "pod-hygiene.near-dup: emitSideEffects failed (non-fatal)"
      );
    });

    pendingKeys.add(key);
    remaining -= 1;
    created += 1;
  }

  if (created > 0) {
    logger.info(
      { userId, created, remainingBudget: remaining },
      "pod-hygiene.near-dup: filed merge proposals"
    );
  }

  return created;
}

// ── Handler ──────────────────────────────────────────────────────────────────

/**
 * Cron / on-demand handler.
 * Manual trigger: `await boss.send("pod-hygiene.near-dup-scan", {})`
 *
 * Detection: exact title + email property + embedding ANN (cosine ≥ 0.92),
 * all proposal-only — never auto-merge.
 *
 * TODO(proactive digest): one proactive_post when created > 0 — skip for now.
 */
export async function handlePodHygieneNearDupScan(): Promise<void> {
  logger.info("pod-hygiene.near-dup: starting scan");

  const userIds = await listUserIdsWithScanKinds();
  let totalCreated = 0;
  let usersFailed = 0;

  for (const userId of userIds) {
    try {
      totalCreated += await scanUser(userId);
    } catch (err) {
      usersFailed += 1;
      logger.error(
        { err, userId },
        "pod-hygiene.near-dup: failed for user, skipping"
      );
    }
  }

  logger.info(
    { users: userIds.length, totalCreated, usersFailed },
    "pod-hygiene.near-dup: scan complete"
  );
}
