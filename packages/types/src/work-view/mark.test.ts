/**
 * markOf answers only with the shared derivation: every mark equals what
 * `resolveUnitState` (or the canonical category tone) says for the same
 * input, and waiting wears the existing `warning` tone.
 */
import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_CATEGORY_TONE,
  resolveUnitState,
  resolveWaitKindState,
} from "../units/state.js";
import { activityLine } from "./activity-line.js";
import { markOf } from "./mark.js";
import { requestsOf, type RequestSignal } from "./requests.js";

const row = (over: Partial<RequestSignal & { waitKind?: string }>) =>
  ({
    id: "slot:s1:pick",
    kind: "owed-slot",
    title: "Pick",
    count: 1,
    groupKey: "session:s1",
    ageBucket: "recent",
    repeatCount: 1,
    ...over,
  }) as RequestSignal & { waitKind?: string };

describe("markOf", () => {
  it("a request wears its wait kind's mark", () => {
    const [req] = requestsOf([row({ waitKind: "approval" })]).headline;
    const mark = markOf({ kind: "request", request: req! });
    const want = resolveWaitKindState("approval");
    expect(mark).toEqual({
      state: want.state,
      tone: want.tone,
      glyph: want.glyph,
    });
  });

  it("a failed request is failed, whatever its wait kind", () => {
    const [req] = requestsOf([
      row({
        id: "notification:n1",
        kind: "notification",
        notificationType: "automation.broken",
        waitKind: "approval",
      }),
    ]).headline;
    expect(markOf({ kind: "request", request: req! }).state).toBe("failed");
  });

  it("a paused move wears the waiting tone, warning", () => {
    const line = activityLine(
      {
        events: [
          {
            id: "transition:1",
            kind: "status_moved",
            at: "2026-11-16T10:00:00.000Z",
            actor: { kind: "system", id: null, name: null },
            refs: {},
            from: "active",
            to: "paused",
            category: "paused",
            reason: null,
            hold: null,
          },
        ],
        truncated: false,
      },
      [],
      "trace"
    );
    const mark = markOf({ kind: "activity", entry: line.entries[0]! });
    expect(mark.tone).toBe("warning");
    expect(mark.tone).toBe(LIFECYCLE_CATEGORY_TONE.paused);
    expect(mark.glyph).toBe(resolveUnitState({ waitKind: "nobody" }).glyph);
  });

  it("a unit is resolveUnitState's answer", () => {
    const input = { owedFromYou: 2 };
    const v = resolveUnitState(input);
    expect(markOf({ kind: "unit", input })).toEqual({
      state: v.state,
      tone: v.tone,
      glyph: v.glyph,
    });
  });
});
