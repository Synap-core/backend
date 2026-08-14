/**
 * Pending-aware dedup for the capture/import graph door (Wave 1, loop-closure).
 *
 * `resolveIdentity` only ever sees COMMITTED entities (`entity_identity_signals`).
 * A governed capture that files a PENDING proposal has materialized NOTHING yet —
 * so between "agent A files a 12-entity capture proposal" and "the human
 * approves it", a second agent (or a retry of the same call) resolves the same
 * person, reads MISSING, and files a DUPLICATE. This module closes that hole from
 * two angles, both ADVISORY / owner-floored:
 *
 *   1. `computeCaptureGraphIdempotencyKey` + `findPriorCaptureGraphProposal` —
 *      a content-hash idempotency key so a re-submit of the SAME graph returns
 *      the PRIOR proposal instead of filing a second row.
 *   2. `findPendingSignalMatches` — a strong-signal scan over the caller's OWN
 *      pending create-graph proposals, surfaced as an advisory candidate (NEVER
 *      an `existingEntityId`: a pending proposal can be rejected, and linking to
 *      it would stale-suppress a real write).
 *
 * Wave 3 adds the RECALL sibling — `findPendingTextMatches` — a natural-language
 * text scan of the same owner-floored pending queue, so `ask` can surface work
 * that is captured-but-not-yet-real instead of reporting it missing.
 *
 * OWNER FLOOR (mandatory, all scans): `createdBy = userId`. A workspace floor
 * would leak a teammate's unreviewed queue (mirrors `listCreatedProposals` and
 * the orient-count lesson). STATUS='pending' STRICT for the advisory scans: an
 * APPROVED proposal's entity now exists for real and `resolveIdentity`/recall
 * already see it — including it would double-count.
 *
 * v1 scope: CREATE-GRAPH proposal types only (`import.graph` / `capture.graph`),
 * whose `data.operations[]` carry create_entity ops with a property bag the
 * EXISTING `extractIdentitySignals` can read. Other proposal types would need
 * per-type extractors — out of scope.
 */

import { createHash } from "crypto";

import {
  type db,
  and,
  eq,
  inArray,
  desc,
  drizzleSql,
  proposals,
  ProposalStatus,
  extractIdentitySignals,
  normalizeIdentitySignal,
  type IdentitySignal,
} from "@synap/database";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  COMMON_STOPWORDS,
  QUESTION_WORDS,
} from "../services/retrieval/stopwords.js";
import { openLink } from "./deep-links.js";

/** The create-graph proposal types whose operations[] we can scan in v1. */
const CAPTURE_GRAPH_PROPOSAL_TYPES = ["import.graph", "capture.graph"] as const;

/** A create_entity op inside a pending proposal that collided on a strong signal. */
export interface PendingSignalMatch {
  proposalId: string;
  proposalType: string;
  summary?: string;
  /** The pending op's stable ref, if it had one. */
  entityRef?: string;
  /** The pending op's title (what the reviewer sees). */
  entityTitle?: string;
  profileSlug?: string;
  /** The normalized strong signal(s) that matched (email/phone/url/handle/…). */
  matchedSignals: Array<{ type: string; value: string }>;
}

/** Normalize `signals` to a `type:value` string set for O(1) intersection. */
function normalizedSignalKeys(signals: IdentitySignal[]): Set<string> {
  const keys = new Set<string>();
  for (const s of signals) {
    if (!s || !s.type || typeof s.value !== "string" || !s.value.trim())
      continue;
    keys.add(`${s.type}:${normalizeIdentitySignal(s.type, s.value)}`);
  }
  return keys;
}

/**
 * Advisory strong-signal scan over the caller's OWN pending create-graph
 * proposals. Returns EVERY pending create_entity op whose extracted strong
 * signal matches one of `signals`. ADVISORY ONLY — the caller must never link
 * to a returned proposal (it can still be rejected); it flags the in-flight
 * duplicate so a second copy isn't filed.
 */
export async function findPendingSignalMatches(
  database: typeof db,
  params: { userId: string; signals: IdentitySignal[]; limit?: number }
): Promise<PendingSignalMatch[]> {
  const wanted = normalizedSignalKeys(params.signals);
  if (wanted.size === 0) return [];

  const rows = await database
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      data: proposals.data,
    })
    .from(proposals)
    .where(
      and(
        // OWNER FLOOR — never another user's queue.
        eq(proposals.createdBy, params.userId),
        // STRICT pending — an approved proposal's entity is already committed.
        eq(proposals.status, ProposalStatus.PENDING),
        inArray(
          proposals.proposalType,
          CAPTURE_GRAPH_PROPOSAL_TYPES as unknown as string[]
        )
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(params.limit ?? 50);

  const matches: PendingSignalMatch[] = [];
  for (const row of rows) {
    const data = row.data as {
      operations?: CompositeProposalOperation[];
      summary?: string;
    };
    const ops = Array.isArray(data?.operations) ? data.operations : [];
    for (const op of ops) {
      if (op.op !== "create_entity") continue;
      // A pending op that already LINKS an existing entity isn't a new candidate.
      if (op.existingEntityId) continue;
      const opSignals = extractIdentitySignals(
        op.properties as Record<string, unknown> | undefined
      ).map((s) => ({
        type: s.type,
        value: normalizeIdentitySignal(s.type, s.value),
      }));
      const hit = opSignals.filter((s) => wanted.has(`${s.type}:${s.value}`));
      if (hit.length > 0) {
        matches.push({
          proposalId: row.id,
          proposalType: row.proposalType,
          ...(typeof data.summary === "string"
            ? { summary: data.summary }
            : {}),
          ...(op.ref ? { entityRef: op.ref } : {}),
          ...(op.title ? { entityTitle: op.title } : {}),
          profileSlug: op.profileSlug,
          matchedSignals: hit,
        });
      }
    }
  }
  return matches;
}

// ── RECALL half (Wave 3): text-match the caller's OWN pending queue ──────────
//
// `findPendingSignalMatches` above closes the CAPTURE hole (a second WRITE
// resolving a person who only exists in a pending proposal). This half closes
// the RECALL hole: `ask` is natural language, so strong-signal matching does
// not apply — a pending "Talentir" capture must surface for the query
// "Talentir" even though it carries no email/phone/url the query mentions. So
// we text-match the query's content terms against each pending create_entity
// op's title/description/profileSlug + the proposal summary, mirroring how the
// retrieval engine reduces a query to content keywords (shared stopword sets,
// same tokenizer idiom) — NOT embeddings: pending ops aren't indexed, and a
// substring term-overlap is enough to say "you already captured this."
//
// SAME floors as the signal scan, and they are load-bearing here: OWNER
// (`createdBy = userId`) — a workspace floor would leak a teammate's queue;
// STATUS='pending' STRICT — an approved proposal's entity is in the graph
// already and normal recall finds it, so including it would double-count.

/** A pending capture op whose text matched a recall query. NOT a fact — pending. */
export interface PendingTextMatch {
  proposalId: string;
  proposalType: string;
  /** The proposal's human summary (what the reviewer sees), when present. */
  summary?: string;
  /** The best-matching create_entity op's title (the representative entity). */
  entityTitle?: string;
  profileSlug?: string;
  /** Clickable review link — approve/reject to make it real. `${PUBLIC_URL}/open/<id>`. */
  reviewUrl: string;
  /** Distinct query terms matched — the rank score (higher = closer). */
  score: number;
}

/**
 * Enumerative / imperative framing + function words + interrogatives — the same
 * filler the retrieval engine strips from a query before matching (`CLEANED_
 * QUERY_FILLER` in understand-query.ts). Kept in lockstep with the shared
 * stopword sets so recall and this pending scan can't drift on what counts as a
 * content term.
 */
const QUERY_TERM_FILLER = new Set<string>([
  ...COMMON_STOPWORDS,
  ...QUESTION_WORDS,
  "show",
  "list",
  "find",
  "get",
  "give",
  "see",
  "display",
  "all",
  "me",
  "my",
  "our",
  "your",
  "their",
  "any",
  "some",
  "every",
]);

/**
 * Reduce a natural-language query to its content terms — the retrieval engine's
 * tokenizer idiom (lowercase → split on non-alphanumerics), filler stripped and
 * single-char noise dropped (a stray "a"/"x" would substring-match everything).
 * Pure + deterministic; exported for unit cover.
 */
export function extractQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !QUERY_TERM_FILLER.has(t));
}

/**
 * Score one pending op's text against the query terms: the count of DISTINCT
 * terms that appear (substring) in the op's title/description/profileSlug plus
 * the proposal summary. Pure; exported for unit cover. Mirrors the structured
 * substrate's lowercased term-overlap — deliberately NOT embeddings (pending
 * ops aren't indexed, and over-engineering recall over a bounded review queue
 * buys nothing).
 */
export function scorePendingText(
  terms: string[],
  fields: {
    title?: string;
    description?: string;
    profileSlug?: string;
    summary?: string;
  }
): number {
  if (terms.length === 0) return 0;
  const haystack = [
    fields.title,
    fields.description,
    fields.profileSlug,
    fields.summary,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();
  if (!haystack) return 0;
  let score = 0;
  for (const t of terms) if (haystack.includes(t)) score += 1;
  return score;
}

/**
 * Owner-floored text scan over the caller's OWN pending create-graph proposals
 * for a recall query. Returns the matching proposals ranked by term-overlap,
 * ONE representative entry per proposal (its best-matching create_entity op).
 * The result is ADVISORY and must be surfaced as a SEPARATE, LABELED block —
 * never merged into a factual answer: a pending proposal isn't in the graph and
 * can still be rejected.
 */
export async function findPendingTextMatches(
  database: typeof db,
  params: {
    userId: string;
    query?: string;
    /** Pre-tokenized terms (re-tokenized/filtered defensively). */
    queryTerms?: string[];
    limit?: number;
  }
): Promise<PendingTextMatch[]> {
  const raw =
    params.queryTerms && params.queryTerms.length
      ? params.queryTerms.flatMap((t) => extractQueryTerms(t))
      : params.query
        ? extractQueryTerms(params.query)
        : [];
  const terms = [...new Set(raw)];
  if (terms.length === 0) return [];

  const rows = await database
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      data: proposals.data,
      createdAt: proposals.createdAt,
    })
    .from(proposals)
    .where(
      and(
        // OWNER FLOOR — never another user's review queue.
        eq(proposals.createdBy, params.userId),
        // STRICT pending — an approved op's entity is already in the graph.
        eq(proposals.status, ProposalStatus.PENDING),
        inArray(
          proposals.proposalType,
          CAPTURE_GRAPH_PROPOSAL_TYPES as unknown as string[]
        )
      )
    )
    // Newest first: a fixed scan window over the owner-floored pending queue,
    // then rank the window by relevance and cap the returned block below.
    .orderBy(desc(proposals.createdAt))
    .limit(50);

  const matches: PendingTextMatch[] = [];
  for (const row of rows) {
    const data = row.data as {
      operations?: CompositeProposalOperation[];
      summary?: string;
    };
    const summary =
      typeof data?.summary === "string" ? data.summary : undefined;
    const ops = Array.isArray(data?.operations) ? data.operations : [];

    // Best-matching create_entity op is the proposal's representative. Skip ops
    // that only LINK an existing entity (existingEntityId): that entity is
    // already in the graph, so normal recall surfaces it — it isn't pending.
    let best: { score: number; title?: string; profileSlug?: string } | null =
      null;
    for (const op of ops) {
      if (op.op !== "create_entity") continue;
      if (op.existingEntityId) continue;
      const score = scorePendingText(terms, {
        ...(op.title ? { title: op.title } : {}),
        ...(op.description ? { description: op.description } : {}),
        profileSlug: op.profileSlug,
        summary,
      });
      if (!best || score > best.score) {
        best = {
          score,
          ...(op.title ? { title: op.title } : {}),
          profileSlug: op.profileSlug,
        };
      }
    }
    // A relation-only proposal (no create_entity op) still scores on its summary.
    const score = best ? best.score : scorePendingText(terms, { summary });
    if (score > 0) {
      matches.push({
        proposalId: row.id,
        proposalType: row.proposalType,
        ...(summary ? { summary } : {}),
        ...(best?.title ? { entityTitle: best.title } : {}),
        ...(best?.profileSlug ? { profileSlug: best.profileSlug } : {}),
        reviewUrl: openLink(row.id),
        score,
      });
    }
  }

  // Rank by relevance; stable sort keeps the newest-first order among ties.
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, params.limit ?? 5);
}

/**
 * Content-hash idempotency key for a capture/import graph. Deterministic over
 * the STABLE content of the graph — profileSlug + title + description + content +
 * canonically-sorted properties of every entity, plus the relation triples and
 * the scope (workspace/project). Two genuinely-different captures can't collide:
 * every content-bearing field is folded in, so any difference changes the hash.
 * A byte-identical re-submit reproduces the SAME key → resolves to the prior
 * proposal. Entities are content-sorted so producer order never changes the key.
 *
 * This key is NEVER derived from a random id (a retry would mint a new one →
 * not idempotent) — that's the whole point.
 */
export function computeCaptureGraphIdempotencyKey(input: {
  workspaceId: string | null;
  projectId: string | null;
  entities: Array<{
    ref?: string;
    profileSlug: string;
    title?: string;
    description?: string;
    content?: string;
    properties?: Record<string, unknown>;
  }>;
  relations?: Array<{ sourceRef: string; targetRef: string; type: string }>;
  bindings?: unknown[];
}): string {
  // Per-entity canonical CONTENT key — deliberately excludes `ref`, an
  // LLM-assigned positional label (t1/t2, e1/e2 by array index) that shifts when
  // the same graph is re-emitted in a different order.
  const entityContentKey = (e: (typeof input.entities)[number]) =>
    JSON.stringify({
      profileSlug: e.profileSlug,
      title: e.title ?? "",
      description: e.description ?? "",
      content: e.content ?? "",
      // Sort property keys so key order never changes the hash.
      properties: canonicalize(e.properties ?? {}),
    });

  const canonicalEntities = input.entities.map(entityContentKey).sort();

  // Resolve each relation endpoint to its entity's CONTENT identity, NOT its raw
  // ref, so a re-emitted graph whose entities landed in a different order (and so
  // got different ref labels) still produces the same relation component — the
  // fix for the semantic-same/textual-different graph-lane duplicates. An
  // endpoint whose ref isn't a graph entity (e.g. a pre-existing entity referenced
  // by id) falls back to the raw ref.
  const contentKeyByRef = new Map<string, string>();
  for (const e of input.entities) {
    if (e.ref) contentKeyByRef.set(e.ref, entityContentKey(e));
  }
  const endpoint = (ref: string) => contentKeyByRef.get(ref) ?? ref;

  const canonicalRelations = (input.relations ?? [])
    .map((r) => `${endpoint(r.sourceRef)} ${endpoint(r.targetRef)} ${r.type}`)
    .sort();

  const payload = JSON.stringify({
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    entities: canonicalEntities,
    relations: canonicalRelations,
    // Bindings don't carry stable identity content; their COUNT is enough to
    // distinguish "same graph, extra channel bind" from an exact re-submit.
    bindingCount: (input.bindings ?? []).length,
  });

  return createHash("sha256").update(payload).digest("hex");
}

/**
 * IMPORT-lane adapter over the ONE hashing rule above. The import lane carries
 * a flat `CompositeProposalOperation[]` where the capture lane carries
 * `{entities, relations}` — the shapes are a pure re-projection of each other
 * (a `create_entity` op IS a graph entity; a `create_relation` op IS a relation
 * triple), so this ADAPTS the input instead of introducing a second content-hash
 * rule. Two runs that mean the same graph produce the same key in BOTH lanes.
 *
 * Deliberately NOT folded in: `sourceId` (a fresh `randomUUID()` at two of the
 * three import writers — folding it would mint a new key per run and be
 * non-idempotent by construction) and `source` (the same graph re-imported
 * through a different adapter is still the same graph — matching capture, which
 * also ignores its `source`).
 *
 * DEGENERATE GUARD: returns `null` when the operations carry no create_entity
 * op. An empty/relation-only graph would otherwise hash to a CONSTANT that every
 * unrelated empty import collides on. A `null` key means "not stampable" — the
 * caller omits `data.idempotencyKey` entirely and files normally, exactly as
 * today.
 */
export function computeImportGraphIdempotencyKey(input: {
  workspaceId: string | null;
  projectId?: string | null;
  operations: ReadonlyArray<CompositeProposalOperation>;
}): string | null {
  const entities: Array<{
    ref?: string;
    profileSlug: string;
    title?: string;
    description?: string;
    content?: string;
    properties?: Record<string, unknown>;
  }> = [];
  const relations: Array<{
    sourceRef: string;
    targetRef: string;
    type: string;
  }> = [];

  for (const op of input.operations) {
    if (op.op === "create_entity") {
      entities.push({
        ref: op.ref,
        profileSlug: op.profileSlug,
        title: op.title,
        description: op.description,
        content: op.content,
        properties: op.properties,
      });
    } else if (op.op === "create_relation") {
      relations.push({
        sourceRef: op.sourceRef,
        targetRef: op.targetRef,
        type: op.type,
      });
    }
  }

  if (entities.length === 0) return null;

  return computeCaptureGraphIdempotencyKey({
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    entities,
    relations,
  });
}

/** Recursively sort object keys so JSON.stringify is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = canonicalize(obj[k]);
    return out;
  }
  return value;
}

/**
 * Idempotency lookup: the caller's OWN prior capture/import graph proposal for a
 * given content-hash key, whether still PENDING or already AUTO_APPROVED (the
 * agent-mode materialized terminal). Owner-floored on `createdBy`; the key is
 * stored under `data.idempotencyKey`. Returns the newest match, or null.
 */
export async function findPriorCaptureGraphProposal(
  database: typeof db,
  params: { userId: string; idempotencyKey: string }
): Promise<typeof proposals.$inferSelect | null> {
  const rows = await database
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.createdBy, params.userId),
        inArray(proposals.status, [
          ProposalStatus.PENDING,
          ProposalStatus.AUTO_APPROVED,
        ]),
        inArray(
          proposals.proposalType,
          CAPTURE_GRAPH_PROPOSAL_TYPES as unknown as string[]
        ),
        drizzleSql`${proposals.data} ->> 'idempotencyKey' = ${params.idempotencyKey}`
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
