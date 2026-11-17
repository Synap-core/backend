/**
 * `since` / `until` on `synap_ask` (ticket a9888512): what counts as a window,
 * what is refused, and the index unit. The window's SQL is exercised on PGlite
 * (`retrieve.body.pglite.test.ts`) and on both recall halves
 * (`hybrid-recall.window.test.ts`).
 */
import { describe, it, expect } from "vitest";
import {
  echoRecallWindow,
  parseRecallWindow,
  recallWindowSeconds,
} from "./recall-window.js";

describe("parseRecallWindow", () => {
  it("neither end = no window", () => {
    expect(parseRecallWindow({})).toEqual({ ok: true, window: null });
  });

  it("a date and a date-time with an offset are read as instants", () => {
    const r = parseRecallWindow({
      since: "2026-11-16",
      until: "2026-11-18T09:30:00+01:00",
    });
    expect(r).toEqual({
      ok: true,
      window: {
        since: new Date("2026-11-16T00:00:00.000Z"),
        until: new Date("2026-11-18T08:30:00.000Z"),
      },
    });
  });

  it("refuses a phrase, a number and an inverted window, with the reason", () => {
    const phrase = parseRecallWindow({ since: "this week" });
    expect(phrase.ok).toBe(false);
    expect(!phrase.ok && phrase.error).toMatch(/since must be an ISO-8601/);
    expect(parseRecallWindow({ until: 1763251200 }).ok).toBe(false);
    const inverted = parseRecallWindow({
      since: "2026-11-18",
      until: "2026-11-16",
    });
    expect(!inverted.ok && inverted.error).toMatch(/must be before until/);
    expect(
      parseRecallWindow({ since: "2026-11-16", until: "2026-11-16" }).ok
    ).toBe(false);
  });
});

describe("the window in the index unit and on the reply", () => {
  it("is epoch seconds, the unit the indexer writes", () => {
    expect(
      recallWindowSeconds({
        since: new Date("2026-11-16T00:00:00.000Z"),
        until: new Date("2026-11-18T00:00:00.000Z"),
      })
    ).toEqual({ updatedSince: 1794787200, updatedUntil: 1794960000 });
    expect(recallWindowSeconds(null)).toEqual({});
  });

  it("echoes both ends and the lanes it filtered", () => {
    expect(
      echoRecallWindow({ since: new Date("2026-11-16T00:00:00.000Z") })
    ).toEqual({
      since: "2026-11-16T00:00:00.000Z",
      until: null,
      field: "updatedAt",
      appliesTo: ["semantic", "structured"],
    });
  });
});
