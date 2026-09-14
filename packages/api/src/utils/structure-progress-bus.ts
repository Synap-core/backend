/**
 * Live structure progress — the in-process bus behind the progress tail
 * (`GET /api/capture/runs/:captureRunId/progress`, `routers/capture-progress-stream.ts`).
 *
 * `capture.structure` stays the ONE structuring door and its response is never
 * touched. While it runs, a reporter (bound per call through AsyncLocalStorage,
 * the `chat-turn-observer.ts` pattern) appends real progress frames to a
 * per-run ring buffer; the tail replays and follows that buffer.
 *
 * PRIVACY. The key is `${serverUserId}:${captureRunId}` — the user id comes
 * from the authenticated context on BOTH sides, never from a body or query
 * field. A user who subscribes to someone else's run id lands on a separate,
 * empty key. Frames never reach the bridge, webhooks or logs.
 *
 * ORDERING. The client opens the tail BEFORE calling the mutation, so either
 * side may create the entry; both create it under the same key and the other
 * attaches. A late tail replays from the buffer (`after=<seq>`).
 *
 * HONESTY. A stage frame is appended only on a real transition; a draft frame
 * only when the settled set changed, at most 4/s; `done` closes the run.
 *
 * ASSUMPTION: the pod API runs as ONE process (no replicas in
 * `deploy/docker-compose.yml`). If it scales out, this moves to the bridge.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  STRUCTURE_PROGRESS_LIMITS,
  type StructureDraftEntity,
  type StructureOutcome,
  type StructureProgressEvent,
  type StructureStage,
} from "@synap-core/types/capture";

/** Frames kept per run; the oldest drop first. */
export const STRUCTURE_PROGRESS_BUFFER_MAX = 64;
/** How long a finished run stays replayable. */
export const STRUCTURE_PROGRESS_DONE_TTL_MS = 60_000;
/** How long an entry with no `done` survives without activity (a tail that no mutation followed, a crashed run). */
export const STRUCTURE_PROGRESS_IDLE_TTL_MS = 180_000;
/** Hard ceiling on live entries in the process; the least recently touched go first. */
export const STRUCTURE_PROGRESS_ENTRIES_MAX = 2_000;

const DRAFT_MIN_INTERVAL_MS = Math.ceil(
  1000 / STRUCTURE_PROGRESS_LIMITS.draftFramesPerSecondMax
);

type Listener = (event: StructureProgressEvent) => void;

interface RunEntry {
  frames: StructureProgressEvent[];
  seq: number;
  done: boolean;
  touchedAt: number;
  listeners: Set<Listener>;
  /** Last stage frame appended — a repeat of it is not a transition. */
  lastStage: { stage: StructureStage; attempt: number } | null;
  /** Highest attempt any frame carried. */
  attempt: number;
  rev: number;
  /** Normalised key of the last appended draft (per attempt). */
  lastDraftKey: string | null;
  lastDraftAt: number;
  pendingDraft: { attempt: number; entities: StructureDraftEntity[] } | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

let now: () => number = Date.now;
const runs = new Map<string, RunEntry>();

function runKey(userId: string, captureRunId: string): string {
  return `${userId}:${captureRunId}`;
}

function expired(entry: RunEntry, at: number): boolean {
  return entry.done
    ? at - entry.touchedAt > STRUCTURE_PROGRESS_DONE_TTL_MS
    : at - entry.touchedAt > STRUCTURE_PROGRESS_IDLE_TTL_MS;
}

function drop(key: string, entry: RunEntry): void {
  if (entry.pendingTimer) clearTimeout(entry.pendingTimer);
  runs.delete(key);
}

/** Lazy sweep on every create — no interval timer to own or leak. */
function sweep(at: number): void {
  for (const [key, entry] of runs) {
    // A run someone is still reading is never collected under them.
    if (entry.listeners.size === 0 && expired(entry, at)) drop(key, entry);
  }
  // Map iteration is insertion order; re-inserting on touch is not worth it —
  // over the ceiling, the oldest-created idle entries go.
  for (const [key, entry] of runs) {
    if (runs.size <= STRUCTURE_PROGRESS_ENTRIES_MAX) break;
    if (entry.listeners.size === 0) drop(key, entry);
  }
}

function getOrCreate(userId: string, captureRunId: string): RunEntry {
  const key = runKey(userId, captureRunId);
  const at = now();
  const existing = runs.get(key);
  if (existing && !(existing.listeners.size === 0 && expired(existing, at))) {
    existing.touchedAt = at;
    return existing;
  }
  if (existing) drop(key, existing);
  sweep(at);
  const entry: RunEntry = {
    frames: [],
    seq: 0,
    done: false,
    touchedAt: at,
    listeners: new Set(),
    lastStage: null,
    attempt: 1,
    rev: 0,
    lastDraftKey: null,
    lastDraftAt: Number.NEGATIVE_INFINITY,
    pendingDraft: null,
    pendingTimer: null,
  };
  runs.set(key, entry);
  return entry;
}

type FrameBody =
  | { kind: "stage"; stage: StructureStage; attempt: number; at: string }
  | {
      kind: "draft";
      attempt: number;
      rev: number;
      entities: StructureDraftEntity[];
    }
  | { kind: "done"; outcome: StructureOutcome };

function append(entry: RunEntry, body: FrameBody): void {
  if (entry.done) return;
  entry.seq += 1;
  const frame = { v: 1, seq: entry.seq, ...body } as StructureProgressEvent;
  entry.frames.push(frame);
  if (entry.frames.length > STRUCTURE_PROGRESS_BUFFER_MAX) entry.frames.shift();
  entry.touchedAt = now();
  if (body.kind === "done") entry.done = true;
  for (const listener of entry.listeners) {
    try {
      listener(frame);
    } catch {
      // A reader is never allowed to affect the run or the other readers.
    }
  }
}

function normaliseDraft(
  entities: ReadonlyArray<StructureDraftEntity>
): StructureDraftEntity[] {
  const out: StructureDraftEntity[] = [];
  for (const e of entities) {
    if (out.length >= STRUCTURE_PROGRESS_LIMITS.draftEntitiesMax) break;
    if (typeof e?.title !== "string" || typeof e?.profileSlug !== "string")
      continue;
    const title = e.title.trim();
    const profileSlug = e.profileSlug.trim();
    if (!title || !profileSlug) continue;
    const chars = Array.from(title);
    out.push({
      title:
        chars.length > STRUCTURE_PROGRESS_LIMITS.titleMaxChars
          ? chars.slice(0, STRUCTURE_PROGRESS_LIMITS.titleMaxChars).join("")
          : title,
      profileSlug,
    });
  }
  return out;
}

function flushDraft(entry: RunEntry): void {
  if (entry.pendingTimer) {
    clearTimeout(entry.pendingTimer);
    entry.pendingTimer = null;
  }
  const pending = entry.pendingDraft;
  entry.pendingDraft = null;
  if (!pending || entry.done) return;
  const key = `${pending.attempt}|${JSON.stringify(pending.entities)}`;
  if (key === entry.lastDraftKey) return;
  entry.lastDraftKey = key;
  entry.lastDraftAt = now();
  append(entry, {
    kind: "draft",
    attempt: pending.attempt,
    rev: entry.rev++,
    entities: pending.entities,
  });
}

function cancelPendingDraft(entry: RunEntry): void {
  if (entry.pendingTimer) clearTimeout(entry.pendingTimer);
  entry.pendingTimer = null;
  entry.pendingDraft = null;
}

// ── Reporter (the mutation side) ────────────────────────────────────────────

export interface StructureProgressReporter {
  /** A real stage transition in pod code; a repeat is a no-op. */
  stage(stage: StructureStage): void;
  /**
   * Forward one decoded IS frame. Only `stage` and `draft` are taken; the IS
   * `seq` is ignored (this bus owns sequencing) and its `attempt` is offset by
   * the pod-side retries so far, so attempts stay monotonic across retries.
   */
  forward(event: StructureProgressEvent): void;
  /** The pod is retrying the IS call: the next call's attempts come after every attempt seen, and the draft resets. */
  retry(): void;
  done(outcome: StructureOutcome): void;
}

export function attachStructureProgressReporter(
  userId: string,
  captureRunId: string
): StructureProgressReporter {
  const entry = getOrCreate(userId, captureRunId);
  /** Attempts consumed by earlier IS calls of this mutation. */
  let attemptBase = 0;

  const stageAt = (stage: StructureStage, attempt: number) => {
    const last = entry.lastStage;
    if (last && last.stage === stage && last.attempt === attempt) return;
    // A superseded attempt's partial must never outlive it.
    if (attempt > entry.attempt) cancelPendingDraft(entry);
    entry.attempt = Math.max(entry.attempt, attempt);
    entry.lastStage = { stage, attempt };
    append(entry, {
      kind: "stage",
      stage,
      attempt,
      at: new Date(now()).toISOString(),
    });
  };

  const draftAt = (
    attempt: number,
    raw: ReadonlyArray<StructureDraftEntity>
  ) => {
    if (entry.done || attempt < entry.attempt) return;
    entry.attempt = attempt;
    const entities = normaliseDraft(raw);
    // The settled set did not change since the last frame sent: nothing to
    // send, and a change that was waiting for its window is now superseded.
    if (`${attempt}|${JSON.stringify(entities)}` === entry.lastDraftKey) {
      cancelPendingDraft(entry);
      return;
    }
    entry.pendingDraft = { attempt, entities };
    const wait = entry.lastDraftAt + DRAFT_MIN_INTERVAL_MS - now();
    if (wait <= 0) {
      flushDraft(entry);
    } else if (!entry.pendingTimer) {
      entry.pendingTimer = setTimeout(() => flushDraft(entry), wait);
      entry.pendingTimer.unref?.();
    }
  };

  return {
    stage(stage) {
      stageAt(stage, entry.attempt);
    },
    forward(event) {
      if (event.kind === "stage")
        stageAt(event.stage, attemptBase + event.attempt);
      else if (event.kind === "draft")
        draftAt(attemptBase + event.attempt, event.entities);
    },
    retry() {
      attemptBase = entry.attempt;
      cancelPendingDraft(entry);
      // Reset only a draft the reader can actually see.
      if (entry.lastDraftKey !== null && !entry.lastDraftKey.endsWith("|[]")) {
        entry.pendingDraft = { attempt: attemptBase + 1, entities: [] };
        entry.attempt = attemptBase + 1;
        flushDraft(entry);
      }
    },
    done(outcome) {
      cancelPendingDraft(entry);
      append(entry, { kind: "done", outcome });
    },
  };
}

// ── Subscriber (the tail side) ──────────────────────────────────────────────

export interface StructureProgressSubscription {
  /** Frames with `seq > after` still in the buffer, oldest first. */
  replay: StructureProgressEvent[];
  /** True when the run already finished — close after the replay. */
  done: boolean;
  unsubscribe(): void;
}

export function subscribeStructureProgress(
  userId: string,
  captureRunId: string,
  after: number,
  listener: Listener
): StructureProgressSubscription {
  const entry = getOrCreate(userId, captureRunId);
  const replay = entry.frames.filter((f) => f.seq > after);
  entry.listeners.add(listener);
  return {
    replay,
    done: entry.done,
    unsubscribe() {
      entry.listeners.delete(listener);
      entry.touchedAt = now();
    },
  };
}

// ── The per-call scope (capture.structure) ──────────────────────────────────

const reporterStorage = new AsyncLocalStorage<StructureProgressReporter>();

export function runWithStructureProgress<T>(
  reporter: StructureProgressReporter,
  operation: () => Promise<T>
): Promise<T> {
  return reporterStorage.run(reporter, operation);
}

/** A real stage transition in pod code. No-op outside a progress run. */
export function reportStructureStage(stage: StructureStage): void {
  try {
    reporterStorage.getStore()?.stage(stage);
  } catch {
    // Progress is never allowed to affect the structure call.
  }
}

/** The pod retries the IS call. No-op outside a progress run. */
export function reportStructureRetry(): void {
  try {
    reporterStorage.getStore()?.retry();
  } catch {
    // Progress is never allowed to affect the structure call.
  }
}

/**
 * The `onProgress` sink for `client.structure(input, { onProgress })`, or
 * undefined outside a progress run — so a call with no run sends exactly
 * today's request (no `Accept: text/event-stream`).
 */
export function structureProgressSink():
  ((event: StructureProgressEvent) => void) | undefined {
  const reporter = reporterStorage.getStore();
  if (!reporter) return undefined;
  return (event) => {
    try {
      reporter.forward(event);
    } catch {
      // Progress is never allowed to affect the structure call.
    }
  };
}

/** Test seam only. */
export const __structureProgressBusForTests = {
  reset(): void {
    for (const [key, entry] of runs) drop(key, entry);
    now = Date.now;
  },
  setNow(fn: () => number): void {
    now = fn;
  },
  size(): number {
    return runs.size;
  },
};
