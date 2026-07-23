import { describe, it, expect } from "vitest";
import {
  mapGcalToGraph,
  gcalTime,
  isAllDayStart,
  normalizeEventTitle,
  startBucketWindow,
  type GCalItem,
} from "./map-gcal-to-graph.js";

const timed: GCalItem = {
  id: "gcal_abc123",
  summary: "Sync with Acme",
  start: { dateTime: "2026-07-16T15:30:00Z" },
  end: { dateTime: "2026-07-16T16:15:00Z" },
  location: "Paris office",
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  htmlLink: "https://calendar.google.com/event?eid=xyz",
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
    expect(normalizeEventTitle(undefined)).toBe("");
  });

  it("buckets timed events to the hour", () => {
    const w = startBucketWindow("2026-07-16T15:47:12Z", false)!;
    expect(w.gte).toBe("2026-07-16T15:00:00.000Z");
    expect(w.lt).toBe("2026-07-16T16:00:00.000Z");
  });

  it("buckets recurring same-title occurrences into DISTINCT windows", () => {
    const a = startBucketWindow("2026-07-16T15:00:00Z", false)!;
    const b = startBucketWindow("2026-07-23T15:00:00Z", false)!;
    expect(a.gte).not.toBe(b.gte);
  });

  it("buckets all-day events to the day", () => {
    const w = startBucketWindow("2026-08-01", true)!;
    expect(w.gte).toBe("2026-08-01T00:00:00.000Z");
    expect(w.lt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("returns null on an unparseable start", () => {
    expect(startBucketWindow("not-a-date", false)).toBeNull();
  });
});

describe("mapGcalToGraph — timed event with corporate attendee", () => {
  const g = mapGcalToGraph(timed)!;
  const byRef = Object.fromEntries(g.entities.map((e) => [e.ref, e]));

  it("returns the googleEventId", () => {
    expect(g.googleEventId).toBe("gcal_abc123");
  });

  it("shapes the bare event for event-sync (startDate/endDate/calendarLink/location)", () => {
    expect(g.event.properties.googleEventId).toBe("gcal_abc123");
    expect(g.event.properties.source).toBe("google");
    expect(g.event.properties.startDate).toBe("2026-07-16T15:30:00Z");
    expect(g.event.properties.endDate).toBe("2026-07-16T16:15:00Z");
    // Meet link preferred as calendarLink; physical address as location.
    expect(g.event.properties.calendarLink).toBe(
      "https://meet.google.com/abc-defg-hij"
    );
    expect(g.event.properties.location).toBe("Paris office");
    expect(g.event.properties.isAllDay).toBe(false);
    expect(g.event.title).toBe("Sync with Acme");
  });

  it("carries the acted-on attendees on the event (self + resource dropped)", () => {
    expect(g.event.properties.attendees).toEqual([
      { email: "jelle@acme-corp.io", name: "Jelle Bets" },
    ]);
  });

  it("includes the event as an entity ref so relations can anchor to it", () => {
    expect(byRef.event.profileSlug).toBe("event");
  });

  it("mints a person from the corporate attendee (email drives dedup)", () => {
    expect(byRef.person_0.title).toBe("Jelle Bets");
    expect(byRef.person_0.properties?.email).toBe("jelle@acme-corp.io");
  });

  it("mints a company only for the corporate domain (website = dedup key)", () => {
    const company = g.entities.find((e) => e.profileSlug === "company")!;
    expect(company.title).toBe("Acme Corp");
    expect(company.properties?.website).toBe("https://acme-corp.io");
  });

  it("links event→person (attended_by) and event→company (relates_to)", () => {
    expect(g.relations).toEqual(
      expect.arrayContaining([
        {
          sourceRef: "event",
          targetRef: "person_0",
          type: "attended_by",
        },
        {
          sourceRef: "event",
          targetRef: "company_acme-corp.io",
          type: "relates_to",
        },
      ])
    );
  });

  it("does NOT create a person for the owner (self) or the meeting room (resource)", () => {
    const emails = g.entities
      .filter((e) => e.profileSlug === "person")
      .map((e) => e.properties?.email);
    expect(emails).toEqual(["jelle@acme-corp.io"]);
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

  it("keys on DATE granularity + flags all-day", () => {
    expect(g.isAllDay).toBe(true);
    expect(g.event.properties.isAllDay).toBe(true);
    expect(g.event.properties.startDate).toBe("2026-08-01");
    expect(g.event.properties.endDate).toBe("2026-08-02");
  });

  it("does NOT mint a company for a consumer mailbox", () => {
    expect(g.entities.some((e) => e.profileSlug === "company")).toBe(false);
    // event + one person only.
    expect(g.entities.map((e) => e.profileSlug).sort()).toEqual([
      "event",
      "person",
    ]);
  });

  it("still links the person via attended_by", () => {
    expect(g.relations).toEqual([
      { sourceRef: "event", targetRef: "person_0", type: "attended_by" },
    ]);
  });
});

describe("mapGcalToGraph — degenerate", () => {
  it("returns null without an id", () => {
    expect(
      mapGcalToGraph({
        summary: "x",
        start: { dateTime: "2026-01-01T00:00:00Z" },
      })
    ).toBeNull();
  });

  it("returns null without a parseable start", () => {
    expect(mapGcalToGraph({ id: "x", summary: "no start" })).toBeNull();
  });

  it("yields just the event ref when there are no attendees", () => {
    const g = mapGcalToGraph({
      id: "solo",
      summary: "Focus block",
      start: { dateTime: "2026-01-01T09:00:00Z" },
    })!;
    expect(g.entities.map((e) => e.profileSlug)).toEqual(["event"]);
    expect(g.relations).toEqual([]);
    expect(g.event.properties.attendees).toBeUndefined();
  });

  it("falls back to email local-part when no display name is given", () => {
    const g = mapGcalToGraph({
      id: "e",
      start: { dateTime: "2026-01-01T00:00:00Z" },
      attendees: [{ email: "founder@startup.xyz" }],
    })!;
    const person = g.entities.find((e) => e.profileSlug === "person")!;
    expect(person.title).toBe("founder");
  });
});
