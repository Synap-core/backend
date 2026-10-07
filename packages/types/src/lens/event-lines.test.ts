/**
 * The events log → Happened data line, for BOTH halves of the log: a record
 * change and a connection lifecycle event. Rows are chosen where a naive rule
 * disagrees: two consecutive lifecycle events of one kind (a naive batcher
 * folds "Synced Gmail · 42 new" and "Synced Gmail · 3 new" into "Synced 2
 * connections"), an app line (a naive door uses the internal uuid), a
 * webhook (its subject id is the EVENT, not a door), an "API key" noun (a naive
 * line lower-cases it to "api key").
 */
import { describe, expect, it } from "vitest";
import {
  batchHappenedItems,
  dataLineText,
  happenedItemOfEvent,
  happenedItems,
  isHappenedDataLine,
  type HappenedItem,
  type LoggedEvent,
} from "./index.js";

const at = (min: number) => new Date(Date.UTC(2026, 9, 7, 12, 60 - min)).toISOString();

function ev(over: Partial<LoggedEvent> & { type: string }): LoggedEvent {
  return { id: over.type + (over.timestamp ?? ""), timestamp: at(0), ...over };
}

function lines(items: (HappenedItem | null)[]) {
  const [day] = batchHappenedItems(items.filter((i): i is HappenedItem => !!i), {
    timeZone: "UTC",
    now: new Date(at(0)),
  });
  return day!.lines.filter(isHappenedDataLine).map(dataLineText);
}

describe("happenedItemOfEvent — one door for the whole log", () => {
  it("record changes keep their batch; lifecycle events never batch", () => {
    const out = lines([
      happenedItemOfEvent(ev({ id: "1", type: "entity.create.completed", subjectType: "entity", subjectId: "e1", data: { profileSlug: "person" }, timestamp: at(1) })),
      happenedItemOfEvent(ev({ id: "2", type: "entity.create.completed", subjectType: "entity", subjectId: "e2", data: { profileSlug: "person" }, timestamp: at(2) })),
      happenedItemOfEvent(ev({ id: "3", type: "connector_sync.complete.completed", subjectId: "c1", data: { provider: "gmail", counts: { created: 42 } }, timestamp: at(3) })),
      happenedItemOfEvent(ev({ id: "4", type: "connector_sync.complete.completed", subjectId: "c1", data: { provider: "gmail", counts: { created: 3 } }, timestamp: at(4) })),
      happenedItemOfEvent(ev({ id: "5", type: "apiKey.revoke.completed", subjectType: "apiKey", subjectId: "k1", data: { keyName: "Vercel production" }, timestamp: at(5) })),
      happenedItemOfEvent(ev({ id: "6", type: "apiKey.create.completed", subjectType: "apiKey", subjectId: "k2", timestamp: at(6) })),
    ]);
    expect(out).toEqual([
      "Created 2 people",
      "Synced Gmail · 42 new",
      "Synced Gmail · 3 new",
      'Revoked API key "Vercel production"',
      "Created API key",
    ]);
  });

  it("doors: an app by its public id, a message by its channel, a webhook by nothing", () => {
    const app = happenedItemOfEvent(ev({ type: "app.approve.completed", subjectType: "app", subjectId: "uuid-1", data: { publicId: "app_d2f2" } }));
    const msg = happenedItemOfEvent(ev({ type: "external_message.received.completed", subjectId: "ent-1", data: { channelId: "ch-1", provider: "telegram", participantName: "Ada" } }));
    const hook = happenedItemOfEvent(ev({ type: "webhooks.deliver.requested", subjectId: "evt-9", data: { status: "success", url: "https://hooks.zapier.com/a" } }));
    const sync = happenedItemOfEvent(ev({ type: "connector_sync.complete.completed", subjectType: "connector_sync", subjectId: "conn-1", data: { provider: "gmail" } }));
    const pick = (i: HappenedItem | null) => (i?.kind === "data" ? i.event.door : "not-data");
    expect(pick(app)).toEqual({ kind: "app", id: "app_d2f2" });
    expect(pick(msg)).toEqual({ kind: "channel", id: "ch-1" });
    expect(pick(hook)).toBeNull();
    expect(pick(sync)).toEqual({ kind: "connection", id: "conn-1" });
  });

  it("names a non-default writer only", () => {
    const api = happenedItemOfEvent(ev({ type: "entity.update.completed", subjectId: "e", source: "api" }));
    const sync = happenedItemOfEvent(ev({ type: "entity.update.completed", subjectId: "e", source: "sync" }));
    expect(api?.kind === "data" && api.event.origin).toBeNull();
    expect(sync?.kind === "data" && sync.event.origin).toBe("sync");
  });

  it("drops what is neither a record change nor a lifecycle fact", () => {
    for (const type of ["entity.create.requested", "connection_sync.progress", "mystery.thing.completed"]) {
      expect(happenedItemOfEvent(ev({ type, data: { phase: "fetching" } }))).toBeNull();
    }
    expect(happenedItemOfEvent(ev({ type: "entity.create.completed", timestamp: "not a date" }))).toBeNull();
  });

  it("the page wire carries the line through to the same words", () => {
    const item = happenedItemOfEvent(ev({ type: "messaging_account.created.completed", data: { provider: "whatsapp" } }));
    if (item?.kind !== "data") throw new Error("expected a data item");
    const [viaWire] = happenedItems([
      {
        id: "s1",
        kind: "event",
        title: "",
        occurredAt: item.event.occurredAt,
        event: { action: item.event.action, objectKind: item.event.objectKind, origin: null, line: item.event.line ?? null },
      },
    ]);
    expect(lines([viaWire!])).toEqual(["Connected WhatsApp"]);
  });
});
