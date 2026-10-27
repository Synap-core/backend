import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ASK_CHANGED_PREFIX,
  ASK_COPY,
  ASK_INVALID_PREFIX,
  AskSchema,
  SLOT_MOVED_ON_PHRASES,
  actView,
  answerProvenanceMark,
  askOptionChips,
  askOptionForChip,
  askRowRegion,
  askSlotStanding,
  classifyAskRefusal,
  type Ask,
  type AskOptionChip,
} from "./index.js";
import type { CaptureFollowUpChip } from "../capture/index.js";

const ask = (a: unknown): Ask => AskSchema.parse(a);
const confirm = ask({ mode: "confirm" });
const smallChoose = ask({
  mode: "choose",
  options: [
    { label: "Friday", value: "fri", recommended: true },
    { label: "Later" },
  ],
});
const wideChoose = ask({
  mode: "choose",
  options: ["a", "b", "c", "d"].map((label) => ({ label })),
});
const form = ask({
  mode: "form",
  form: { fields: [{ key: "n", label: "N", type: "text" }] },
});
const act = ask({ mode: "act", url: "https://x.io/a", steps: ["one"] });
const provide = ask({
  mode: "provide",
  provide: { kind: "secret", name: "Stripe" },
});

describe("askSlotStanding — a table that rules out the previous relay reads", () => {
  // Each row names the old rule it rules out.
  it.each([
    // relay read the answer first ⇒ a RE-ASKED slot showed the old receipt
    [
      "re-asked after an answer",
      { owner: "human", status: "pending", answer: { text: "Yes" } },
      "owed",
    ],
    [
      "handed back with an answer",
      { owner: "agent", status: "pending", answer: { text: "Yes" } },
      "answered",
    ],
    // attest keeps owner:'human' AND status:'done' ⇒ must not read as owed
    [
      "attested",
      { owner: "human", status: "done", attestedAt: "t" },
      "attested",
    ],
    // browser read done ⇒ gone before the answer ⇒ an answered slot read "moved on"
    [
      "answered, then closed by the agent",
      { owner: "agent", status: "done", answer: { text: "Yes" } },
      "answered",
    ],
    [
      "retired, even with an answer",
      { owner: "agent", retiredAt: "t", answer: { text: "Yes" } },
      "gone",
    ],
    [
      "done by approval, nothing of theirs",
      { owner: "agent", status: "done" },
      "gone",
    ],
    [
      "whitespace answer is no receipt",
      { owner: "agent", answer: { text: "  " } },
      "gone",
    ],
    ["owed", { owner: "human", status: "pending" }, "owed"],
    ["missing", null, "gone"],
  ] as const)("%s", (_name, slot, want) => {
    expect(askSlotStanding(slot)).toBe(want);
  });
});

describe("classifyAskRefusal", () => {
  it.each([
    [`${ASK_CHANGED_PREFIX} The ask changed`, "ask_changed", "The ask changed"],
    [
      `${ASK_INVALID_PREFIX} Pick one of the offered options`,
      "failed",
      "Pick one of the offered options",
    ],
    [
      `Output "Key" ${SLOT_MOVED_ON_PHRASES.alreadyDone}`,
      "moved_on",
      `Output "Key" ${SLOT_MOVED_ON_PHRASES.alreadyDone}`,
    ],
    ["Network down", "failed", "Network down"],
    // a BARE code never reaches a person (the browser echoed it back)
    [ASK_CHANGED_PREFIX, "ask_changed", ASK_COPY.askChanged],
    [`${ASK_INVALID_PREFIX}  `, "failed", ASK_COPY.failedTitle],
    ["", "failed", ASK_COPY.failedTitle],
    [null, "failed", ASK_COPY.failedTitle],
  ] as const)("%j", (message, kind, text) => {
    const r = classifyAskRefusal(message);
    expect(r).toEqual({ kind, message: text });
    expect(r.message).not.toMatch(/ask_[a-z_]+:/);
  });
});

describe("askRowRegion", () => {
  it.each([
    [null, true, "legacy"],
    [act, true, "act"],
    [confirm, true, "inline"],
    [smallChoose, true, "inline"],
    [wideChoose, true, "detail"],
    [form, true, "detail"],
    // no inline runner wired ⇒ the door, never dead controls
    [confirm, false, "detail"],
    // relay drew "Answer…" on a provide that nothing can answer yet
    [provide, true, "none"],
    [provide, false, "none"],
  ] as const)("%# → %s", (a, canAnswer, want) => {
    expect(askRowRegion(a, { canAnswer })).toBe(want);
  });

  it("a provide opens its sheet only where the host declares that kind", () => {
    const connection = ask({
      mode: "provide",
      provide: { kind: "connection", service: "stripe" },
    });
    // An old client declares nothing: today's `none`, unchanged.
    expect(askRowRegion(provide, { canAnswer: true, canProvide: {} })).toBe(
      "none"
    );
    // Declaring ANOTHER kind does not open this one.
    expect(
      askRowRegion(provide, {
        canAnswer: true,
        canProvide: { connection: true, file: true },
      })
    ).toBe("none");
    expect(
      askRowRegion(provide, { canAnswer: false, canProvide: { secret: true } })
    ).toBe("detail");
    expect(
      askRowRegion(connection, {
        canAnswer: true,
        canProvide: { connection: true },
      })
    ).toBe("detail");
    // Opting in to provide changes nothing for the other modes.
    expect(
      askRowRegion(confirm, { canAnswer: true, canProvide: { secret: true } })
    ).toBe("inline");
  });
});

describe("options ↔ chips", () => {
  it("chips carry the pod's match key and round-trip to the OFFERED option", () => {
    const chips = askOptionChips(smallChoose);
    expect(chips.map((c) => c.value)).toEqual(["fri", "Later"]);
    expect(chips[0]).toMatchObject({ action: "confirm", recommended: true });
    expect(chips[1]).not.toHaveProperty("recommended");
    for (const [i, c] of chips.entries()) {
      expect(askOptionForChip(smallChoose, c)).toBe(
        smallChoose.mode === "choose" ? smallChoose.options[i] : null
      );
    }
    expect(askOptionForChip(smallChoose, { value: "Friday" })).toBeNull();
    expect(askOptionChips(confirm)).toEqual([]);
    expect(askOptionForChip(form, { value: "n" })).toBeNull();
  });

  it("a chip IS a capture follow-up chip (one choose renderer)", () => {
    expectTypeOf<AskOptionChip>().toMatchTypeOf<CaptureFollowUpChip>();
  });
});

describe("actView", () => {
  it("trims the url and the steps, drops blanks", () => {
    const v = actView({
      mode: "act",
      url: "  https://docusign.net/s/1 ",
      steps: [" Sign ", "   ", "Send"],
    });
    expect(v).toEqual({
      url: "https://docusign.net/s/1",
      host: "docusign.net",
      steps: ["Sign", "Send"],
    });
  });
  it("refuses a non-http scheme and non-act asks", () => {
    expect(
      actView({ mode: "act", url: "javascript:alert(1)" })?.url
    ).toBeNull();
    expect(actView({ mode: "act" })).toEqual({
      url: null,
      host: null,
      steps: [],
    });
    expect(actView(confirm)).toBeNull();
    expect(actView(null)).toBeNull();
  });
});

describe("ASK_COPY", () => {
  it("has no em dash in any visible string", () => {
    const strings = Object.values(ASK_COPY).map((v) =>
      typeof v === "function"
        ? (v as (...args: unknown[]) => string)("x", "y", 2)
        : v
    );
    expect(strings.length).toBeGreaterThan(10);
    // A builder with nothing to show returns null: nothing is drawn.
    for (const s of strings) if (s != null) expect(s).not.toContain("—");
    expect(ASK_COPY.youAnswered("Yes")).toBe("You answered: Yes");
  });

  it("draftStarted: names the agent and the work, never an ask count", () => {
    expect(ASK_COPY.draftStarted("Claude Code", "Ship billing")).toBe(
      "Claude Code started Ship billing"
    );
    // Unknown starter: a noun, never an empty subject or a uuid.
    expect(ASK_COPY.draftStarted(null, "Ship billing")).toBe(
      "An agent started Ship billing"
    );
    expect(ASK_COPY.draftStarted("  ", "Ship billing")).toMatch(/^An agent /);
  });

  it("provideUploadKept: names the space the file stays in", () => {
    expect(ASK_COPY.provideUploadKept("Finance")).toBe(
      "The file was saved in Finance, but it wasn't handed over."
    );
  });
});

describe("answerProvenanceMark", () => {
  it.each([
    ["open draws nothing", {}, null],
    ["a tap", { answer: {} }, { tone: "success", label: "You answered" }],
    [
      "a routine relay names the agent",
      { answer: { via: "relayed", relayedBy: "a" } },
      { tone: "ai", label: "Answered in chat · relayed by Claude Code" },
    ],
    [
      // the relay stays visible after the person's own tap
      "a confirmed relay still says it was relayed",
      { answer: { via: "tap", relayedBy: "a", confirmedAt: "t" } },
      { tone: "success", label: "You confirmed what Claude Code relayed" },
    ],
    [
      "awaiting the tap",
      { pendingRelay: { relayedBy: "a" } },
      {
        tone: "warning",
        label: "Claude Code relayed your answer. Confirm it.",
      },
    ],
    [
      "withdrawn with its reason",
      { closed: { reason: "withdrawn", note: "you answered it in the brief" } },
      { tone: "textMuted", label: "Withdrawn · you answered it in the brief" },
    ],
    [
      "withdrawn, no reason",
      { closed: { reason: "withdrawn" } },
      { tone: "textMuted", label: "Withdrawn" },
    ],
    [
      "closed by the session's end",
      { closed: { reason: "session_ended" } },
      { tone: "textMuted", label: "Closed · the session ended" },
    ],
  ] as const)("%s", (_n, input, want) => {
    expect(answerProvenanceMark(input, { agent: "Claude Code" })).toEqual(want);
  });

  it("never prints a blank agent name, nor invents 'an agent', and no visible em dash", () => {
    const mark = answerProvenanceMark({ answer: { via: "relayed" } });
    expect(mark?.label).toBe("Answered in chat · relayed");
    expect(
      answerProvenanceMark({ pendingRelay: { relayedBy: "a" } }, { agent: " " })
        ?.label
    ).toBe("Your answer was relayed. Confirm it.");
    expect(ASK_COPY.relayConfirmed(null)).toBe(
      "You confirmed the relayed answer"
    );
    for (const v of Object.values(ASK_COPY)) {
      const text =
        typeof v === "function" ? (v as (a: string) => string | null)("x") : v;
      if (text != null) expect(text).not.toContain("—");
    }
    expect(ASK_COPY.relayedWords({ quote: " yes go ", text: "Yes" })).toBe(
      "“yes go”"
    );
    expect(ASK_COPY.relayedWords({ text: "Yes" })).toBe("“Yes”");
    expect(ASK_COPY.relayedWords({ quote: " ", text: null })).toBeNull();
  });
});
