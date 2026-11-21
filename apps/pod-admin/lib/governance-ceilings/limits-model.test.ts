import { describe, expect, it } from "vitest";
import {
  EMPTY_LIMIT_DRAFT,
  LIMIT_VALUE_MAX,
  createLimitInput,
  limitEndsAt,
  limitSpaceId,
  limitUsage,
  limitWho,
  parseLimitValue,
  type LimitRowLike,
} from "./limits-model";

const row = (over: Partial<LimitRowLike> = {}): LimitRowLike => ({
  id: "c1",
  principalKind: "agent",
  agentUserId: "a1",
  agentLabel: "Scout",
  scopeKind: "pod",
  workspaceId: null,
  limitValue: 50,
  expiresAt: null,
  ...over,
});

describe("limitWho", () => {
  const names = new Map([["a1", "Scout (roster)"]]);

  it("names one agent from the roster first, then the pod's label", () => {
    expect(limitWho(row(), names)).toEqual({
      kind: "agent",
      agentUserId: "a1",
      name: "Scout (roster)",
    });
    expect(limitWho(row(), new Map())).toMatchObject({ name: "Scout" });
  });

  it("never shows an id as a name", () => {
    // The pod's label falls back to the id when the agent has none.
    expect(
      limitWho(row({ agentUserId: "a9", agentLabel: "a9" }), new Map())
    ).toMatchObject({ kind: "agent", name: null });
  });

  it("says every agent, or every computer, for a pod-wide principal", () => {
    expect(limitWho(row({ principalKind: "any" }), names)).toEqual({
      kind: "any",
    });
    expect(
      limitWho(
        row({ principalKind: "class", principalClass: "machine" }),
        names
      )
    ).toEqual({ kind: "computers" });
  });
});

describe("limitSpaceId / limitEndsAt", () => {
  it("reads the whole pod as null and a space as its id", () => {
    expect(limitSpaceId(row())).toBeNull();
    expect(
      limitSpaceId(row({ scopeKind: "workspace", workspaceId: "w1" }))
    ).toBe("w1");
  });

  it("reads an allow-today raise's end, and none for a standing limit", () => {
    expect(limitEndsAt(row())).toBeNull();
    expect(limitEndsAt(row({ expiresAt: "2026-11-21T00:00:00.000Z" }))).toBe(
      Date.UTC(2026, 10, 21)
    );
  });
});

describe("limitUsage", () => {
  it("has no gauge without a count (a limit on every agent)", () => {
    expect(limitUsage(undefined, 50)).toBeNull();
    expect(limitUsage(3, 0)).toBeNull();
  });

  it("warns from 80% and says when the limit is reached", () => {
    expect(limitUsage(10, 50)).toMatchObject({
      pct: 20,
      warn: false,
      reached: false,
    });
    expect(limitUsage(40, 50)).toMatchObject({ warn: true, reached: false });
    expect(limitUsage(60, 50)).toMatchObject({
      pct: 100,
      warn: true,
      reached: true,
    });
  });
});

describe("parseLimitValue", () => {
  it("takes a whole number from 1 up to the column's maximum", () => {
    expect(parseLimitValue(" 25 ")).toBe(25);
    expect(parseLimitValue(String(LIMIT_VALUE_MAX))).toBe(LIMIT_VALUE_MAX);
  });

  it("refuses zero, fractions, signs, words and overflow", () => {
    for (const bad of ["", "0", "2.5", "-3", "+4", "ten", "1e3"]) {
      expect(parseLimitValue(bad)).toBeNull();
    }
    expect(parseLimitValue(String(LIMIT_VALUE_MAX + 1))).toBeNull();
  });
});

describe("createLimitInput", () => {
  it("builds a pod-wide limit on every agent", () => {
    expect(createLimitInput({ ...EMPTY_LIMIT_DRAFT, value: "100" })).toEqual({
      principalKind: "any",
      scopeKind: "pod",
      limitValue: 100,
    });
  });

  it("builds one agent's limit in one space", () => {
    expect(
      createLimitInput({
        who: "agent",
        agentUserId: "a1",
        where: "space",
        workspaceId: "w1",
        value: "20",
      })
    ).toEqual({
      principalKind: "agent",
      agentUserId: "a1",
      scopeKind: "workspace",
      workspaceId: "w1",
      limitValue: 20,
    });
  });

  it("stays incomplete until the agent, the space and the number are set", () => {
    expect(createLimitInput(EMPTY_LIMIT_DRAFT)).toBeNull();
    expect(
      createLimitInput({ ...EMPTY_LIMIT_DRAFT, who: "agent", value: "5" })
    ).toBeNull();
    expect(
      createLimitInput({ ...EMPTY_LIMIT_DRAFT, where: "space", value: "5" })
    ).toBeNull();
  });
});
