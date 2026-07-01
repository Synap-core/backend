import { describe, it, expect } from "vitest";
import {
  sourceKey,
  synthesizeEndTime,
  keepEntityRow,
  buildEventLocation,
  normalizeEntity,
  normalizeCalendarItem,
  type UpcomingEvent,
} from "./run-event-sync.js";

describe("sourceKey", () => {
  it("namespaces the id by source type", () => {
    expect(sourceKey("google_calendar", "abc")).toBe("google_calendar:abc");
    expect(sourceKey("deadline", "e1")).toBe("deadline:e1");
  });
});

describe("synthesizeEndTime", () => {
  it("returns the given end untouched when present", () => {
    expect(
      synthesizeEndTime("2026-07-01T10:00:00Z", "2026-07-01T12:00:00Z")
    ).toBe("2026-07-01T12:00:00Z");
  });

  it("synthesizes start + 1h when end is absent", () => {
    expect(synthesizeEndTime("2026-07-01T10:00:00Z")).toBe(
      "2026-07-01T11:00:00.000Z"
    );
  });

  it("falls back to the raw start when unparseable", () => {
    expect(synthesizeEndTime("not-a-date")).toBe("not-a-date");
  });
});

describe("keepEntityRow (source filtering by config)", () => {
  it("keeps native events only when 'event' is in sources", () => {
    expect(keepEntityRow(false, ["event", "calendar"])).toBe(true);
    expect(keepEntityRow(false, ["deadline"])).toBe(false);
  });

  it("keeps stellar deadlines only when 'deadline' is in sources", () => {
    expect(keepEntityRow(true, ["deadline"])).toBe(true);
    expect(keepEntityRow(true, ["event"])).toBe(false);
  });
});

describe("buildEventLocation", () => {
  it("prefers the meet link and surfaces the address in the description", () => {
    const evt: UpcomingEvent = {
      sourceType: "google_calendar",
      sourceId: "g1",
      title: "Sync",
      startsAt: "2026-07-01T10:00:00Z",
      url: "https://meet.google.com/abc",
      location: "10 Downing St, London",
      description: "Quarterly review",
    };
    const { location, description } = buildEventLocation(evt);
    expect(location).toBe("https://meet.google.com/abc");
    expect(description).toContain("Quarterly review");
    expect(description).toContain("10 Downing St, London");
  });

  it("uses the address as location when there is no meet link", () => {
    const { location, description } = buildEventLocation({
      sourceType: "synap_event",
      sourceId: "e1",
      title: "Dinner",
      startsAt: "2026-07-01T10:00:00Z",
      location: "Chez Antoine",
    });
    expect(location).toBe("Chez Antoine");
    expect(description).toBeUndefined();
  });

  it("keeps a long address in the description too (Discord truncates location)", () => {
    const longAddress = "A".repeat(140);
    const { location, description } = buildEventLocation({
      sourceType: "synap_event",
      sourceId: "e2",
      title: "Offsite",
      startsAt: "2026-07-01T10:00:00Z",
      location: longAddress,
    });
    expect(location).toBe(longAddress);
    expect(description).toContain(longAddress);
  });

  it("falls back to the title when neither url nor address exists", () => {
    const { location } = buildEventLocation({
      sourceType: "deadline",
      sourceId: "d1",
      title: "Grant deadline",
      startsAt: "2026-07-01T10:00:00Z",
    });
    expect(location).toBe("Grant deadline");
  });
});

describe("normalizeEntity", () => {
  it("maps an event entity and tags stellar rows as deadlines", () => {
    const evt = normalizeEntity({
      id: "ent-1",
      title: "Fallback title",
      properties: {
        title: "Board meeting",
        startDate: "2026-07-01T09:00:00Z",
        endDate: "2026-07-01T10:00:00Z",
        location: "HQ",
        calendarLink: "https://cal/x",
        description: "Monthly",
        source: "stellar",
      },
    });
    expect(evt).not.toBeNull();
    expect(evt!.sourceType).toBe("deadline");
    expect(evt!.title).toBe("Board meeting");
    expect(evt!.url).toBe("https://cal/x");
    expect(evt!.linkedEntityId).toBe("ent-1");
  });

  it("treats non-stellar rows as native events and uses row.title fallback", () => {
    const evt = normalizeEntity({
      id: "ent-2",
      title: "Row title",
      properties: { startDate: "2026-07-01T09:00:00Z" },
    });
    expect(evt!.sourceType).toBe("synap_event");
    expect(evt!.title).toBe("Row title");
  });

  it("returns null when there is no startDate", () => {
    expect(
      normalizeEntity({ id: "ent-3", title: "x", properties: {} })
    ).toBeNull();
  });
});

describe("normalizeCalendarItem", () => {
  it("extracts dateTime from Google Calendar start/end objects", () => {
    const evt = normalizeCalendarItem({
      id: "gcal-1",
      summary: "Standup",
      start: { dateTime: "2026-07-01T09:00:00Z" },
      end: { dateTime: "2026-07-01T09:15:00Z" },
      hangoutLink: "https://meet.google.com/xyz",
    });
    expect(evt!.sourceType).toBe("google_calendar");
    expect(evt!.startsAt).toBe("2026-07-01T09:00:00Z");
    expect(evt!.endsAt).toBe("2026-07-01T09:15:00Z");
    expect(evt!.url).toBe("https://meet.google.com/xyz");
  });

  it("handles all-day events (date only) and missing id", () => {
    const allDay = normalizeCalendarItem({
      id: "gcal-2",
      summary: "Holiday",
      start: { date: "2026-07-04" },
    });
    expect(allDay!.startsAt).toBe("2026-07-04");
    expect(normalizeCalendarItem({ summary: "no id" })).toBeNull();
  });
});
