import { describe, expect, it } from "vitest";
import { WAITING_ON_REASONS } from "./goal.js";
import {
  WAITING_ON_REASON_PARTY,
  WAITS_ON_A_PERSON,
  waitsOnAPerson,
} from "./waiting-on-party.js";

describe("who a waiting-on reason waits on", () => {
  it("a person's act unblocks input, approval and access only", () => {
    // Rules out counting other work or the outside world as "waiting on you".
    expect(WAITS_ON_A_PERSON).toEqual(["input", "approval", "access"]);
    expect(waitsOnAPerson("another_work")).toBe(false);
    expect(waitsOnAPerson("outside_world")).toBe(false);
    expect(waitsOnAPerson("approval")).toBe(true);
    expect(waitsOnAPerson(null)).toBe(false);
  });

  it("classifies every reason", () => {
    expect(Object.keys(WAITING_ON_REASON_PARTY).sort()).toEqual(
      [...WAITING_ON_REASONS].sort()
    );
  });
});
