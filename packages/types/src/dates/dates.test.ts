import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getProperty,
  resolveEntityDateValue,
  isDateOnlyShaped,
  parseEntityDate,
  resolveEntityDate,
  entityDateHasTime,
} from "./index.js";

/**
 * The local-midnight construction in `parseEntityDate` is INVISIBLE under
 * TZ=UTC — `new Date(2026, 6, 25)` and `new Date("2026-07-25")` are the same
 * instant there, so a regression to plain `new Date(value)` would pass every
 * assertion. These tests therefore run under a fixed west-of-UTC zone, and the
 * self-check below asserts the zone actually took effect so the discriminating
 * cases can never go vacuous.
 */
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("test-harness self-check", () => {
  it("actually runs west of UTC, so the local-day cases discriminate", () => {
    // If this fails, every "does not shift a day west of UTC" case below is
    // vacuous and the suite proves nothing about local-midnight construction.
    expect(new Date(2026, 6, 25).getTimezoneOffset()).toBeGreaterThan(0);
    expect(new Date(2026, 6, 25).toISOString()).not.toBe(
      new Date("2026-07-25").toISOString()
    );
  });
});

describe("getProperty", () => {
  it("walks a dotted path", () => {
    expect(getProperty({ properties: { date: "x" } }, "properties.date")).toBe(
      "x"
    );
  });

  it("returns the default for a missing leaf", () => {
    expect(getProperty({ properties: {} }, "properties.date", "d")).toBe("d");
  });

  it("returns the default when a segment is null", () => {
    expect(getProperty({ properties: null }, "properties.date", "d")).toBe("d");
  });

  it("returns the default when a segment is a non-object scalar", () => {
    // The hardened guard: without `typeof current !== "object"` this would
    // read `"abc".date` and yield undefined rather than the default.
    expect(getProperty({ properties: "abc" }, "properties.date", "d")).toBe("d");
    expect(getProperty({ properties: 7 }, "properties.date", "d")).toBe("d");
  });

  it("returns the default for a non-object root", () => {
    expect(getProperty(null, "properties.date", "d")).toBe("d");
    expect(getProperty(undefined, "properties.date", "d")).toBe("d");
    expect(getProperty("nope", "properties.date", "d")).toBe("d");
  });
});

describe("resolveEntityDateValue", () => {
  const chain = ["dueDate", "startDate", "startTime", "date"] as const;

  it.each(chain)("falls back to properties.%s", (key) => {
    const entity = { properties: { [key]: `value-${key}` } };
    expect(resolveEntityDateValue(entity)).toBe(`value-${key}`);
  });

  it("honours the chain order", () => {
    const entity = {
      properties: {
        dueDate: "2026-01-01",
        startDate: "2026-02-02",
        startTime: "2026-03-03",
        date: "2026-04-04",
      },
    };
    expect(resolveEntityDateValue(entity)).toBe("2026-01-01");
    expect(
      resolveEntityDateValue({
        properties: { startDate: "2026-02-02", date: "2026-04-04" },
      })
    ).toBe("2026-02-02");
    expect(
      resolveEntityDateValue({
        properties: { startTime: "2026-03-03", date: "2026-04-04" },
      })
    ).toBe("2026-03-03");
  });

  it("prefers an explicit dateField", () => {
    const entity = {
      properties: { dueDate: "2026-01-01", publishDate: "2026-09-09" },
    };
    expect(resolveEntityDateValue(entity, "properties.publishDate")).toBe(
      "2026-09-09"
    );
  });

  it("falls through to the chain when the explicit dateField is empty", () => {
    const entity = { properties: { publishDate: "", dueDate: "2026-01-01" } };
    expect(resolveEntityDateValue(entity, "properties.publishDate")).toBe(
      "2026-01-01"
    );
  });

  it("returns null when nothing in the chain is set", () => {
    expect(resolveEntityDateValue({ properties: { title: "a person" } })).toBe(
      null
    );
  });

  it("never falls back to createdAt — an undated entity is not a calendar row", () => {
    expect(
      resolveEntityDateValue({
        createdAt: "2026-07-25T10:00:00Z",
        properties: {},
      })
    ).toBe(null);
  });
});

describe("isDateOnlyShaped", () => {
  it("treats a plain Y-M-D string as date-only", () => {
    expect(isDateOnlyShaped("2026-07-25")).toBe(true);
  });

  it("treats an exactly-midnight ISO string as date-only", () => {
    expect(isDateOnlyShaped("2026-07-25T00:00:00.000Z")).toBe(true);
    expect(isDateOnlyShaped("2026-07-25T00:00Z")).toBe(true);
    expect(isDateOnlyShaped("2026-07-25T00:00:00+02:00")).toBe(true);
  });

  it("treats a real time-of-day as NOT date-only", () => {
    expect(isDateOnlyShaped("2026-07-25T09:30:00Z")).toBe(false);
    expect(isDateOnlyShaped("2026-07-25 14:00")).toBe(false);
  });

  it("reads a Date by its LOCAL parts", () => {
    expect(isDateOnlyShaped(new Date(2026, 6, 25))).toBe(true);
    expect(isDateOnlyShaped(new Date(2026, 6, 25, 9, 30))).toBe(false);
  });

  it("never calls a number date-only — an epoch is an instant", () => {
    expect(isDateOnlyShaped(0)).toBe(false);
    expect(isDateOnlyShaped(Date.UTC(2026, 6, 25))).toBe(false);
  });
});

describe("parseEntityDate", () => {
  it("places a date-only string at LOCAL midnight, not UTC midnight", () => {
    const d = parseEntityDate("2026-07-25");
    expect(d).not.toBe(null);
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(6);
    expect(d!.getDate()).toBe(25);
    // The discriminating assertion: a regression to `new Date(value)` yields
    // the UTC-midnight instant, which is 2026-07-24 in local parts here.
    expect(d!.getTime()).toBe(new Date(2026, 6, 25).getTime());
    expect(d!.getTime()).not.toBe(new Date("2026-07-25").getTime());
  });

  it("places a UTC-midnight ISO string on the day its author wrote", () => {
    const d = parseEntityDate("2026-07-25T00:00:00.000Z");
    expect(d!.getDate()).toBe(25);
    expect(d!.getTime()).toBe(new Date(2026, 6, 25).getTime());
  });

  it("leaves a real timestamp exactly as new Date would", () => {
    expect(parseEntityDate("2026-07-25T09:30:00Z")!.getTime()).toBe(
      new Date("2026-07-25T09:30:00Z").getTime()
    );
  });

  it("passes an already-local-midnight Date straight through", () => {
    const input = new Date(2026, 6, 25);
    expect(parseEntityDate(input)).toBe(input);
  });

  it("parses an epoch number as an instant", () => {
    const ms = Date.UTC(2026, 6, 25, 9, 30);
    expect(parseEntityDate(ms)!.getTime()).toBe(ms);
  });

  it("returns null for empty and unparseable input", () => {
    expect(parseEntityDate(null)).toBe(null);
    expect(parseEntityDate(undefined)).toBe(null);
    expect(parseEntityDate("")).toBe(null);
    expect(parseEntityDate("not a date")).toBe(null);
    expect(parseEntityDate(new Date("nope"))).toBe(null);
  });
});

describe("resolveEntityDate", () => {
  it("resolves through the chain and onto the local day", () => {
    const d = resolveEntityDate({ properties: { dueDate: "2026-07-25" } });
    expect(d!.getTime()).toBe(new Date(2026, 6, 25).getTime());
  });

  it("returns null for an entity with no date", () => {
    expect(resolveEntityDate({ properties: { title: "Acme" } })).toBe(null);
  });

  it("coerces a non-scalar placement value via String() rather than throwing", () => {
    // Guards the `String(startVal)` arm: a truthy object reaches parse.
    expect(resolveEntityDate({ properties: { dueDate: {} } })).toBe(null);
    expect(
      resolveEntityDate({ properties: { dueDate: ["2026-07-25"] } })!.getTime()
    ).toBe(new Date(2026, 6, 25).getTime());
  });
});

describe("entityDateHasTime", () => {
  it("is true only for a real time-of-day", () => {
    expect(entityDateHasTime("2026-07-25T09:30:00Z")).toBe(true);
    expect(entityDateHasTime("2026-07-25")).toBe(false);
    expect(entityDateHasTime("2026-07-25T00:00:00.000Z")).toBe(false);
  });

  it("lets isAllDay win over a timed value", () => {
    expect(entityDateHasTime("2026-07-25T09:30:00Z", true)).toBe(false);
  });

  it("is false for a non-scalar", () => {
    expect(entityDateHasTime(null)).toBe(false);
    expect(entityDateHasTime({})).toBe(false);
    expect(entityDateHasTime(undefined)).toBe(false);
  });
});
