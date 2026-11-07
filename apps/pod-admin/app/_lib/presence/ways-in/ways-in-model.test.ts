/**
 * The ONE "ways to confirm it's you" derivation: the count's states (a failed
 * read is never "none"), the mark beside it, and what the top bar and Home
 * ask for, most urgent first.
 */
import { describe, expect, it } from "vitest";
import {
  securityNudge,
  waysIn,
  waysInMark,
  type PresenceFactorsRead,
} from "./ways-in-model";

const read = (
  data: Partial<PresenceFactorsRead> | undefined,
  extra: { isLoading?: boolean; error?: unknown } = {}
) => ({
  isLoading: extra.isLoading ?? false,
  error: extra.error ?? null,
  data:
    data === undefined
      ? undefined
      : ({
          enforce: true,
          passkeys: 0,
          deviceKeys: 0,
          totp: false,
          recoveryCodes: 0,
          waysIn: 0,
          ...data,
        } as PresenceFactorsRead),
});

describe("waysIn", () => {
  it("a failed read is failed, never none and never enough", () => {
    expect(waysIn(read(undefined, { error: new Error("503") }))).toEqual({
      kind: "failed",
    });
  });
  it("loading is loading", () => {
    expect(waysIn(read(undefined, { isLoading: true }))).toEqual({
      kind: "loading",
    });
  });
  it("two ways in are enough; one is not", () => {
    expect(waysIn(read({ waysIn: 2 }))).toMatchObject({
      kind: "ready",
      count: 2,
      enough: true,
    });
    expect(waysIn(read({ waysIn: 1 }))).toMatchObject({ enough: false });
  });
});

describe("waysInMark", () => {
  it("enough: healthy, n of 2", () => {
    expect(waysInMark(waysIn(read({ waysIn: 3 })))).toEqual({
      tone: "healthy",
      count: 3,
      of: 2,
      line: "waysIn.line.enough",
    });
  });
  it("under enforce: one is a warning, none says approvals are refused", () => {
    expect(waysInMark(waysIn(read({ waysIn: 1 })))).toMatchObject({
      tone: "stale",
      line: "waysIn.line.one",
    });
    expect(waysInMark(waysIn(read({ waysIn: 0 })))).toMatchObject({
      tone: "stale",
      line: "waysIn.line.none",
    });
  });
  it("in report mode a short count is said, not warned", () => {
    expect(
      waysInMark(waysIn(read({ waysIn: 1, enforce: false })))
    ).toMatchObject({ tone: "unknown", line: "waysIn.line.report" });
  });
  it("no mark while loading or failed", () => {
    expect(waysInMark({ kind: "loading" })).toBeNull();
    expect(waysInMark({ kind: "failed" })).toBeNull();
  });
});

describe("securityNudge (the top bar's mark and Home's card)", () => {
  it("GUARDRAIL: under enforce with one way in, it asks for a second, even when codes are saved", () => {
    expect(securityNudge(waysIn(read({ waysIn: 1 })), "set")).toBe(
      "second-way"
    );
  });
  it("under enforce with none, it asks for a first way", () => {
    expect(securityNudge(waysIn(read({ waysIn: 0 })), "not_set")).toBe(
      "first-way"
    );
  });
  it("with two ways in, missing recovery codes are still asked for (R3)", () => {
    expect(securityNudge(waysIn(read({ waysIn: 2 })), "not_set")).toBe("codes");
    expect(securityNudge(waysIn(read({ waysIn: 2 })), "set")).toBeNull();
  });
  it("report mode never asks for a second way", () => {
    expect(
      securityNudge(waysIn(read({ waysIn: 1, enforce: false })), "set")
    ).toBeNull();
  });
  it("a failed ways-in read falls back to the codes alone, never a guess", () => {
    expect(securityNudge({ kind: "failed" }, "set")).toBeNull();
    expect(securityNudge({ kind: "failed" }, "not_set")).toBe("codes");
  });
});
