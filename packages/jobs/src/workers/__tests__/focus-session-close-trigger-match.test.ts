/**
 * The close event's matcher branch.
 *
 * `focus_session.closed.completed` used to reach `matchTriggerSpecificFilters`'
 * final `return true` without ever being named — indistinguishable from an
 * event type nobody had considered. Two things follow from making it explicit,
 * and both are pinned here:
 *
 *  1. `toStage` was the ONLY focus_session filter that existed before the close
 *     event, and its branch inspects `stage_changed.` types only. An automation
 *     authored as `focus_session.*` + `toStage` therefore matched every close as
 *     well, and would fire on something it was never configured for.
 *  2. Narrowing a close by playbook / origin / workspace stays on the generic
 *     `filters` door (`matchFilters`, evaluated before this function for every
 *     event), so an unfiltered close automation matches every close.
 */
import { describe, it, expect } from "vitest";
import type { AutomationTriggerConfig } from "@synap/database";
import {
  matchTriggerSpecificFilters,
  matchFilters,
  FOCUS_SESSION_CLOSED_EVENT_TYPE,
} from "../automation-trigger-matcher.js";

const closeData = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  projectId: null,
  userId: "user-1",
  subjectId: null,
  playbookId: "33333333-3333-4333-8333-333333333333",
  origin: "human",
  goal: "Ship the workbench",
  status: "closed",
};

const config = (c: Partial<AutomationTriggerConfig>) =>
  c as AutomationTriggerConfig;

describe("focus_session close trigger match", () => {
  it("an unfiltered close automation matches", () => {
    expect(
      matchTriggerSpecificFilters(
        FOCUS_SESSION_CLOSED_EVENT_TYPE,
        closeData,
        config({ eventPattern: "focus_session.*" })
      )
    ).toBe(true);
  });

  it("a stage-filtered automation does NOT match a close", () => {
    expect(
      matchTriggerSpecificFilters(
        FOCUS_SESSION_CLOSED_EVENT_TYPE,
        closeData,
        config({ eventPattern: "focus_session.*", toStage: "post" })
      )
    ).toBe(false);
  });

  it("the stage branch is unchanged — the same config still matches a stage change", () => {
    // Guards the fix against over-reach: narrowing the close must not have
    // narrowed the event the filter was written for.
    expect(
      matchTriggerSpecificFilters(
        "focus_session.stage_changed.completed",
        { toStage: "post" },
        config({ eventPattern: "focus_session.*", toStage: "post" })
      )
    ).toBe(true);
  });

  it("playbook / origin / workspace narrowing works through the generic filters door", () => {
    // The three keys the close payload carries at top level. No per-domain
    // config field exists for them on purpose — this is the door that already
    // evaluates them, with the full operator grammar.
    expect(matchFilters(closeData, { playbookId: closeData.playbookId })).toBe(
      true
    );
    expect(matchFilters(closeData, { origin: "human" })).toBe(true);
    expect(matchFilters(closeData, { origin: "agent" })).toBe(false);
    expect(
      matchFilters(closeData, { origin: { $in: ["agent", "automation"] } })
    ).toBe(false);
    expect(
      matchFilters(closeData, { workspaceId: closeData.workspaceId })
    ).toBe(true);
  });
});
