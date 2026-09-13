import { describe, it, expect } from "vitest";
import {
  mapGcalToGraph,
  gcalTime,
  isAllDayStart,
  normalizeEventTitle,
  startBucketWindow,
  type GCalItem,
} from "./map-gcal-to-graph.js";

// Literal `events.list` item shape (fields per the Calendar v3 Events resource).
const timed: GCalItem = {
  id: "gcal_abc123",
  status: "confirmed",
  summary: "Sync with Acme",
  start: { dateTime: "2026-07-16T15:30:00Z" },
  end: { dateTime: "2026-07-16T16:15:00Z" },
  location: "Paris office",
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  htmlLink: "https://www.google.com/calendar/event?eid=Z2NhbF9hYmMxMjM",
  description: "Quarterly review",
  attendees: [
    { email: "jelle@acme-corp.io", displayName: "Jelle Bets" },
    { email: "owner@perso.me", self: true },
    { email: "room-a@resource.calendar.google.com", resource: true },
  ],
};

describe("gcalTime / isAllDayStart", () => {
  it("reads dateTime, date, and bare strings", () => {
    expect(gcalTime({ dateTime: "2026-07-16T15:30:00Z" })).toBe(
      "2026-07-16T15:30:00Z"
    );
    expect(gcalTime({ date: "2026-07-16" })).toBe("2026-07-16");
    expect(gcalTime("2026-07-16T15:30:00Z")).toBe("2026-07-16T15:30:00Z");
    expect(gcalTime(undefined)).toBeUndefined();
    expect(gcalTime({})).toBeUndefined();
  });

  it("flags all-day only for date-without-time", () => {
    expect(isAllDayStart({ date: "2026-07-16" })).toBe(true);
    expect(isAllDayStart({ dateTime: "2026-07-16T15:30:00Z" })).toBe(false);
    expect(isAllDayStart("2026-07-16T15:30:00Z")).toBe(false);
    expect(isAllDayStart(undefined)).toBe(false);
  });
});

describe("Layer-2 dedup helpers", () => {
  it("normalizes titles (case, trim, inner whitespace)", () => {
    expect(normalizeEventTitle("  Sync   With Acme ")).toBe("sync with acme");
    expect(normalizeEventTitle(null)).toBe("");
  });

  it("buckets timed events to the hour and recurring occurrences apart", () => {
    const w = startBucketWindow("2026-07-16T15:47:12Z", false)!;
    expect(w.gte).toBe("2026-07-16T15:00:00.000Z");
    expect(w.lt).toBe("2026-07-16T16:00:00.000Z");
    const next = startBucketWindow("2026-07-23T15:00:00Z", false)!;
    expect(next.gte).not.toBe(w.gte);
  });

  it("buckets all-day events to the day; null on unparseable", () => {
    const w = startBucketWindow("2026-08-01", true)!;
    expect(w.gte).toBe("2026-08-01T00:00:00.000Z");
    expect(w.lt).toBe("2026-08-02T00:00:00.000Z");
    expect(startBucketWindow("not-a-date", false)).toBeNull();
  });
});

describe("mapGcalToGraph — timed event with corporate attendee", () => {
  const g = mapGcalToGraph(timed)!;
  const byRef = Object.fromEntries(g.graph.entities.map((e) => [e.ref, e]));
  const event = byRef["event:gcal_abc123"]!;

  it("shapes the event for event-sync and keys it on the Google event id", () => {
    expect(g.googleEventId).toBe("gcal_abc123");
    expect(event.profileSlug).toBe("event");
    expect(event.title).toBe("Sync with Acme");
    expect(event.properties).toMatchObject({
      googleEventId: "gcal_abc123",
      source: "google",
      startDate: "2026-07-16T15:30:00Z",
      endDate: "2026-07-16T16:15:00Z",
      calendarLink: "https://meet.google.com/abc-defg-hij",
      location: "Paris office",
      isAllDay: false,
      attendees: [{ email: "jelle@acme-corp.io", name: "Jelle Bets" }],
    });
  });

  it("carries the API's htmlLink as the external link url (never built)", () => {
    expect(event.identity).toEqual({
      source: "google",
      externalId: "gcal_abc123",
      url: "https://www.google.com/calendar/event?eid=Z2NhbF9hYmMxMjM",
    });
  });

  it("mints the attendee person (email identity) and corporate company", () => {
    expect(byRef["person:jelle@acme-corp.io"]).toMatchObject({
      profileSlug: "person",
      title: "Jelle Bets",
      properties: { email: "jelle@acme-corp.io" },
      identity: {
        source: "email",
        externalId: "jelle@acme-corp.io",
        url: null,
      },
    });
    expect(byRef["company:acme-corp.io"]).toMatchObject({
      profileSlug: "company",
      title: "Acme Corp",
      properties: { website: "https://acme-corp.io" },
    });
  });

  it("links attended_by, relates_to and works_at with existing relation slugs", () => {
    expect(g.graph.relations).toEqual(
      expect.arrayContaining([
        {
          sourceRef: "event:gcal_abc123",
          targetRef: "person:jelle@acme-corp.io",
          type: "attended_by",
        },
        {
          sourceRef: "event:gcal_abc123",
          targetRef: "company:acme-corp.io",
          type: "relates_to",
        },
        {
          sourceRef: "person:jelle@acme-corp.io",
          targetRef: "company:acme-corp.io",
          type: "works_at",
        },
      ])
    );
    expect(g.graph.relations).toHaveLength(3);
  });

  it("drops the owner (self) and the meeting room (resource)", () => {
    expect(
      g.graph.entities
        .filter((e) => e.profileSlug === "person")
        .map((e) => e.ref)
    ).toEqual(["person:jelle@acme-corp.io"]);
  });
});

describe("mapGcalToGraph — all-day event, consumer attendee", () => {
  const g = mapGcalToGraph({
    id: "gcal_allday",
    summary: "Company offsite",
    start: { date: "2026-08-01" },
    end: { date: "2026-08-02" },
    attendees: [{ email: "sam@gmail.com", displayName: "Sam Doe" }],
  })!;

  it("keys on DATE granularity, no company for a consumer mailbox", () => {
    expect(g.isAllDay).toBe(true);
    expect(g.graph.entities.map((e) => e.profileSlug).sort()).toEqual([
      "event",
      "person",
    ]);
    expect(g.graph.relations).toEqual([
      {
        sourceRef: "event:gcal_allday",
        targetRef: "person:sam@gmail.com",
        type: "attended_by",
      },
    ]);
  });

  it("stores a null url when the API gave no htmlLink", () => {
    expect(g.graph.entities[0]!.identity.url).toBeNull();
  });
});

describe("mapGcalToGraph — degenerate", () => {
  it("returns null without an id, without a start, or when cancelled", () => {
    expect(
      mapGcalToGraph({
        summary: "x",
        start: { dateTime: "2026-01-01T00:00:00Z" },
      })
    ).toBeNull();
    expect(mapGcalToGraph({ id: "x", summary: "no start" })).toBeNull();
    expect(
      mapGcalToGraph({
        id: "c",
        status: "cancelled",
        start: { dateTime: "2026-01-01T00:00:00Z" },
      })
    ).toBeNull();
  });

  it("falls back to email local-part when no display name is given", () => {
    const g = mapGcalToGraph({
      id: "e",
      start: { dateTime: "2026-01-01T00:00:00Z" },
      attendees: [{ email: "founder@startup.xyz" }],
    })!;
    const person = g.graph.entities.find((e) => e.profileSlug === "person")!;
    expect(person.title).toBe("founder");
  });
});
