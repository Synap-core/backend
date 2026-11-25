/**
 * The pure half of the stage-end ask (plan 08e4fba7 decision 5): which
 * declared ask a turn's end may raise, what slot it becomes, and the write
 * door's refusals. The real path (Hub door, slot, answer, wake) is
 * `stage-end-ask.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { stageAskSlot, stageEndAskCandidates } from "../stage-end-ask.js";
import {
  playbookStagesSchema,
  stageEndAskSchema,
} from "../../../schemas/playbook-stage.js";
import type { PlaybookStageEndAsk } from "@synap/playbooks";

const choose = (label: string) => ({
  label,
  ask: { mode: "choose", options: [{ label: "Pursue" }, { label: "Drop" }] },
});

const STAGES = [
  { key: "research", name: "Research", category: "planned" },
  {
    key: "score",
    name: "Score",
    category: "started",
    endAsk: choose("Decision"),
  },
  { key: "decide", name: "Decide", category: "started", goal: "Record it." },
  {
    key: "review",
    name: "Review",
    category: "completed",
    gate: { kind: "human" },
    endAsk: choose("Close it"),
  },
];

describe("stageEndAskCandidates", () => {
  it("from the current stage on, the next declared ask, with the stage after it", () => {
    const c = stageEndAskCandidates(STAGES, "research", []);
    expect(c.map((x) => x.stage.key)).toEqual(["score"]);
    expect(c[0]!.next).toEqual({
      key: "decide",
      name: "Decide",
      goal: "Record it.",
    });
  });

  it("never past a later gated stage; AT the gated stage its ask is a candidate", () => {
    expect(stageEndAskCandidates(STAGES, "decide", [])).toEqual([]);
    expect(
      stageEndAskCandidates(STAGES, "review", []).map((x) => x.stage.key)
    ).toEqual(["review"]);
  });

  it("an ask this run raised is not raised again", () => {
    expect(stageEndAskCandidates(STAGES, "research", ["score"])).toEqual([]);
  });

  it("no current stage (or an unknown one) reads from the first stage", () => {
    for (const cur of [null, "gone"]) {
      expect(
        stageEndAskCandidates(STAGES, cur, []).map((x) => x.stage.key)
      ).toEqual(["score"]);
    }
  });

  it("stages that declare no ask, a malformed ask, or no stages at all: nothing", () => {
    expect(
      stageEndAskCandidates(
        STAGES.map(({ key, name, category }) => ({ key, name, category })),
        null,
        []
      )
    ).toEqual([]);
    expect(
      stageEndAskCandidates(
        [
          {
            key: "a",
            name: "A",
            endAsk: { label: "x", ask: { mode: "pick" } },
          },
        ],
        null,
        []
      )
    ).toEqual([]);
    expect(stageEndAskCandidates(undefined, null, [])).toEqual([]);
  });
});

describe("stageAskSlot", () => {
  const slot = (ask: unknown) =>
    stageAskSlot({ label: "L", ask } as PlaybookStageEndAsk, "Score");
  it("a decision, a credential, or the person's own act", () => {
    expect(slot({ mode: "choose", options: [{ label: "A" }] })).toMatchObject({
      slot: {
        kind: "decision",
        label: "L",
        unblocks: "The run goes on after Score",
      },
      blockedReason: "decision",
    });
    expect(
      slot({
        mode: "provide",
        provide: { kind: "connection", service: "stripe" },
      })
    ).toMatchObject({
      slot: { kind: "connection" },
      blockedReason: "credential",
    });
    expect(slot({ mode: "provide", provide: { kind: "file" } })).toMatchObject({
      slot: { kind: "file" },
      blockedReason: "physical",
    });
  });
});

describe("the write door validates a stage's endAsk", () => {
  it("accepts a declared ask; refuses a misspelled key, a bad ask, or optionsFrom on a non-choose", () => {
    expect(stageEndAskSchema.safeParse(choose("Decision")).success).toBe(true);
    expect(
      stageEndAskSchema.safeParse({ ...choose("D"), optionFrom: {} }).success
    ).toBe(false);
    expect(
      stageEndAskSchema.safeParse({
        label: "D",
        ask: { mode: "choose", options: [] },
      }).success
    ).toBe(false);
    expect(
      stageEndAskSchema.safeParse({
        label: "D",
        ask: { mode: "confirm" },
        optionsFrom: { relation: "derived_from" },
      }).success
    ).toBe(false);
    const parsed = playbookStagesSchema.safeParse(STAGES);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data[1]!.endAsk?.label).toBe("Decision");
  });
});
