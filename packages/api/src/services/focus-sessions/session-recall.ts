/**
 * Session recall — a just-started session is shown the raw captures and notes
 * the person already has that could help it (founder precision 2026-10-08:
 * "I capture 2 music tracks saying 'they could match well together'; later I
 * start a DJ session, an underlying AI checks whether it can find things to
 * help me, retrieves them and shows them to me").
 *
 * Raw captures STAY raw: nothing here files, links or edits an entity. Recall
 * is read-only on the graph and writes exactly two things, both on the session:
 *   - `metadata.recalled = [{ entityId, title, kind, score, reason, recalledAt }]`
 *     (jsonb, no migration) — what `synap_get_session` returns to the agent;
 *   - ONE message in the session's room naming them — what the person reads,
 *     and what the session's agent reads in its history.
 *
 * ── STATES, never folded into one another ──────────────────────────────────
 *   not run   no `metadata.recalledAt`
 *   ok        `recalled` non-empty, `recalledAt`, `recallError` absent
 *   empty     `recalled: []`, `recalledAt` — posts NOTHING (an empty recall is
 *             silent in the room; the marker only stops the sweep re-asking)
 *   failed    `recallError: { message, at }`, `recalledAt`, `recallAttempts`;
 *             a previous `recalled` list is KEPT (a failed re-run must not
 *             erase what an earlier run found). Never thrown to the caller:
 *             a failed recall never fails a session start.
 *
 * ── HOW ────────────────────────────────────────────────────────────────────
 * 1. Query = the session's title + goal, its playbook's name, its subject
 *    (title + kind noun) — `buildRecallQuery`.
 * 2. Candidates through the EXISTING recall door, `retrieve()` (semantic +
 *    lexical + graph, owner/visibility floored — the same engine behind
 *    `synap_ask` / knowledge search). Pod-wide on purpose: raw captures are
 *    rarely filed into the session's workspace or project, so a lensed recall
 *    would starve exactly the case this exists for; the session's workspace is
 *    a small PREFERENCE instead (`WORKSPACE_BONUS`).
 * 3. Relevance floor. `retrieve()` returns an ORDER, not a score, and its graph
 *    leg can pull in neighbours with no evidence of their own. So each
 *    candidate is scored on its own evidence: cosine similarity of its stored
 *    embedding to the query (`entity_vectors`), or — when it has no vector or
 *    the embedding provider is down — the share of query words it carries.
 *    Below `RECALL_MIN_SCORE` it is dropped; the top `RECALL_MAX` survive.
 * 4. Excluded: the subject itself, and anything already linked to the session
 *    (`session --targets|produced|…--> entity`): recall is for what the session
 *    does NOT already have. Notes get a small preference (`NOTE_BONUS`).
 *
 * IDEMPOTENT per session: `recalled` is REPLACED, and the room message carries
 * an idempotency key derived from the recalled id set, so a re-run that finds
 * the same things posts nothing new.
 *
 * Calibration of `RECALL_MIN_SCORE` is a guess until dogfooded on a real pod.
 */

import { createHash } from "crypto";
import {
  db,
  and,
  eq,
  inArray,
  drizzleSql,
  entities,
  entityVectors,
  focusSessions,
  links,
  playbooks,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { tokenize } from "../routing/suggest-routes.js";

const logger = createLogger({ module: "focus-sessions/session-recall" });

/** At most this many items are recalled for one session. */
export const RECALL_MAX = 5;
/** Below this, a candidate is not evidence of anything — dropped. */
export const RECALL_MIN_SCORE = 0.35;
/** Retrieval pool: wide enough that the floor, not the pool, decides. */
const RECALL_POOL = 20;
const WORKSPACE_BONUS = 0.03;
const NOTE_BONUS = 0.05;
const NOTE_KINDS: ReadonlySet<string> = new Set(["note", "idea"]);
const QUERY_MAX = 600;

export interface RecalledItem {
  entityId: string;
  title: string;
  kind: string;
  /** 0..1, two decimals — the candidate's own evidence (see header §3). */
  score: number;
  /** One human line: why this was recalled. */
  reason: string;
  recalledAt: string;
}

export type SessionRecallOutcome =
  | { status: "ok"; recalled: RecalledItem[]; posted: boolean }
  | { status: "empty" }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: "not_found" | "closed" };

// ── Pure parts ───────────────────────────────────────────────────────────────

export function buildRecallQuery(input: {
  title?: string | null;
  goal?: string | null;
  playbookName?: string | null;
  subject?: { title?: string | null; kind?: string | null } | null;
}): string {
  const parts: string[] = [];
  const add = (s: string | null | undefined) => {
    const t = s?.replace(/\s+/g, " ").trim();
    if (t && !parts.some((p) => p.toLowerCase() === t.toLowerCase()))
      parts.push(t);
  };
  add(input.title);
  add(input.goal);
  add(input.playbookName);
  if (input.subject?.title) {
    add(
      input.subject.kind
        ? `${input.subject.title} (${resolveObjectNoun(input.subject.kind).toLowerCase()})`
        : input.subject.title
    );
  }
  return parts.join(". ").slice(0, QUERY_MAX);
}

export interface RecallCandidate {
  id: string;
  title: string | null;
  type: string;
  workspaceId: string | null;
  /** Searchable text of the candidate (title + preview). */
  text: string;
  /** Cosine similarity of its stored embedding to the query; null = no vector. */
  semantic: number | null;
}

/** Share of the query's words the candidate carries, plus which ones. */
function lexicalEvidence(
  query: Map<string, string>,
  text: string
): { score: number; words: string[] } {
  if (query.size === 0) return { score: 0, words: [] };
  const own = tokenize(text);
  const words = [...query.entries()]
    .filter(([s]) => own.has(s))
    .map(([, w]) => w);
  return { score: words.length / query.size, words };
}

export function selectRecalled(input: {
  query: string;
  candidates: readonly RecallCandidate[];
  excludeIds: ReadonlySet<string>;
  sessionWorkspaceId: string | null;
  now: Date;
  max?: number;
  minScore?: number;
}): RecalledItem[] {
  const max = input.max ?? RECALL_MAX;
  const floor = input.minScore ?? RECALL_MIN_SCORE;
  const queryWords = tokenize(input.query);
  const recalledAt = input.now.toISOString();
  const seen = new Set<string>();
  const scored: Array<RecalledItem & { rank: number }> = [];
  input.candidates.forEach((c, rank) => {
    if (input.excludeIds.has(c.id) || seen.has(c.id)) return;
    seen.add(c.id);
    const lexical = lexicalEvidence(queryWords, c.text);
    const semantic = c.semantic ?? 0;
    const evidence = Math.max(semantic, lexical.score);
    // The floor judges EVIDENCE only; preferences break near-ties, they can
    // never lift an unrelated item over the floor.
    if (evidence < floor) return;
    const bonus =
      (NOTE_KINDS.has(c.type) ? NOTE_BONUS : 0) +
      (input.sessionWorkspaceId && c.workspaceId === input.sessionWorkspaceId
        ? WORKSPACE_BONUS
        : 0);
    const reason =
      semantic >= lexical.score
        ? "Close in meaning to this session"
        : `Mentions ${lexical.words
            .slice(0, 3)
            .map((w) => `“${w}”`)
            .join(", ")}`;
    scored.push({
      entityId: c.id,
      title: c.title?.trim() || resolveObjectNoun(c.type),
      kind: c.type,
      score: Math.round(Math.min(1, evidence + bonus) * 100) / 100,
      reason,
      recalledAt,
      rank,
    });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .slice(0, max)
    .map(({ rank: _rank, ...item }) => item);
}

/** The ONE room line. Sentence copy, not vocabulary — nouns via the resolver. */
export function formatRecallMessage(items: readonly RecalledItem[]): string {
  const lines = items.map(
    (i) =>
      `- ${i.title} (${resolveObjectNoun(i.kind).toLowerCase()}) — ${i.reason.charAt(0).toLowerCase()}${i.reason.slice(1)}`
  );
  return [
    items.length === 1
      ? "Found 1 thing you captured earlier that may help this session:"
      : `Found ${items.length} things you captured earlier that may help this session:`,
    ...lines,
  ].join("\n");
}

/** Idempotency key of the room message: same session + same set ⇒ same key. */
export function recallMessageKey(
  sessionId: string,
  items: readonly RecalledItem[]
): string {
  const ids = items.map((i) => i.entityId).sort();
  const digest = createHash("sha256")
    .update(ids.join(","))
    .digest("hex")
    .slice(0, 16);
  return `session-recall:${sessionId}:${digest}`;
}

/**
 * What an agent reads about recall on a session (MCP `synap_get_session` /
 * `synap_start_session`). DERIVED from the metadata the runner writes — one
 * reader of the four states, so "failed" can never read as "nothing found".
 */
export type SessionRecallView =
  | { status: "pending" }
  | { status: "ok"; recalled: RecalledItem[]; recalledAt: string }
  | { status: "empty"; recalledAt: string }
  | {
      status: "failed";
      error: string;
      recalledAt: string;
      /** What an EARLIER run found, kept across the failure. */
      recalled: RecalledItem[];
    };

export function projectSessionRecall(metadata: unknown): SessionRecallView {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const at = typeof m.recalledAt === "string" ? m.recalledAt : null;
  if (!at) return { status: "pending" };
  const recalled = Array.isArray(m.recalled)
    ? (m.recalled as RecalledItem[])
    : [];
  const err = m.recallError as { message?: unknown } | undefined;
  if (err && typeof err === "object") {
    return {
      status: "failed",
      error: typeof err.message === "string" ? err.message : "unknown",
      recalledAt: at,
      recalled,
    };
  }
  return recalled.length > 0
    ? { status: "ok", recalled, recalledAt: at }
    : { status: "empty", recalledAt: at };
}

// ── Effects (injectable) ─────────────────────────────────────────────────────

export interface RecallDeps {
  /** Ordered candidate rows from the existing recall door. */
  retrieve: (args: {
    query: string;
    userId: string;
    limit: number;
  }) => Promise<Array<Omit<RecallCandidate, "semantic">>>;
  /** Cosine similarity per entity id; an absent id has no vector. */
  similarity: (
    query: string,
    entityIds: readonly string[]
  ) => Promise<Map<string, number>>;
  post: (args: {
    channelId: string;
    userId: string;
    content: string;
    idempotencyKey: string;
  }) => Promise<unknown>;
  now?: () => Date;
}

async function defaultRetrieve(args: {
  query: string;
  userId: string;
  limit: number;
}): Promise<Array<Omit<RecallCandidate, "semantic">>> {
  const { resolveKnowledgeLens } = await import("../knowledge/resolve-lens.js");
  const { retrieve } = await import("../retrieval/retrieve.js");
  // Pod-wide (header §2): the catalog is the pod-wide profile union.
  const { catalog } = await resolveKnowledgeLens(args.userId, undefined);
  const result = await retrieve({
    query: args.query,
    userId: args.userId,
    workspaceId: null,
    limit: args.limit,
    catalog,
  });
  return result.entities.map((e) => ({
    id: String(e.id),
    title: (e.title as string | null) ?? null,
    type: String(e.type ?? ""),
    workspaceId: (e.workspaceId as string | null) ?? null,
    text: [e.title, e.preview, e.content]
      .filter((t): t is string => typeof t === "string")
      .join(" ")
      .slice(0, 4000),
  }));
}

async function defaultSimilarity(
  query: string,
  entityIds: readonly string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (entityIds.length === 0) return out;
  const { embedQuery } = await import("../retrieval/hybrid-recall.js");
  const { embedding } = await embedQuery(query);
  // Provider down / empty: no semantic evidence; lexical evidence still counts.
  if (!embedding) return out;
  const vec = `[${embedding.join(",")}]`;
  const rows = await db
    .select({
      entityId: entityVectors.entityId,
      sim: drizzleSql<number>`1 - (${entityVectors.embedding} <=> ${vec}::vector)`,
    })
    .from(entityVectors)
    .where(inArray(entityVectors.entityId, [...entityIds]));
  for (const r of rows) {
    const sim = Number(r.sim);
    if (Number.isFinite(sim) && sim > (out.get(r.entityId) ?? -1))
      out.set(r.entityId, sim);
  }
  return out;
}

async function defaultPost(args: {
  channelId: string;
  userId: string;
  content: string;
  idempotencyKey: string;
}): Promise<unknown> {
  const { postChannelMessage } = await import("../messaging/post-message.js");
  return postChannelMessage({
    channelId: args.channelId,
    userId: args.userId,
    content: args.content,
    // The pod speaking in the room, like the hydration summary — visible to
    // the person and in the agent's history. Never turns the AI on.
    role: "assistant",
    triggerAI: false,
    idempotencyKey: args.idempotencyKey,
  });
}

const DEFAULT_DEPS: RecallDeps = {
  retrieve: defaultRetrieve,
  similarity: defaultSimilarity,
  post: defaultPost,
};

/** Shallow jsonb merge onto the session's metadata — never a read-modify-write. */
async function patchMetadata(
  sessionId: string,
  patch: Record<string, unknown>,
  removeKeys: readonly string[] = []
): Promise<void> {
  let expr = drizzleSql`${focusSessions.metadata} || ${JSON.stringify(patch)}::jsonb`;
  for (const k of removeKeys) expr = drizzleSql`(${expr}) - ${k}`;
  await db
    .update(focusSessions)
    .set({ metadata: expr })
    .where(eq(focusSessions.id, sessionId));
}

/**
 * Run recall for one session. NEVER throws for a recall failure (it is
 * recorded on the session); see the header for the four states.
 */
export async function runSessionRecall(
  input: { sessionId: string; trigger?: "start" | "sweep" | "manual" },
  deps: Partial<RecallDeps> = {}
): Promise<SessionRecallOutcome> {
  const d: RecallDeps = { ...DEFAULT_DEPS, ...deps };
  const now = (d.now ?? (() => new Date()))();
  // Plain selects (not the relational `db.query` API): the same reads run
  // under the PGlite test, which builds a schema-less drizzle.
  const [session] = await db
    .select()
    .from(focusSessions)
    .where(eq(focusSessions.id, input.sessionId))
    .limit(1);
  if (!session) return { status: "skipped", reason: "not_found" };
  if (["closed", "failed", "cancelled"].includes(session.status)) {
    return { status: "skipped", reason: "closed" };
  }
  const priorMeta = (session.metadata ?? {}) as Record<string, unknown>;

  try {
    const [playbook] = session.playbookId
      ? await db
          .select({ name: playbooks.name })
          .from(playbooks)
          .where(eq(playbooks.id, session.playbookId))
          .limit(1)
      : [];
    // Owner-floored: a subject the owner cannot see contributes nothing.
    const [subject] = session.subjectEntityId
      ? await db
          .select({ title: entities.title, type: entities.type })
          .from(entities)
          .where(
            and(
              eq(entities.id, session.subjectEntityId),
              eq(entities.userId, session.userId)
            )
          )
          .limit(1)
      : [];
    const query = buildRecallQuery({
      title: session.title,
      goal: session.goal,
      playbookName: playbook?.name,
      subject: subject ? { title: subject.title, kind: subject.type } : null,
    });

    const linked = await db
      .select({ toId: links.toId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "session"),
          eq(links.fromId, session.id),
          eq(links.toType, "entity")
        )
      );
    const excludeIds = new Set<string>(linked.map((l) => l.toId));
    if (session.subjectEntityId) excludeIds.add(session.subjectEntityId);

    const pool = query
      ? await d.retrieve({ query, userId: session.userId, limit: RECALL_POOL })
      : [];
    const open = pool.filter((c) => !excludeIds.has(c.id));
    const sims = await d.similarity(
      query,
      open.map((c) => c.id)
    );
    const recalled = selectRecalled({
      query,
      candidates: open.map((c) => ({ ...c, semantic: sims.get(c.id) ?? null })),
      excludeIds,
      sessionWorkspaceId: session.workspaceId ?? null,
      now,
    });

    await patchMetadata(
      session.id,
      {
        recalled,
        recalledAt: now.toISOString(),
        recallTrigger: input.trigger ?? "start",
      },
      ["recallError", "recallAttempts"]
    );
    if (recalled.length === 0) return { status: "empty" };

    let posted = false;
    if (session.channelId) {
      await d.post({
        channelId: session.channelId,
        userId: session.userId,
        content: formatRecallMessage(recalled),
        idempotencyKey: recallMessageKey(session.id, recalled),
      });
      posted = true;
    }
    return { status: "ok", recalled, posted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, sessionId: session.id },
      "session recall FAILED — recorded on the session; the session stands"
    );
    const attempts = Number(priorMeta.recallAttempts ?? 0) + 1;
    try {
      await patchMetadata(session.id, {
        recallError: { message: message.slice(0, 500), at: now.toISOString() },
        recalledAt: now.toISOString(),
        recallAttempts: attempts,
        recallTrigger: input.trigger ?? "start",
      });
    } catch (stampErr) {
      logger.error(
        { err: stampErr, sessionId: session.id },
        "session recall: could not record the failure on the session"
      );
    }
    return { status: "failed", error: message };
  }
}

/**
 * The manual "recall again" door (tRPC `focusSessions.recallAgain`, Hub
 * `POST /focus-sessions/:id/recall`): owner-floored, runs NOW and returns the
 * outcome so a surface can show it. A foreign or missing session reads as
 * `not_found` — indistinguishable on purpose.
 */
export async function recallSessionAgain(
  input: { sessionId: string; userId: string },
  deps: Partial<RecallDeps> = {}
): Promise<SessionRecallOutcome> {
  const [owned] = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, input.sessionId),
        eq(focusSessions.userId, input.userId)
      )
    )
    .limit(1);
  if (!owned) return { status: "skipped", reason: "not_found" };
  return runSessionRecall({ sessionId: owned.id, trigger: "manual" }, deps);
}

/**
 * Enqueue a recall for one session (start doors + "recall again"). Never
 * throws: a session start must not fail because pg-boss is unreachable — the
 * sweep floor picks the session up within two minutes anyway.
 */
export async function enqueueSessionRecall(
  sessionId: string,
  trigger: "start" | "manual" = "start"
): Promise<boolean> {
  try {
    const { getBoss } = await import("@synap/jobs");
    const { SESSION_RECALL_QUEUE } =
      await import("@synap/jobs/workers/session-recall-worker.js");
    await getBoss().send(
      SESSION_RECALL_QUEUE,
      { sessionId, trigger },
      { singletonKey: `${sessionId}:${trigger}` }
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, sessionId },
      "session recall NOT enqueued — the sweep will pick the session up"
    );
    return false;
  }
}

/** Fill the jobs-side IoC slot. Idempotent. */
export async function registerSessionRecall(): Promise<void> {
  const { registerSessionRecallRunner } =
    await import("@synap/jobs/workers/session-recall-worker.js");
  registerSessionRecallRunner((data) => runSessionRecall(data));
}

// BOOT REGISTRATION. The other api-side runners are registered from
// `apps/api/src/index.ts`; that file is held by another session tonight, so
// this module fills its own slot on import instead. It is imported by the
// focus-sessions router (root router ⇒ loaded at boot) and by the session
// creation door, so the slot is filled before pg-boss delivers a job.
// Follow-up: move this call beside `registerFirefliesIngestRunner` there.
void registerSessionRecall().catch((err: unknown) =>
  logger.error({ err }, "session recall runner NOT registered")
);
