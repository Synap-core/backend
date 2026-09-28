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
 */

import { createLogger } from "@synap-core/core";
import {
  listSessionAnswers,
  type SessionAnswersPage,
} from "./list-session-answers.js";
import { stampAnswersPickedUp } from "./answer-pickup.js";
import { onSessionChanged } from "../../utils/session-changed-listener.js";

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
  pollMs?: number;
  now?: () => number;
}

export function clampWaitSeconds(timeoutSeconds: number | undefined): number {
  if (timeoutSeconds === undefined || !Number.isFinite(timeoutSeconds)) {
    return WAIT_DEFAULT_SECONDS;
  }
  return Math.max(1, Math.min(WAIT_MAX_SECONDS, Math.floor(timeoutSeconds)));
}

export async function waitForSessionAnswers(
  p: {
    sessionId: string;
    /** The owner floor — same as the poll door (the operator for an agent key). */
    userId: string;
    since?: Date | null;
    timeoutSeconds?: number;
    limit?: number;
    /** The reader is an AGENT: stamp the "Picked up" receipt on what it reads. */
    stampReceipt?: boolean;
    /** Aborted when the caller hangs up — stop waiting (one last read, then `timeout`). */
    signal?: AbortSignal;
  },
  deps: WaitForAnswersDeps = {}
): Promise<WaitForAnswersResult | null> {
  const list = deps.list ?? listSessionAnswers;
  const subscribe = deps.subscribe ?? onSessionChanged;
  const stamp = deps.stamp ?? stampAnswersPickedUp;
  const pollMs = deps.pollMs ?? WAIT_FALLBACK_POLL_MS;
  const now = deps.now ?? Date.now;

  const seconds = clampWaitSeconds(p.timeoutSeconds);
  const startedAt = now();
  const deadline = startedAt + seconds * 1000;

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
      const page = await list({
        sessionId: p.sessionId,
        userId: p.userId,
        since: p.since ?? null,
        limit: p.limit,
        // No cursor = UNREAD (see the contract above).
        ...(p.since
          ? {}
          : { skipPickedUp: true, roomSince: new Date(startedAt) }),
      });
      if (!page) return null;
      if (page.answers.length > 0) {
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
        return { status: "answered", ...page };
      }
      const remaining = deadline - now();
      if (remaining <= 0 || p.signal?.aborted) {
        return {
          status: "timeout",
          sessionId: page.sessionId,
          since: page.since,
          nextSince: page.nextSince,
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
