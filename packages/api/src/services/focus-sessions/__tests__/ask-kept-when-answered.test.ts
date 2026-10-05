/**
 * W1 of the decision mesh — the ask is KEPT when answered, prior answers are
 * ARCHIVED instead of overwritten, and an ask the pod drops is SAID.
 * Pure: the stampers and the merge, no database.
 */
import { describe, it, expect } from "vitest";
import type { ExpectedOutput, SlotAnswer } from "@synap/playbooks";
import { SLOT_ANSWER_HISTORY_MAX } from "@synap/playbooks";
import { stampAnswered } from "../answer-slot.js";
import { stampBlocked } from "../block-output.js";
import { mergeExpectedOutputs, droppedAskWarnings } from "../update-session.js";
import { newlyAskedSlots } from "../slot-asked-event.js";
import { archivedAnswerHistory } from "../answer-history.js";

const A1: SlotAnswer = {
  text: "EU",
  messageId: null,
  answeredBy: "u",
  answeredAt: "2026-10-01T00:00:00.000Z",
};
const A2: SlotAnswer = {
  ...A1,
  text: "US",
  answeredAt: "2026-10-02T00:00:00.000Z",
};

const answeredAgentSlot: ExpectedOutput = {
  kind: "document",
  label: "Stripe",
  answer: A1,
};

describe("answer history — re-asks and re-answers archive, never drop", () => {
  it("a SECOND answer archives the first", () => {
    const [s] = stampAnswered([answeredAgentSlot], 0, A2);
    expect(s!.answer).toEqual(A2);
    expect(s!.answerHistory).toEqual([A1]);
  });

  it("re-blocking (stampBlocked) archives the answer it clears", () => {
    const [s] = stampBlocked(
      [answeredAgentSlot],
      "Stripe",
      "decision",
      "Again?"
    );
    expect(s!.answer).toBeUndefined();
    expect(s!.answerHistory).toEqual([A1]);
  });

  it("a wholesale patch handing the slot to the person archives it", () => {
    const [s] = mergeExpectedOutputs(
      [answeredAgentSlot],
      [
        {
          kind: "document",
          label: "Stripe",
          owner: "human",
          blockedReason: "decision",
        },
      ]
    );
    expect(s!.answer).toBeUndefined();
    expect(s!.answerHistory).toEqual([A1]);
  });

  it("is capped, keeping the NEWEST", () => {
    const many = Array.from({ length: SLOT_ANSWER_HISTORY_MAX }, (_, i) => ({
      ...A1,
      text: `old ${i}`,
    }));
    const h = archivedAnswerHistory({ answer: A2, answerHistory: many })!;
    expect(h).toHaveLength(SLOT_ANSWER_HISTORY_MAX);
    expect(h.at(-1)).toEqual(A2);
    expect(h[0]!.text).toBe("old 1");
  });

  it("a slot that never had an answer grows no key", () => {
    const [s] = stampBlocked(
      [{ kind: "document", label: "Stripe" }],
      "Stripe",
      "decision"
    );
    expect("answerHistory" in s!).toBe(false);
  });
});

describe("decisionId survives the hand-back", () => {
  it("answering a human slot keeps decisionId", () => {
    const [s] = stampAnswered(
      [
        {
          kind: "decision",
          label: "Decide: pricing",
          owner: "human",
          blockedReason: "decision",
          ask: { mode: "confirm" },
          decisionId: "d1",
        },
      ],
      0,
      A1
    );
    expect(s!.owner).toBeUndefined();
    expect(s!.decisionId).toBe("d1");
  });
});

describe("droppedAskWarnings — the reconciler's drop is said, not silent", () => {
  it("warns for an ask declared on an agent-owned slot", () => {
    const declared = [
      { kind: "document", label: "Pick", ask: { mode: "confirm" as const } },
    ];
    const written = mergeExpectedOutputs([], declared);
    expect(written[0]!.ask).toBeUndefined();
    const w = droppedAskWarnings(declared, written);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"Pick"');
    expect(w[0]).toContain('owner: "human"');
  });

  it("is silent when the ask landed on a human slot", () => {
    const declared: ExpectedOutput[] = [
      {
        kind: "document",
        label: "Pick",
        owner: "human",
        blockedReason: "decision",
        ask: { mode: "confirm" },
      },
    ];
    const written = mergeExpectedOutputs([], declared);
    expect(written[0]!.ask).toEqual({ mode: "confirm" });
    expect(droppedAskWarnings(declared, written)).toEqual([]);
  });
});

describe("newlyAskedSlots — one history row per POSED ask", () => {
  const human: ExpectedOutput = {
    kind: "document",
    label: "Pick",
    owner: "human",
    blockedReason: "decision",
    ask: { mode: "confirm", prompt: "Ship?" },
  };
  it("a new ask on a human slot is posed", () => {
    expect(
      newlyAskedSlots([{ kind: "document", label: "Pick" }], [human])
    ).toHaveLength(1);
  });
  it("re-sending the same ask is not a second question", () => {
    expect(newlyAskedSlots([human], [{ ...human }])).toHaveLength(0);
  });
  it("a changed ask is posed again", () => {
    expect(
      newlyAskedSlots(
        [human],
        [{ ...human, ask: { mode: "confirm", prompt: "Now?" } }]
      )
    ).toHaveLength(1);
  });
});
