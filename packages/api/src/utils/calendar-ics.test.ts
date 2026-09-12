import { describe, expect, it } from "vitest";
import {
  buildSynapCalendarIcs,
  entityToVEvent,
  escapeIcsText,
  foldIcsLine,
  formatIcsDateOnly,
  isCancelledTask,
  parseEntityDate,
  resolveEntityDateValue,
} from "./calendar-ics.js";

const HOST = "pod.example.test";

function entity(
  over: Partial<{
    id: string;
    title: string | null;
    preview: string | null;
    properties: Record<string, unknown>;
    type: string;
    profileSlug: string;
    updatedAt: Date | string;
  }> = {}
) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Deadline",
    properties: { dueDate: "2026-07-25" },
    profileSlug: "task",
    ...over,
  };
}

describe("parseEntityDate — date-only is local midnight", () => {
  it("YYYY-MM-DD is that local calendar day, not UTC", () => {
    const d = parseEntityDate("2026-07-25");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(6);
    expect(d!.getDate()).toBe(25);
    expect(formatIcsDateOnly(d!)).toBe("20260725");
  });
});

describe("ICS builder — all-day VALUE=DATE does not UTC-shift", () => {
  it("emits VALUE=DATE from the local Y-M-D, never a Z timestamp", () => {
    const { ics, events } = buildSynapCalendarIcs([entity()], HOST);
    expect(events).toHaveLength(1);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260725");
    expect(ics).toContain("DTEND;VALUE=DATE:20260726");
    expect(ics).not.toMatch(/DTSTART:2026072[45]T000000Z/);
    expect(ics).not.toContain("20260724");
  });

  it("a T00:00 ISO still places on the Y-M-D in the string", () => {
    const { ics } = buildSynapCalendarIcs(
      [entity({ properties: { dueDate: "2026-07-25T00:00:00.000Z" } })],
      HOST
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20260725");
  });
});

describe("ICS builder — timed UTC", () => {
  it("emits DTSTART as a UTC instant", () => {
    const { ics } = buildSynapCalendarIcs(
      [
        entity({
          profileSlug: "event",
          properties: { startTime: "2026-07-25T15:30:00.000Z" },
        }),
      ],
      HOST
    );
    expect(ics).toContain("DTSTART:20260725T153000Z");
    expect(ics).not.toContain("VALUE=DATE");
  });

  it("includes timed DTEND when endTime is present", () => {
    const { ics } = buildSynapCalendarIcs(
      [
        entity({
          profileSlug: "event",
          properties: {
            startTime: "2026-07-25T15:30:00.000Z",
            endTime: "2026-07-25T16:30:00.000Z",
          },
        }),
      ],
      HOST
    );
    expect(ics).toContain("DTEND:20260725T163000Z");
  });
});

describe("ICS builder — UID stable", () => {
  it("UID is {entity.id}@{podHost} and identical across rebuilds", () => {
    const e = entity();
    const a = buildSynapCalendarIcs([e], HOST);
    const b = buildSynapCalendarIcs([e], HOST);
    expect(a.ics).toContain(`UID:${e.id}@${HOST}`);
    expect(a.events[0]?.uid).toBe(b.events[0]?.uid);
    expect(entityToVEvent(e, HOST)?.uid).toBe(`${e.id}@${HOST}`);
  });
});

describe("ICS builder — cancelled omitted", () => {
  it("drops a cancelled task even when it has a date", () => {
    const { ics, events } = buildSynapCalendarIcs(
      [
        entity({
          title: "Cancelled thing",
          properties: { dueDate: "2026-07-25", status: "cancelled" },
        }),
      ],
      HOST
    );
    expect(events).toHaveLength(0);
    expect(ics).not.toContain("Cancelled thing");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("treats American spelling canceled the same", () => {
    expect(
      isCancelledTask(
        entity({ properties: { dueDate: "2026-07-25", status: "Canceled" } })
      )
    ).toBe(true);
  });

  it("does not drop a dated event whose status happens to be cancelled", () => {
    const { events } = buildSynapCalendarIcs(
      [
        entity({
          profileSlug: "event",
          title: "Rain plan",
          properties: { startDate: "2026-07-25", status: "cancelled" },
        }),
      ],
      HOST
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe("Rain plan");
  });
});

describe("ICS builder — undated omitted", () => {
  it("omits an entity with no date property", () => {
    const { events, ics } = buildSynapCalendarIcs(
      [entity({ title: "No date", properties: {} })],
      HOST
    );
    expect(events).toHaveLength(0);
    expect(ics).not.toContain("No date");
  });

  it("does NOT fall back to createdAt", () => {
    expect(
      resolveEntityDateValue({
        id: "x",
        createdAt: "2026-07-01T00:00:00.000Z",
        properties: {},
      })
    ).toBeNull();
    const { events } = buildSynapCalendarIcs(
      [
        entity({
          title: "Created only",
          properties: {},
          updatedAt: "2026-07-01T00:00:00.000Z",
        }),
      ],
      HOST
    );
    expect(events).toHaveLength(0);
  });
});

describe("ICS envelope", () => {
  it("publishes METHOD:PUBLISH and X-WR-CALNAME:Synap", () => {
    const { ics } = buildSynapCalendarIcs([entity()], HOST);
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("X-WR-CALNAME:Synap");
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });
});

describe("escape + fold", () => {
  it("escapes backslash, semicolon, comma, and newlines", () => {
    expect(escapeIcsText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
  });

  it("folds lines longer than 75 octets with CRLF+space", () => {
    const long = "SUMMARY:" + "x".repeat(80);
    const folded = foldIcsLine(long);
    expect(folded).toContain("\r\n ");
    const first = folded.split("\r\n")[0]!;
    expect(Buffer.from(first, "utf8").length).toBeLessThanOrEqual(75);
  });
});
