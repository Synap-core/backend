import { describe, expect, it } from "vitest";
import {
  ASK_STAKES,
  AnswerProvenanceSchema,
  AskSchema,
  PendingRelayedAnswerSchema,
  QuestionClosedSchema,
  answerVia,
  askFingerprint,
  effectiveAskStakes,
  questionDisposition,
  type Ask,
} from "./index.js";

const ask = (a: unknown): Ask => AskSchema.parse(a);

describe("ask stakes", () => {
  it("parses on every mode and stays optional", () => {
    for (const a of [
      { mode: "confirm" },
      { mode: "choose", options: [{ label: "A" }] },
      {
        mode: "form",
        form: { fields: [{ key: "n", label: "N", type: "text" }] },
      },
      { mode: "act" },
      { mode: "provide", provide: { kind: "file" } },
    ]) {
      expect(ask(a).stakes).toBeUndefined();
      expect(ask({ ...a, stakes: "commitment" }).stakes).toBe("commitment");
    }
    expect(
      AskSchema.safeParse({ mode: "confirm", stakes: "huge" }).success
    ).toBe(false);
    expect([...ASK_STAKES]).toEqual(["routine", "commitment"]);
  });

  it("an old ask (no stakes) keeps its fingerprint", () => {
    // A client fingerprinting an ask it read before stakes existed must still
    // match the pod's own — `undefined` members are ignored.
    expect(askFingerprint(ask({ mode: "confirm" }))).toBe(
      askFingerprint({ mode: "confirm", stakes: undefined })
    );
    // …and raising the stakes IS a change of question (ask_changed).
    expect(askFingerprint(ask({ mode: "confirm" }))).not.toBe(
      askFingerprint(ask({ mode: "confirm", stakes: "commitment" }))
    );
  });
});

describe("effectiveAskStakes — an agent can only RAISE them", () => {
  it.each([
    ["no ask", null, false, "routine"],
    ["no ask, pod-forced", null, true, "commitment"],
    [
      "declared routine",
      { mode: "confirm", stakes: "routine" },
      false,
      "routine",
    ],
    // the pod's fact beats the agent's own word: an agent cannot LOWER it
    [
      "declared routine, pod-forced",
      { mode: "confirm", stakes: "routine" },
      true,
      "commitment",
    ],
    [
      "declared commitment",
      { mode: "confirm", stakes: "commitment" },
      false,
      "commitment",
    ],
    [
      "absent reads routine",
      { mode: "choose", options: [{ label: "A" }] },
      false,
      "routine",
    ],
    // visible on the ask alone ⇒ forced here, whatever the agent declared
    [
      "provide secret",
      { mode: "provide", provide: { kind: "secret", name: "Stripe" } },
      false,
      "commitment",
    ],
    [
      "provide secret declared routine",
      {
        mode: "provide",
        provide: { kind: "secret", name: "Stripe" },
        stakes: "routine",
      },
      false,
      "commitment",
    ],
    [
      "provide file",
      { mode: "provide", provide: { kind: "file" } },
      false,
      "routine",
    ],
  ] as const)("%s", (_n, a, forced, want) => {
    expect(effectiveAskStakes({ ask: a ? ask(a) : a, forced })).toBe(want);
  });
});

describe("answerVia", () => {
  it("absent via reads tap (rows stored before relays existed)", () => {
    expect(answerVia({})).toBe("tap");
    expect(answerVia(null)).toBe("tap");
    expect(answerVia({ via: "tap" })).toBe("tap");
    expect(answerVia({ via: "relayed" })).toBe("relayed");
  });

  it("the schemas take the stamp shapes and refuse an unknown via", () => {
    expect(AnswerProvenanceSchema.safeParse({ via: "chat" }).success).toBe(
      false
    );
    expect(
      PendingRelayedAnswerSchema.safeParse({
        text: "Yes",
        relayedBy: "agent-1",
        relayedAt: "2026-10-26T10:00:00.000Z",
      }).success
    ).toBe(true);
    expect(
      QuestionClosedSchema.safeParse({ reason: "expired", at: "t" }).success
    ).toBe(false);
  });
});

describe("questionDisposition — each row names the rule it rules out", () => {
  const relayed = { via: "relayed" as const, relayedBy: "a" };
  const pending = { relayedBy: "a" };
  it.each([
    ["nothing", {}, "open"],
    ["an old answer (no via)", { answer: {} }, "answered"],
    ["a tap", { answer: { via: "tap" as const } }, "answered"],
    ["a routine relay", { answer: relayed }, "relayed"],
    // a confirm writes via:'tap' — reading confirmedAt alone would miss it
    [
      "a confirmed relay",
      { answer: { ...relayed, via: "tap" as const, confirmedAt: "t" } },
      "answered",
    ],
    [
      "a commitment relay awaiting the tap",
      { pendingRelay: pending },
      "awaiting_your_tap",
    ],
    // a session that ended over a pending relay closes it
    [
      "pending relay, then the session ended",
      { pendingRelay: pending, closed: { reason: "session_ended" as const } },
      "closed_session_ended",
    ],
    ["withdrawn", { closed: { reason: "withdrawn" as const } }, "withdrawn"],
    // the person's answer outranks a later closure
    [
      "answered, then closed",
      { answer: {}, closed: { reason: "session_ended" as const } },
      "answered",
    ],
  ] as const)("%s", (_n, input, want) => {
    expect(questionDisposition(input)).toBe(want);
  });
});
