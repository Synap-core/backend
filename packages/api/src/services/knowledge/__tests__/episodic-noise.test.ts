import { describe, it, expect } from "vitest";
import { isEmptyToolRun } from "../episodic-noise.js";

describe("isEmptyToolRun — a capability run that found nothing (d1fe02c8)", () => {
  it.each([
    'Ran capability "market.search" → {"entries":[],"message":"Nothing matched"}',
    'Ran capability "web.search" → {"results":[],"next":[]}',
    'Ran capability "x" → []',
  ])("%s is empty", (fact) => {
    expect(isEmptyToolRun(fact)).toBe(true);
  });

  it.each([
    // It found something.
    'Ran capability "market.search" → {"entries":[{"slug":"crm"}]}',
    // No list at all: a status, a sent message — not "nothing found".
    'Ran capability "gmail.send" → {"ok":true,"id":"m1"}',
    // Cut at 1,000 chars by the deposit: unreadable, so kept.
    'Ran capability "web.search" → {"results":[{"title":"a',
    // Not a capability run.
    "Approval_failed proposals: 5 of 8 forks wrong",
  ])("%s is kept", (fact) => {
    expect(isEmptyToolRun(fact)).toBe(false);
  });
});
