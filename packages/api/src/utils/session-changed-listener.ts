/**
 * Session changed listener — the ONE producer of `focus_session:updated`.
 *
 * Migration 0277 puts an AFTER INSERT/UPDATE/DELETE row trigger on
 * `focus_sessions` (and on `session_evaluations`, keyed by session_id) that
 * NOTIFYs `focus_session_changed` with the session id. This module LISTENs on
 * that channel from the api process, coalesces bursts per id, and emits
 * `focus_session:updated` — so every writer (services, proposal executors,
 * jobs, raw SQL, future code) pushes live without being on a list.
 *
 * Wire contract (kept from the realtime security lane): payload is ID-ONLY
 * `{ id, sessionId }`, sent to the `user:` rooms of exactly the session's
 * READERS — `sessionReaderIds` (access/session-visibility.ts): the owner plus
 * each human seat the read predicate itself admits, so the push audience can
 * never drift from who may read the session. Never `workspace:<id>` (every
 * member's socket) and never the goal. Clients refetch through their own read
 * floor.
 *
 * Polling stays the floor: a NOTIFY sent while no listener is connected is
 * lost, and a hard-deleted session has no row left to resolve an audience
 * from, so its delete pushes nothing.
 *
 * Tripwire: `__tripwires__/focus-session-updated-one-producer.test.ts`.
 */

import { sql as pgSql } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { postToBridge } from "./domain-event-bridge.js";
import { sessionReaderIds } from "../access/session-visibility.js";

const logger = createLogger({ module: "session-changed-listener" });

/** The NOTIFY channel migration 0277's trigger functions write to. */
export const SESSION_CHANGED_CHANNEL = "focus_session_changed";

/** Wire name kept for the clients (`socket-io-manager.ts` maps it). */
export const FOCUS_SESSION_UPDATED = "focus_session:updated";

/** Heartbeat payload — not a uuid, so it can never be read as a session id. */
const PING = "__listener_ping__";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the audience and post one id-only emit per member. Never throws. */
export async function emitSessionUpdated(sessionId: string): Promise<void> {
  let audience: string[];
  try {
    audience = await sessionReaderIds(sessionId);
  } catch (err) {
    logger.warn(
      { err, sessionId },
      "focus_session:updated audience read failed"
    );
    return;
  }
  const data = { id: sessionId, sessionId };
  for (const userId of audience) {
    postToBridge(
      JSON.stringify({ event: FOCUS_SESSION_UPDATED, data, userId }),
      {
        sessionId,
        socketEvent: FOCUS_SESSION_UPDATED,
      }
    );
  }
}

/**
 * Per-id coalescing window. The FIRST notify for an id opens a window; every
 * notify for that id inside it is absorbed; one emit fires when it closes. A
 * fixed window (not a trailing debounce) so a session written continuously
 * still pushes every `windowMs` instead of starving. The emit reads the
 * current state, so anything written before it fires is covered.
 */
export function createSessionChangeCoalescer(opts: {
  windowMs: number;
  emit: (sessionId: string) => void;
}) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    push(sessionId: string): void {
      if (pending.has(sessionId)) return;
      pending.set(
        sessionId,
        setTimeout(() => {
          pending.delete(sessionId);
          opts.emit(sessionId);
        }, opts.windowMs)
      );
    },
    stop(): void {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
  };
}

/** The slice of postgres.js `sql` the listener needs (PGlite is adapted to it in tests). */
export interface NotifySource {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListen?: () => void
  ): Promise<{ unlisten: () => Promise<void> }>;
  notify(channel: string, payload: string): Promise<void>;
}

const postgresSource: NotifySource = {
  listen: (channel, onNotify, onListen) =>
    pgSql.listen(channel, onNotify, onListen),
  notify: async (channel, payload) => {
    await pgSql`SELECT pg_notify(${channel}, ${payload})`;
  },
};

/**
 * Start the ONE listener. `sql.listen` (postgres.js 3.4) opens a dedicated
 * connection and re-issues LISTEN when it closes — but it swallows a failed
 * re-LISTEN (`listen(...).catch(noop)` in its onclose), so a database outage
 * longer than one connect attempt would silently end the push for good. The
 * heartbeat closes that hole: every `heartbeatMs` it NOTIFYs a ping through
 * the regular pool; if the previous ping never came back, the LISTEN is
 * re-established. Logs, never throws.
 */
export async function startSessionChangedListener(
  opts: {
    source?: NotifySource;
    windowMs?: number;
    heartbeatMs?: number;
    emit?: (sessionId: string) => void;
  } = {}
): Promise<{ stop: () => Promise<void> }> {
  const source = opts.source ?? postgresSource;
  const emit = opts.emit ?? ((id: string) => void emitSessionUpdated(id));
  const coalescer = createSessionChangeCoalescer({
    windowMs: opts.windowMs ?? 300,
    emit,
  });
  let pingOutstanding = false;
  let handle: { unlisten: () => Promise<void> } | null = null;
  let stopped = false;

  const onNotify = (payload: string) => {
    if (payload === PING) {
      pingOutstanding = false;
      return;
    }
    if (!UUID_RE.test(payload)) {
      logger.warn(
        { payload },
        "focus_session_changed: ignored non-uuid payload"
      );
      return;
    }
    coalescer.push(payload);
  };

  const listen = async () => {
    try {
      handle = await source.listen(SESSION_CHANGED_CHANNEL, onNotify, () =>
        logger.info({ channel: SESSION_CHANGED_CHANNEL }, "LISTEN established")
      );
    } catch (err) {
      handle = null;
      logger.warn({ err }, "focus_session_changed: LISTEN failed; will retry");
    }
  };

  await listen();

  const heartbeat = setInterval(() => {
    void (async () => {
      if (stopped) return;
      if (pingOutstanding || !handle) {
        logger.warn("focus_session_changed: heartbeat lost; re-listening");
        await handle?.unlisten().catch(() => undefined);
        handle = null;
        await listen();
      }
      pingOutstanding = true;
      try {
        await source.notify(SESSION_CHANGED_CHANNEL, PING);
      } catch (err) {
        logger.warn({ err }, "focus_session_changed: heartbeat notify failed");
      }
    })();
  }, opts.heartbeatMs ?? 60_000);
  heartbeat.unref?.();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(heartbeat);
      coalescer.stop();
      await handle?.unlisten().catch(() => undefined);
    },
  };
}
