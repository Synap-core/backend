import { describe, expect, it } from "vitest";
import {
  buildSynapCalendarIcs,
  entityToVEvent,
  escapeIcsText,
  FEED_REFRESH_HINT,
  foldIcsLine,
  formatIcsDateOnly,
  icsSequence,
  isClosedTask,
  isWithinFeedWindow,
  parseEntityDate,
  resolveEntityDateValue,
} from "./calendar-ics.js";

const HOST = "pod.example.test";

/**
 * A fixed "now" five days before the fixtures' 2026-07-25 dates.
 *
 * The feed is windowed (-30d/+365d), so every builder call must inject a clock
 * or the whole suite silently empties the day the fixtures age past 30 days —
 * a test file that goes green by asserting nothing is in it.
 */
const NOW = new Date(2026, 6, 20);

function build(
  list: Parameters<typeof buildSynapCalendarIcs>[0],
  opts?: Parameters<typeof buildSynapCalendarIcs>[2]
) {
  return buildSynapCalendarIcs(list, HOST, { now: NOW, ...opts });
}

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
    const { ics, events } = build([entity()]);
    expect(events).toHaveLength(1);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260725");
    expect(ics).toContain("DTEND;VALUE=DATE:20260726");
    expect(ics).not.toMatch(/DTSTART:2026072[45]T000000Z/);
    expect(ics).not.toContain("20260724");
  });

  it("a T00:00 ISO still places on the Y-M-D in the string", () => {
    const { ics } = build([entity({ properties: { dueDate: "2026-07-25T00:00:00.000Z" } })]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260725");
  });
});

describe("ICS builder — timed UTC", () => {
  it("emits DTSTART as a UTC instant", () => {
    const { ics } = build([
        entity({
          profileSlug: "event",
          properties: { startTime: "2026-07-25T15:30:00.000Z" },
        }),
      ]);
    expect(ics).toContain("DTSTART:20260725T153000Z");
    expect(ics).not.toContain("VALUE=DATE");
  });

  it("includes timed DTEND when endTime is present", () => {
    const { ics } = build([
        entity({
          profileSlug: "event",
          properties: {
            startTime: "2026-07-25T15:30:00.000Z",
            endTime: "2026-07-25T16:30:00.000Z",
          },
        }),
      ]);
    expect(ics).toContain("DTEND:20260725T163000Z");
  });
});

describe("ICS builder — UID stable", () => {
  it("UID is {entity.id}@{uidNamespace} and identical across rebuilds", () => {
    const e = entity();
    const a = build([e]);
    const b = build([e]);
    expect(a.ics).toContain(`UID:${e.id}@${HOST}`);
    expect(a.events[0]?.uid).toBe(b.events[0]?.uid);
    expect(entityToVEvent(e, HOST)?.uid).toBe(`${e.id}@${HOST}`);
  });
});

/**
 * SEQUENCE — RFC 5545 §3.8.7.4. Some clients only re-render a known UID when
 * this INCREASES, so it must (a) reach the body and (b) actually move when the
 * item is edited.
 *
 * Negative controls, both run and both confirmed RED, with the mutated line
 * grepped each time before believing the result:
 *  - delete `SEQUENCE:${event.sequence}` from `veventLines` → "reaches the
 *    body", "moves when updatedAt moves" and "0 when undated" all go red.
 *  - make `icsSequence` return a constant 1 → "moves when updatedAt moves"
 *    goes red on its own.
 */
describe("SEQUENCE reaches the body and increases with updatedAt", () => {
  it("emits SEQUENCE on the event", () => {
    const { ics } = build([entity({ updatedAt: "2026-07-20T00:00:00.000Z" })]);
    expect(ics).toMatch(/^SEQUENCE:\d+\r?$/m);
  });

  it("a later updatedAt yields a STRICTLY GREATER value", () => {
    const older = build([entity({ updatedAt: "2026-07-20T10:00:00.000Z" })]);
    const newer = build([entity({ updatedAt: "2026-07-20T10:05:00.000Z" })]);
    const read = (ics: string) =>
      Number(/^SEQUENCE:(\d+)\r?$/m.exec(ics)?.[1]);
    expect(read(newer.ics)).toBeGreaterThan(read(older.ics));
    expect(read(older.ics)).toBeGreaterThan(0);
  });

  it("stays inside the RFC 5545 INTEGER range", () => {
    const { ics } = build([entity({ updatedAt: "2026-07-20T00:00:00.000Z" })]);
    expect(Number(/^SEQUENCE:(\d+)\r?$/m.exec(ics)![1])).toBeLessThan(
      2147483647
    );
  });

  it("an entity with no updatedAt gets 0, never a negative or NaN", () => {
    const { ics, events } = build([entity()]);
    expect(events[0]?.sequence).toBe(0);
    expect(ics).toContain("SEQUENCE:0");
  });

  it("a pre-epoch updatedAt clamps to 0 rather than going negative", () => {
    expect(icsSequence(new Date("1999-01-01T00:00:00.000Z"))).toBe(0);
  });
});

describe("ICS builder — cancelled omitted", () => {
  it("drops a cancelled task even when it has a date", () => {
    const { ics, events } = build([
        entity({
          title: "Cancelled thing",
          properties: { dueDate: "2026-07-25", status: "cancelled" },
        }),
      ]);
    expect(events).toHaveLength(0);
    expect(ics).not.toContain("Cancelled thing");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("treats American spelling canceled the same", () => {
    expect(
      isClosedTask(
        entity({ properties: { dueDate: "2026-07-25", status: "Canceled" } })
      )
    ).toBe(true);
  });

  it("a DONE task leaves the calendar — it is not a permanent record", () => {
    // The defect: filtering only `cancelled` meant every ticked task stayed in
    // Apple Calendar forever, and the feed is read-only so the user could not
    // delete it from there.
    expect(
      isClosedTask(
        entity({ properties: { dueDate: "2026-07-25", status: "done" } })
      )
    ).toBe(true);
    const { events } = build([
      entity({
        title: "Ticked last week",
        properties: { dueDate: "2026-07-25", status: "done" },
      }),
    ]);
    expect(events).toHaveLength(0);
  });

  it("open, absent and unrecognised statuses all STAY (unknown is open)", () => {
    // Same rule as relay's isOpenStatus: a task nobody has finished is not
    // finished. An unrecognised value must not silently vanish from a calendar.
    const cases: Array<[unknown, boolean]> = [
      ["todo", false],
      ["in-progress", false],
      [undefined, false],
      ["done", true],
      ["cancelled", true],
    ];
    for (const [status, closed] of cases) {
      const props: Record<string, unknown> = { dueDate: "2026-07-25" };
      if (status !== undefined) props.status = status;
      expect(isClosedTask(entity({ properties: props })), String(status)).toBe(
        closed
      );
    }
  });

  it("does not drop a dated event whose status happens to be cancelled", () => {
    const { events } = build([
        entity({
          profileSlug: "event",
          title: "Rain plan",
          properties: { startDate: "2026-07-25", status: "cancelled" },
        }),
      ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe("Rain plan");
  });
});

describe("ICS builder — undated omitted", () => {
  it("omits an entity with no date property", () => {
    const { events, ics } = build([entity({ title: "No date", properties: {} })]);
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
    const { events } = build([
        entity({
          title: "Created only",
          properties: {},
          updatedAt: "2026-07-01T00:00:00.000Z",
        }),
      ]);
    expect(events).toHaveLength(0);
  });
});

describe("ICS envelope", () => {
  it("publishes METHOD:PUBLISH and X-WR-CALNAME:Synap", () => {
    const { ics } = build([entity()]);
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("X-WR-CALNAME:Synap");
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });

  /**
   * NAME (RFC 7986 §5.1) beside X-WR-CALNAME.
   *
   * Line-anchored, because `X-WR-CALNAME:Synap` CONTAINS the substring
   * `NAME:Synap` — a naive `toContain("NAME:Synap")` passes with the NAME line
   * deleted. Verified: with the `NAME:` push removed, the anchored assertion
   * goes red and the substring one stays green.
   *
   * Negative control (run, and the deletion grepped before believing it):
   * remove `` `NAME:${calName}` `` from buildIcsCalendar → this test red, the
   * X-WR-CALNAME test above still green.
   */
  it("emits RFC 7986 NAME with the same value as X-WR-CALNAME", () => {
    const { ics } = build([entity()]);
    expect(ics).toMatch(/^NAME:Synap\r?$/m);
    expect(ics).toMatch(/^X-WR-CALNAME:Synap\r?$/m);
  });

  /**
   * Refresh hints. These are SUGGESTIONS — RFC 7986 §5.7 calls
   * REFRESH-INTERVAL a suggested minimum, Apple appears to ignore both, and
   * Google documents neither. The test asserts only that the two lines are
   * emitted and well-formed; it makes no claim about client behaviour.
   *
   * Negative control: remove either push → this goes red on that line alone.
   */
  it("emits REFRESH-INTERVAL and X-PUBLISHED-TTL as ISO-8601 durations", () => {
    const { ics } = build([entity()]);
    expect(ics).toMatch(/^REFRESH-INTERVAL;VALUE=DURATION:PT\d+[HMD]\r?$/m);
    expect(ics).toMatch(/^X-PUBLISHED-TTL:PT\d+[HMD]\r?$/m);
    // Same value in both spellings, or a client reading one disagrees with a
    // client reading the other.
    const refresh = /^REFRESH-INTERVAL;VALUE=DURATION:(\S+?)\r?$/m.exec(ics)![1];
    const ttl = /^X-PUBLISHED-TTL:(\S+?)\r?$/m.exec(ics)![1];
    expect(refresh).toBe(ttl);
    expect(refresh).toBe(FEED_REFRESH_HINT);
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

describe("SUMMARY/DESCRIPTION escaping reaches the OUTPUT, not just the helper", () => {
  // The hole this closes: escapeIcsText was tested in isolation, and no fixture
  // title contained a character that needs escaping — so deleting the
  // escapeIcsText() wrapper from the SUMMARY line left the suite green while
  // a title with a newline could break the file into forged properties.
  const NASTY = 'Ship v2; call Bob, then\nBEGIN:VEVENT\nSUMMARY:Injected';

  it("a title with newline, semicolon and comma cannot break the line", () => {
    const { ics } = build([entity({ title: NASTY })]);
    // Exactly one event: the injected BEGIN:VEVENT must not have created one.
    // Line-anchored: the escaped text still CONTAINS "BEGIN:VEVENT" as
    // characters on the SUMMARY line — what must not exist is a second line
    // that STARTS with it.
    expect(ics.match(/^BEGIN:VEVENT\r?$/gm) ?? []).toHaveLength(1);
    expect(ics.match(/^SUMMARY:/gm) ?? []).toHaveLength(1);
    // The raw newline is gone; the ICS escape is present.
    expect(ics).toContain("\\nBEGIN:VEVENT");
    expect(ics).toContain("\;");
    expect(ics).toContain("\\,");
  });

  it("a description with a semicolon is escaped in the body", () => {
    const { ics } = build([
      entity({ properties: { dueDate: "2026-07-25", description: "a;b,c" } }),
    ]);
    expect(ics).toContain("DESCRIPTION:a\\;b\\,c");
  });

  it("the entity BODY EXCERPT never becomes the event description", () => {
    // preview is note content, not a calendar field, and this feed is served
    // over an unauthenticated URL.
    const { ics } = build([
      entity({ preview: "private notes about the client's divorce" }),
    ]);
    expect(ics).not.toContain("divorce");
    expect(ics).not.toContain("DESCRIPTION:");
  });
});

describe("the feed is windowed", () => {
  const at = (y: number, m: number, d: number) =>
    entity({ properties: { dueDate: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` } });

  it("keeps what is inside the window", () => {
    expect(isWithinFeedWindow(new Date(2026, 6, 25), NOW)).toBe(true);
    expect(isWithinFeedWindow(new Date(2026, 5, 25), NOW)).toBe(true); // 25d back
    expect(isWithinFeedWindow(new Date(2027, 5, 1), NOW)).toBe(true); // <365d
  });

  it("drops what is outside it, both directions", () => {
    expect(isWithinFeedWindow(new Date(2026, 3, 1), NOW)).toBe(false); // >30d back
    expect(isWithinFeedWindow(new Date(2028, 0, 1), NOW)).toBe(false); // >365d
  });

  it("the builder actually applies it (reachability, not just the predicate)", () => {
    const { events } = build([at(2026, 7, 25), at(2026, 1, 1), at(2029, 1, 1)]);
    expect(events).toHaveLength(1);
  });
});

/**
 * The URL line — the only thing that gets a subscriber back to the object.
 *
 * Nothing covered it before, which is what let a dead second source
 * (`VEventInput.url`, written by no producer, read through `url ?? event.url`
 * in two places) sit here looking load-bearing. With that field gone the
 * `entityUrl` callback is the ONE source, so this asserts the value ARRIVES in
 * the body — not that a field is declared.
 *
 * Negative control (verified): drop the `url` argument in `veventLines`'
 * caller and this goes red; the rest of the file stays green.
 */
describe("URL comes from entityUrl, and only from there", () => {
  it("the resolved link reaches the VEVENT body", () => {
    const { ics } = build([entity({ id: "abc" })], {
      entityUrl: (id) => `https://pod.test/e/${id}`,
    });
    expect(ics).toContain("URL:https://pod.test/e/abc");
  });

  it("no URL line when the resolver returns nothing", () => {
    const { ics } = build([entity()], { entityUrl: () => undefined });
    expect(ics).not.toContain("URL:");
  });

  it("no URL line when no resolver is supplied at all", () => {
    const { ics } = build([entity()]);
    expect(ics).not.toContain("URL:");
  });
});
