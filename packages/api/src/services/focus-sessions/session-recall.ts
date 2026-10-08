/**
 * Session recall — a just-started session is shown the raw captures and notes
 * the person already has that could help it (two tracks captured as "they
 * could match well together" come back when a DJ session starts).
 *
 * Raw captures STAY raw: nothing here files, links or edits an entity. Recall
 * is read-only on the graph and writes exactly two things, both on the session:
 *   - `metadata.recalled = [{ entityId, title, kind, score, reason, recalledAt }]`
 *     (jsonb, no migration) — what `synap_get_session` returns to the agent;
 *   - ONE message in the session's room naming them — what the person reads,
 *     and what the session's agent reads in its history.
 *
 * The READER of what this writes is ONE pure function in
 * `@synap-core/types/focus-sessions` (`projectSessionRecall`), shared by the
 * pod's doors (MCP, Hub, tRPC `focusSessions.get`), web, relay and the IS.
 *
 * ── STATES, never folded into one another ──────────────────────────────────
 *   not run   no `metadata.recalledAt`
 *   ok        `recalled` non-empty, `recalledAt`, `recallError` absent
 *   empty     `recalled: []`, `recalledAt` — posts NOTHING (an empty recall is
 *             silent in the room; the marker only stops the sweep re-asking)
 *   skipped   `recallSkipped: <reason>`, `recalled: []`, `recalledAt` — see
 *             PRIVACY and COST below
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
 * ── PRIVACY: never show a room what a member could not open ───────────────
 * Recall runs as the session OWNER, pod-wide, and both the stored list and the
 * room message are read by whoever can read the session. So when anyone else
 * can — another person in the session's room, or another person in its
 * workspace — only items IN the session's workspace (which its members can
 * open) are recalled; the owner's private captures are not. A shared session
 * with no workspace recalls nothing (`skipped: shared_without_workspace`).
 * Owner-private items are recalled only for a session only its owner reads.
 * (Agent-users in the room or workspace do not count as "anyone else": they act
 * for a person who is counted on their own.)
 *
 * ── COST: a session an automation started gets no automatic recall ─────────
 * Each recall costs embeddings and a retrieval and may post into a room nobody
 * reads. A session stamped by an automation (`metadata.automationId` /
 * `automationRunId`, `startedByAutomation`) is `skipped: automation` on start
 * and on the sweep, unless its playbook opts in with
 * `metadata.recallOnAutomatedRuns: true`. A MANUAL "recall again" always runs.
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
  ne,
  inArray,
  drizzleSql,
  channelMembers,
  entities,
  entityVectors,
  focusSessions,
  links,
  playbooks,
  users,
  workspaceMembers,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import {
  isTerminalSessionStatus,
  type RecalledItem,
  type RecallSkipReason,
} from "@synap-core/types/focus-sessions";
import { startedByAutomation } from "./session-kind.js";
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

export type { RecalledItem } from "@synap-core/types/focus-sessions";

export type SessionRecallOutcome =
  | { status: "ok"; recalled: RecalledItem[]; posted: boolean }
  | { status: "empty" }
  | { status: "skipped"; reason: RecallSkipReason }
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
  /** Can a PERSON other than the owner read this session? See PRIVACY. */
  sharedWithOthers: (session: {
    userId: string;
    channelId: string | null;
    workspaceId: string | null;
  }) => Promise<boolean>;
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

async function defaultSharedWithOthers(session: {
  userId: string;
  channelId: string | null;
  workspaceId: string | null;
}): Promise<boolean> {
  if (session.channelId) {
    const [other] = await db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, session.channelId),
          ne(channelMembers.memberId, session.userId),
          eq(channelMembers.memberKind, "human")
        )
      )
      .limit(1);
    if (other) return true;
  }
  if (session.workspaceId) {
    const [other] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, session.workspaceId),
          ne(workspaceMembers.userId, session.userId),
          ne(users.userType, "agent")
        )
      )
      .limit(1);
    if (other) return true;
  }
  return false;
}

const DEFAULT_DEPS: RecallDeps = {
  retrieve: defaultRetrieve,
  similarity: defaultSimilarity,
  post: defaultPost,
  sharedWithOthers: defaultSharedWithOthers,
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
  if (isTerminalSessionStatus(session.status)) {
    return { status: "skipped", reason: "closed" };
  }
  const priorMeta = (session.metadata ?? {}) as Record<string, unknown>;
  const skip = async (
    reason: RecallSkipReason
  ): Promise<SessionRecallOutcome> => {
    await patchMetadata(
      session.id,
      {
        recalled: [],
        recalledAt: now.toISOString(),
        recallSkipped: reason,
        recallTrigger: input.trigger ?? "start",
      },
      ["recallError", "recallAttempts"]
    );
    return { status: "skipped", reason };
  };

  try {
    const [playbook] = session.playbookId
      ? await db
          .select({ name: playbooks.name, metadata: playbooks.metadata })
          .from(playbooks)
          .where(eq(playbooks.id, session.playbookId))
          .limit(1)
      : [];
    // COST: an automation's session is not recalled unless its playbook opts
    // in; a person asking ("recall again") always is.
    if (
      input.trigger !== "manual" &&
      startedByAutomation(priorMeta) &&
      (playbook?.metadata as Record<string, unknown> | null)
        ?.recallOnAutomatedRuns !== true
    ) {
      return await skip("automation");
    }
    // PRIVACY: who else reads this session decides what may be recalled.
    const shared = await d.sharedWithOthers({
      userId: session.userId,
      channelId: session.channelId ?? null,
      workspaceId: session.workspaceId ?? null,
    });
    if (shared && !session.workspaceId) {
      return await skip("shared_without_workspace");
    }
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
    const open = pool.filter(
      (c) =>
        !excludeIds.has(c.id) &&
        // Shared: only what the session's workspace members can open.
        (!shared || c.workspaceId === session.workspaceId)
    );
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
      ["recallError", "recallAttempts", "recallSkipped"]
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
