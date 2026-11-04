/**
 * Event stream relay — the hub SSE stream (`/api/hub/events/stream`) and the
 * admin event stream across two processes (pod resilience plan P6).
 *
 * `eventStreamManager` fans an event out to the SSE connections held IN ITS
 * OWN PROCESS. On a split pod (SYNAP_PROCESS_ROLE=api + worker) the
 * connections live in the API while most events are appended by the worker
 * (every job, cron and reactor), so a worker event would reach nobody. The
 * worker's broadcast hook therefore NOTIFYs the event id on
 * EVENT_STREAM_CHANNEL instead of broadcasting locally, and the API LISTENs,
 * reads the row and broadcasts it. A one-process pod (`all`) broadcasts
 * locally, as it always did, and runs neither half.
 *
 * Id-only on the wire (a NOTIFY payload is capped at 8000 bytes; an event's
 * data is not): the API reads the row through `eventRepository.findById`, the
 * same EventRecord the local hook would have passed. The row is committed when
 * the hook runs (EventRepository.append inserts outside any transaction, then
 * calls its hooks), so the read finds it. Read only while someone listens.
 *
 * Polling is the floor, as for `focus_session_changed`: a NOTIFY sent while
 * the API is not listening is lost. A heartbeat re-LISTENs after a dropped
 * connection (postgres.js swallows a failed re-LISTEN).
 */

import {
  sql as pgSql,
  eventRepository,
  type EventRecord,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { isUuid } from "@synap-core/types/property-render";
import { eventStreamManager } from "../event-stream-manager.js";
import type { NotifySource } from "./session-changed-listener.js";

const logger = createLogger({ module: "event-stream-relay" });

export const EVENT_STREAM_CHANNEL = "synap_event_stream";

/** Heartbeat payload — not a uuid, so it can never be read as an event id. */
const PING = "__relay_ping__";

const postgresSource: NotifySource = {
  listen: (channel, onNotify, onListen) =>
    pgSql.listen(channel, onNotify, onListen),
  notify: async (channel, payload) => {
    await pgSql`SELECT pg_notify(${channel}, ${payload})`;
  },
};

/** Worker side: hand one appended event to the API's streams. Never throws. */
export async function publishEventToStream(
  event: Pick<EventRecord, "id">,
  source: NotifySource = postgresSource
): Promise<void> {
  try {
    await source.notify(EVENT_STREAM_CHANNEL, event.id);
  } catch (err) {
    logger.warn(
      { err, eventId: event.id },
      "event stream relay: NOTIFY failed"
    );
  }
}

/** API side: LISTEN and broadcast each relayed event. Logs, never throws. */
export async function startEventStreamRelayListener(
  opts: {
    source?: NotifySource;
    heartbeatMs?: number;
    readEvent?: (id: string) => Promise<EventRecord | null>;
    broadcast?: (event: EventRecord) => void;
    hasListeners?: () => boolean;
  } = {}
): Promise<{ stop: () => Promise<void> }> {
  const source = opts.source ?? postgresSource;
  const readEvent = opts.readEvent ?? ((id) => eventRepository.findById(id));
  const broadcast =
    opts.broadcast ?? ((e: EventRecord) => eventStreamManager.broadcast(e));
  const hasListeners =
    opts.hasListeners ?? (() => eventStreamManager.hasListeners());
  let pingOutstanding = false;
  let handle: { unlisten: () => Promise<void> } | null = null;
  let stopped = false;

  const relay = async (id: string) => {
    if (!hasListeners()) return;
    try {
      const event = await readEvent(id);
      if (event) broadcast(event);
      else logger.debug({ eventId: id }, "event stream relay: no such event");
    } catch (err) {
      logger.warn({ err, eventId: id }, "event stream relay: read failed");
    }
  };

  const onNotify = (payload: string) => {
    if (payload === PING) {
      pingOutstanding = false;
      return;
    }
    if (!isUuid(payload)) {
      logger.warn(
        { payload: payload.slice(0, 64) },
        "event stream relay: ignored non-uuid payload"
      );
      return;
    }
    void relay(payload);
  };

  const listen = async () => {
    try {
      handle = await source.listen(EVENT_STREAM_CHANNEL, onNotify, () =>
        logger.info({ channel: EVENT_STREAM_CHANNEL }, "LISTEN established")
      );
    } catch (err) {
      handle = null;
      logger.warn({ err }, "event stream relay: LISTEN failed; will retry");
    }
  };

  await listen();

  const heartbeat = setInterval(() => {
    void (async () => {
      if (stopped) return;
      if (pingOutstanding || !handle) {
        logger.warn("event stream relay: heartbeat lost; re-listening");
        await handle?.unlisten().catch(() => undefined);
        handle = null;
        await listen();
      }
      pingOutstanding = true;
      try {
        await source.notify(EVENT_STREAM_CHANNEL, PING);
      } catch (err) {
        logger.warn({ err }, "event stream relay: heartbeat notify failed");
      }
    })();
  }, opts.heartbeatMs ?? 60_000);
  heartbeat.unref?.();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(heartbeat);
      await handle?.unlisten().catch(() => undefined);
    },
  };
}
