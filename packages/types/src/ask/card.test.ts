import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ASK_CHANGED_PREFIX,
  ASK_COPY,
  ASK_INVALID_PREFIX,
  AskSchema,
  SLOT_MOVED_ON_PHRASES,
  actView,
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
    for (const s of strings) expect(s).not.toContain("—");
    expect(ASK_COPY.youAnswered("Yes")).toBe("You answered: Yes");
  });

  it("draftAsks: names the agent, the work, and pluralises the count", () => {
    expect(ASK_COPY.draftAsks("Claude Code", "Ship billing", 1)).toBe(
      "Claude Code started Ship billing · asks you 1 thing"
    );
    expect(ASK_COPY.draftAsks("Claude Code", "Ship billing", 3)).toBe(
      "Claude Code started Ship billing · asks you 3 things"
    );
    // Unknown starter: a noun, never an empty subject or a uuid.
    expect(ASK_COPY.draftAsks(null, "Ship billing", 2)).toBe(
      "An agent started Ship billing · asks you 2 things"
    );
    expect(ASK_COPY.draftAsks("  ", "Ship billing", 2)).toMatch(/^An agent /);
  });
});
