/**
 * waitForSessionAnswers — the bounded LONG-POLL over `listSessionAnswers`
 * (V1 gap G4). What `synap_wait_for_answer` and Hub
 * `GET /focus-sessions/:id/answers/wait` are built on.
 *
 * An agent the pod cannot wake (Claude Code, Codex, claude.ai) owes the person
 * a question, then has nothing to do until the answer lands. Without this it
 * ends its turn and never resumes. With it, the turn stays alive: the call
 * returns the moment an answer arrives, or a `timeout` with the cursor to
 * wait on again.
 *
 * CONTRACT (the CLI/MCP doors build on it):
 *   - same floor as the poll door (`listSessionAnswers`): owner-floored,
 *     missing and not-yours are the same `null`;
 *   - `since` is EXCLUSIVE, as in the poll; the result always carries a
 *     `nextSince` to pass back;
 *   - NO `since` = UNREAD, never "every answer so far": slot answers that
 *     carry no "Picked up" receipt yet (any age — an answer given while the
 *     agent was away still counts), and room-question answers newer than the
 *     moment the wait began. So a second ask never gets the first answer back
 *     as new. Stated limit: a SLOTLESS room answer given before the wait began
 *     is only seen with a `since` (e.g. the time the question was posted);
 *     without a receipt stamp (a person's read) slot answers stay unread;
 *   - `timeoutSeconds` is clamped to [1, {@link WAIT_MAX_SECONDS}]
 *     (default {@link WAIT_DEFAULT_SECONDS} — under common proxy idle limits);
 *   - `answered` returns the SAME page shape as the poll (typed `value`
 *     included), so a caller handles one shape either way;
 *   - a failed read THROWS — never a `timeout`, which a waiter would read as
 *     "no answer yet" and keep waiting on a broken pod.
 *
 * No busy loop: it sleeps until the session's row-change NOTIFY
 * (`onSessionChanged`, migration 0277) or a slow fallback poll
 * ({@link WAIT_FALLBACK_POLL_MS}) — the floor for a lost NOTIFY or a process
 * where the listener is not running. At most one read per wake.
 *
 * When `stampReceipt` is set (the reader is an AGENT), the slot answers it
 * returns get the "Picked up" receipt (`answer-pickup.ts`) — unless the caller
 * hung up (`signal` aborted), in which case nobody read them. A person's read
 * never stamps.
 *
 * WIDENED (the session change feed): {@link waitForSessionChanges} runs the
 * SAME loop over `listSessionChanges` — typed `answer` / `proposal_decided` /
 * `stage_moved` / `owner_message` events — when a caller asks for `events`;
 * without them the doors call this answer-only wait, unchanged. Both stamp the
 * calling conversation's runner row (`session-runners.ts`) when its client
 * named one (`X-Synap-Conversation`).
 */

import { createLogger } from "@synap-core/core";
import {
  listSessionAnswers,
  type SessionAnswersPage,
} from "./list-session-answers.js";
import { stampAnswersPickedUp } from "./answer-pickup.js";
import { onSessionChanged } from "../../utils/session-changed-listener.js";
import {
  listSessionChanges,
  type SessionChangeKind,
  type SessionChangesPage,
} from "./session-changes.js";
import { stampSessionRunner } from "./session-runners.js";

const logger = createLogger({ module: "wait-for-answers" });

export const WAIT_DEFAULT_SECONDS = 50;
/**
 * 90s: under the common 100s proxy idle limit. Codex CLI's default MCP tool
 * timeout is 60s — Codex callers pass ≤55 (said on the tool).
 */
export const WAIT_MAX_SECONDS = 90;
/** The floor poll when no NOTIFY arrives — a hint wake usually comes first. */
export const WAIT_FALLBACK_POLL_MS = 5_000;

export type WaitForAnswersResult =
  | ({ status: "answered" } & SessionAnswersPage)
  | {
      status: "timeout";
      sessionId: string;
      since: string | null;
      nextSince: string | null;
      waitedSeconds: number;
    };

export interface WaitForAnswersDeps {
  list?: typeof listSessionAnswers;
  subscribe?: typeof onSessionChanged;
  stamp?: typeof stampAnswersPickedUp;
  /** Presence of the calling conversation (`session-runners.ts`). */
  stampRunner?: typeof stampSessionRunner;
  pollMs?: number;
  now?: () => number;
}

export type WaitForChangesResult =
  | ({ status: "changed" } & SessionChangesPage)
  | ({
      status: "timeout";
      waitedSeconds: number;
    } & Omit<SessionChangesPage, "events" | "hasMore">);

export interface WaitForChangesDeps extends Omit<WaitForAnswersDeps, "list"> {
  list?: typeof listSessionChanges;
}

export function clampWaitSeconds(timeoutSeconds: number | undefined): number {
  if (timeoutSeconds === undefined || !Number.isFinite(timeoutSeconds)) {
    return WAIT_DEFAULT_SECONDS;
  }
  return Math.max(1, Math.min(WAIT_MAX_SECONDS, Math.floor(timeoutSeconds)));
}

interface WaitCommon {
  sessionId: string;
  /** The owner floor — same as the poll door (the operator for an agent key). */
  userId: string;
  since?: Date | null;
  timeoutSeconds?: number;
  limit?: number;
  /**
   * The acting agent, when an agent key calls: its read stamps the "Picked
   * up" receipt (unless `stampReceipt: false`) and names the runner's host.
   */
  agentUserId?: string | null;
  /** Aborted when the caller hangs up — stop waiting (one last read, then `timeout`). */
  signal?: AbortSignal;
}

/**
 * THE wait loop both doors share: subscribe, read, return on a hit, else sleep
 * on the session's NOTIFY (or the fallback poll) until the deadline. While a
 * conversation-named client holds it, the wait stamps that client's runner row
 * (`stampSessionRunner`, itself throttled to one write a minute) after the
 * first read proves the session readable, and again a minute later.
 */
async function waitLoop<P extends { sessionId: string }>(
  p: WaitCommon,
  deps: Pick<
    WaitForAnswersDeps,
    "subscribe" | "stampRunner" | "pollMs" | "now"
  >,
  read: (startedAt: number) => Promise<P | null>,
  isHit: (page: P) => boolean,
  onHit: (page: P) => Promise<void>
): Promise<
  | { kind: "hit"; page: P }
  | { kind: "timeout"; page: P; waitedSeconds: number }
  | null
> {
  const subscribe = deps.subscribe ?? onSessionChanged;
  const stampRunner = deps.stampRunner ?? stampSessionRunner;
  const pollMs = deps.pollMs ?? WAIT_FALLBACK_POLL_MS;
  const now = deps.now ?? Date.now;

  const seconds = clampWaitSeconds(p.timeoutSeconds);
  const startedAt = now();
  const deadline = startedAt + seconds * 1000;
  let runnerStampedAt: number | null = null;

  // Subscribe BEFORE the first read, so a write landing between the read and
  // the sleep still wakes us (no lost-wakeup window).
  let woken = false;
  let wakeResolve: (() => void) | null = null;
  const unsubscribe = subscribe(p.sessionId, () => {
    woken = true;
    wakeResolve?.();
  });

  try {
    for (;;) {
      woken = false;
      const page = await read(startedAt);
      if (!page) return null;
      if (
        runnerStampedAt === null ||
        now() - runnerStampedAt >= RUNNER_RESTAMP_MS
      ) {
        runnerStampedAt = now();
        // Never fails the wait (the stamp logs its own failure).
        await stampRunner({
          sessionId: p.sessionId,
          ownerId: p.userId,
          agentUserId: p.agentUserId ?? null,
        });
      }
      if (isHit(page)) {
        await onHit(page);
        return { kind: "hit", page };
      }
      const remaining = deadline - now();
      if (remaining <= 0 || p.signal?.aborted) {
        return {
          kind: "timeout",
          page,
          waitedSeconds: Math.round((now() - startedAt) / 1000),
        };
      }
      if (woken) continue; // a change landed during the read — re-read now
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(pollMs, remaining));
        const onAbort = () => done();
        p.signal?.addEventListener("abort", onAbort, { once: true });
        function done() {
          clearTimeout(timer);
          p.signal?.removeEventListener("abort", onAbort);
          wakeResolve = null;
          resolve();
        }
        wakeResolve = done;
      });
    }
  } finally {
    unsubscribe();
  }
}

/** Re-stamp a long wait's runner at most this often (the row throttles too). */
const RUNNER_RESTAMP_MS = 60_000;

export async function waitForSessionAnswers(
  p: WaitCommon & {
    /** The reader is an AGENT: stamp the "Picked up" receipt on what it reads. */
    stampReceipt?: boolean;
  },
  deps: WaitForAnswersDeps = {}
): Promise<WaitForAnswersResult | null> {
  const list = deps.list ?? listSessionAnswers;
  const stamp = deps.stamp ?? stampAnswersPickedUp;

  const out = await waitLoop<SessionAnswersPage>(
    p,
    deps,
    (startedAt) =>
      list({
        sessionId: p.sessionId,
        userId: p.userId,
        since: p.since ?? null,
        limit: p.limit,
        // No cursor = UNREAD (see the contract above).
        ...(p.since
          ? {}
          : { skipPickedUp: true, roomSince: new Date(startedAt) }),
      }),
    (page) => page.answers.length > 0,
    async (page) => {
      // A caller that hung up never read these — no receipt.
      if (p.stampReceipt && !p.signal?.aborted) {
        try {
          await stamp({ sessionId: p.sessionId, answers: page.answers });
        } catch (err) {
          // The answer reaching the agent outranks its receipt.
          logger.warn(
            { err, sessionId: p.sessionId },
            "wait_for_answer: picked-up receipt failed"
          );
        }
      }
    }
  );
  if (!out) return null;
  if (out.kind === "hit") return { status: "answered", ...out.page };
  return {
    status: "timeout",
    sessionId: out.page.sessionId,
    since: out.page.since,
    nextSince: out.page.nextSince,
    waitedSeconds: out.waitedSeconds,
  };
}

/**
 * The session CHANGE FEED wait — `waitForSessionAnswers` widened to every
 * kind in `listSessionChanges` (`session-changes.ts` holds the event contract).
 * Same floor, same exclusive cursor, same clamp, same wake and fallback poll.
 *
 * `stampReceipt` keeps its meaning for the `answer` kind (an agent's read is
 * the "Picked up" moment); a WATCHER passes `false` — a PEEK that never writes
 * a receipt, so the agent's own later wait still gets the answer as unread.
 *
 * `knownStage` omitted = the stage at the wait's first read is the baseline,
 * so only a move DURING this wait is reported; pass `state.currentStage` back
 * to also catch a move between two waits.
 */
export async function waitForSessionChanges(
  p: WaitCommon & {
    kinds: ReadonlySet<SessionChangeKind>;
    knownStage?: string | null;
    /** The "Picked up" receipt on returned answers. A watcher passes false. */
    stampReceipt?: boolean;
  },
  deps: WaitForChangesDeps = {}
): Promise<WaitForChangesResult | null> {
  const list = deps.list ?? listSessionChanges;
  const stamp = deps.stamp ?? stampAnswersPickedUp;
  let knownStage = p.knownStage;

  const out = await waitLoop<SessionChangesPage>(
    p,
    deps,
    async (startedAt) => {
      const page = await list({
        sessionId: p.sessionId,
        userId: p.userId,
        kinds: p.kinds,
        since: p.since ?? null,
        limit: p.limit,
        knownStage,
        // No cursor = UNREAD answers + everything newer than the wait's start.
        ...(p.since
          ? {}
          : {
              skipPickedUp: true,
              roomSince: new Date(startedAt),
              floor: new Date(startedAt),
            }),
      });
      // No `knownStage`: the first read IS the baseline.
      if (page && knownStage === undefined) {
        knownStage = page.state.currentStage;
      }
      return page;
    },
    (page) => page.events.length > 0,
    async (page) => {
      const answers = page.events.flatMap((e) =>
        e.kind === "answer" ? [e.answer] : []
      );
      if (p.stampReceipt && !p.signal?.aborted && answers.length > 0) {
        try {
          await stamp({ sessionId: p.sessionId, answers });
        } catch (err) {
          logger.warn(
            { err, sessionId: p.sessionId },
            "wait_for_answer: picked-up receipt failed"
          );
        }
      }
    }
  );
  if (!out) return null;
  if (out.kind === "hit") return { status: "changed", ...out.page };
  return {
    status: "timeout",
    sessionId: out.page.sessionId,
    since: out.page.since,
    nextSince: out.page.nextSince,
    state: out.page.state,
    waitedSeconds: out.waitedSeconds,
  };
}
