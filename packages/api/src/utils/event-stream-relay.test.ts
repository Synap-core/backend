/**
 * The hub SSE relay across a split pod (plan P6): an event the worker appends
 * reaches the API's SSE subscribers. Driven end to end through one in-memory
 * NOTIFY bus: the worker side publishes through `setupEventBroadcasting`'s own
 * relay hook (publishEventToStream), the API side listens and broadcasts.
 */
import { describe, expect, it, vi } from "vitest";
import type { EventRecord } from "@synap/database";
import type { NotifySource } from "./session-changed-listener.js";
import {
  EVENT_STREAM_CHANNEL,
  publishEventToStream,
  startEventStreamRelayListener,
} from "./event-stream-relay.js";

function bus(): NotifySource & { sent: Array<[string, string]> } {
  const listeners = new Map<string, Set<(p: string) => void>>();
  const sent: Array<[string, string]> = [];
  return {
    sent,
    async listen(channel, onNotify, onListen) {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(onNotify);
      onListen?.();
      return { unlisten: async () => void set!.delete(onNotify) };
    },
    async notify(channel, payload) {
      sent.push([channel, payload]);
      for (const f of listeners.get(channel) ?? []) f(payload);
    },
  };
}

const ID = "5b6c8f0e-3a1d-4c2b-9e7f-1a2b3c4d5e6f";
const event = { id: ID, eventType: "entity.create.completed" } as EventRecord;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("event stream relay", () => {
  it("a worker's event reaches the API's broadcast, read by id", async () => {
    const source = bus();
    const broadcast = vi.fn();
    const readEvent = vi.fn(async (id: string) => (id === ID ? event : null));
    const relay = await startEventStreamRelayListener({
      source,
      readEvent,
      broadcast,
      hasListeners: () => true,
      heartbeatMs: 60_000,
    });
    await publishEventToStream(event, source);
    await flush();
    expect(source.sent).toEqual([[EVENT_STREAM_CHANNEL, ID]]);
    expect(readEvent).toHaveBeenCalledWith(ID);
    expect(broadcast).toHaveBeenCalledWith(event);
    await relay.stop();
  });

  it("reads nothing while nobody listens on the API", async () => {
    const source = bus();
    const readEvent = vi.fn(async () => event);
    const broadcast = vi.fn();
    const relay = await startEventStreamRelayListener({
      source,
      readEvent,
      broadcast,
      hasListeners: () => false,
    });
    await publishEventToStream(event, source);
    await flush();
    expect(readEvent).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    await relay.stop();
  });

  it("ignores a payload that is not an event id", async () => {
    const source = bus();
    const readEvent = vi.fn(async () => event);
    const relay = await startEventStreamRelayListener({
      source,
      readEvent,
      broadcast: vi.fn(),
      hasListeners: () => true,
    });
    await source.notify(EVENT_STREAM_CHANNEL, "not-a-uuid");
    await flush();
    expect(readEvent).not.toHaveBeenCalled();
    await relay.stop();
  });

  it("a failed NOTIFY on the worker never throws into the event hook", async () => {
    const source: NotifySource = {
      listen: async () => ({ unlisten: async () => undefined }),
      notify: async () => {
        throw new Error("db down");
      },
    };
    await expect(publishEventToStream(event, source)).resolves.toBeUndefined();
  });
});
