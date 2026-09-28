import { describe, expect, it } from "vitest";
import { askFingerprint, AskSchema, type Ask } from "../ask/index.js";
import {
  PUSH_CATEGORIES,
  PUSH_CATEGORY_POLICY,
  PUSH_QUICK_ANSWER_CATEGORIES,
  PUSH_TYPE_RULES,
  blockingAskTarget,
  classifyPush,
  effectivePushCategories,
  isPushCategoryEnabled,
  morningBriefAt,
  morningBriefBody,
  normalizePushPrefs,
  pushEnvelope,
  quickAnswerFor,
} from "./index.js";

const slot = { sessionId: "s-1", label: "Tone" };
const ask = (a: unknown): Ask => AskSchema.parse(a);

describe("classifyPush", () => {
  it("a proposal pushes ONLY when it blocks an open session", () => {
    expect(classifyPush("proposal.created")).toBeNull();
    expect(
      classifyPush("proposal.created", { proposalBlocksOpenSession: false })
    ).toBeNull();
    expect(
      classifyPush("proposal.created", { proposalBlocksOpenSession: true })
    ).toBe("decision-blocking");
  });

  it("a blocking ask is its own category", () => {
    expect(classifyPush("session.needs_you")).toBe("blocking-ask");
  });

  it("an unknown type never pushes", () => {
    expect(classifyPush("brand.new_type")).toBeNull();
    // prototype keys are not rules
    expect(classifyPush("toString")).toBeNull();
    expect(classifyPush("__proto__")).toBeNull();
  });

  it("named NO rows stay quiet", () => {
    for (const t of ["connector.sync.failed", "inbox.mention", "chat.room_member_added"]) {
      expect(PUSH_TYPE_RULES).toHaveProperty([t], null);
      expect(classifyPush(t)).toBeNull();
    }
  });

  it("every rule names a real category (or the proposal rule, or null)", () => {
    for (const rule of Object.values(PUSH_TYPE_RULES)) {
      if (rule === null || rule === "blocking-proposal") continue;
      expect(PUSH_CATEGORIES).toContain(rule);
    }
  });
});

describe("preferences", () => {
  it("unset reads as the default, never as off", () => {
    expect(isPushCategoryEnabled(null, "blocking-ask")).toBe(true);
    expect(isPushCategoryEnabled({}, "system")).toBe(false);
    expect(isPushCategoryEnabled({ categories: { system: true } }, "system")).toBe(true);
    expect(
      isPushCategoryEnabled({ categories: { "blocking-ask": false } }, "blocking-ask")
    ).toBe(false);
  });

  it("normalize drops unknown categories, non-booleans and bad clocks", () => {
    expect(
      normalizePushPrefs({
        categories: { "blocking-ask": false, nope: true, system: "yes" },
        morningBriefAt: "25:00",
      })
    ).toEqual({ categories: { "blocking-ask": false } });
    expect(normalizePushPrefs({ morningBriefAt: "07:30" })).toEqual({
      morningBriefAt: "07:30",
    });
    expect(normalizePushPrefs("garbage")).toEqual({});
    expect(normalizePushPrefs(null)).toEqual({});
  });

  it("effective list covers every category and marks explicit ones", () => {
    const list = effectivePushCategories({ categories: { mention: false } });
    expect(list.map((c) => c.category)).toEqual([...PUSH_CATEGORIES]);
    const mention = list.find((c) => c.category === "mention")!;
    expect(mention).toMatchObject({ enabled: false, explicit: true });
    expect(list.find((c) => c.category === "blocking-ask")).toMatchObject({
      enabled: true,
      explicit: false,
    });
  });

  it("brief time defaults to 08:00", () => {
    expect(morningBriefAt(null)).toBe("08:00");
    expect(morningBriefAt({ morningBriefAt: "06:45" })).toBe("06:45");
  });
});

describe("targets", () => {
  it("one slot lands on the ask; none or many land on the session", () => {
    expect(blockingAskTarget("s-1", ["Tone"])).toEqual({
      kind: "owed",
      id: "s-1",
      slot: "Tone",
    });
    expect(blockingAskTarget("s-1", [])).toEqual({ kind: "session", id: "s-1" });
    expect(blockingAskTarget("s-1", ["A", "B"])).toEqual({
      kind: "session",
      id: "s-1",
    });
  });
});

describe("quickAnswerFor", () => {
  it("confirm → Yes / No, bound to the ask's fingerprint", () => {
    const a = ask({ mode: "confirm", prompt: "Include < 10 people?" });
    const q = quickAnswerFor(slot, a)!;
    expect(q.category).toBe("ask-confirm");
    expect(q.door).toBe("answer");
    expect(q.askFingerprint).toBe(askFingerprint(a));
    expect(q.actions).toEqual([
      { id: "yes", value: { type: "confirm", confirmed: true } },
      { id: "no", value: { type: "confirm", confirmed: false } },
    ]);
  });

  it("choose with one recommended of ≤ 3 → Use recommended", () => {
    const a = ask({
      mode: "choose",
      options: [
        { label: "Casual", value: "casual", recommended: true },
        { label: "Formal", value: "formal" },
      ],
    });
    const q = quickAnswerFor(slot, a)!;
    expect(q.category).toBe("ask-choose-recommended");
    expect(q.actions[0]!.value).toEqual({
      type: "chip",
      chip: { label: "Casual", value: "casual", recommended: true },
    });
  });

  it("choose WITHOUT a recommendation, with Other…, or with > 3 options opens", () => {
    expect(
      quickAnswerFor(
        slot,
        ask({ mode: "choose", options: [{ label: "A" }, { label: "B" }] })
      )
    ).toBeNull();
    expect(
      quickAnswerFor(
        slot,
        ask({
          mode: "choose",
          allowOther: true,
          options: [{ label: "A", recommended: true }, { label: "B" }],
        })
      )
    ).toBeNull();
    expect(
      quickAnswerFor(
        slot,
        ask({
          mode: "choose",
          options: [
            { label: "A", recommended: true },
            { label: "B" },
            { label: "C" },
            { label: "D" },
          ],
        })
      )
    ).toBeNull();
  });

  it("act → I did it, through the attest door", () => {
    const q = quickAnswerFor(slot, ask({ mode: "act", steps: ["Rotate key"] }))!;
    expect(q).toMatchObject({ category: "ask-act", door: "attest" });
    expect(q.actions).toEqual([{ id: "done" }]);
  });

  it("form, provide and no ask need a screen", () => {
    expect(quickAnswerFor(slot, null)).toBeNull();
    expect(
      quickAnswerFor(
        slot,
        ask({
          mode: "form",
          form: { fields: [{ key: "n", label: "Name", type: "text" }] },
        })
      )
    ).toBeNull();
    expect(
      quickAnswerFor(
        slot,
        ask({ mode: "provide", provide: { kind: "secret", name: "STRIPE" } })
      )
    ).toBeNull();
  });

  it("every action id a quick answer emits is registered in its OS category", () => {
    const asks = [
      ask({ mode: "confirm" }),
      ask({ mode: "choose", options: [{ label: "A", recommended: true }] }),
      ask({ mode: "act" }),
    ];
    for (const a of asks) {
      const q = quickAnswerFor(slot, a)!;
      const registered = PUSH_QUICK_ANSWER_CATEGORIES[q.category].map((x) => x.id);
      for (const action of q.actions) expect(registered).toContain(action.id);
    }
  });
});

describe("envelope + brief", () => {
  it("a blocking ask is time-sensitive, threaded and carries its OS category", () => {
    const q = quickAnswerFor(slot, ask({ mode: "confirm" }));
    expect(pushEnvelope("blocking-ask", { threadId: "s-1", quickAnswer: q })).toEqual({
      interruptionLevel: "time-sensitive",
      sound: "default",
      threadId: "s-1",
      categoryId: "ask-confirm",
    });
  });

  it("a passive category makes no sound", () => {
    expect(pushEnvelope("morning-brief").sound).toBeNull();
    expect(PUSH_CATEGORY_POLICY["morning-brief"].level).toBe("passive");
  });

  it("brief body", () => {
    expect(morningBriefBody({ needsYou: 3, landed: 4 })).toBe(
      "3 need you · 4 landed overnight"
    );
    expect(morningBriefBody({ needsYou: 1, landed: 0 })).toBe("1 needs you");
    expect(morningBriefBody({ needsYou: 0, landed: 0 })).toBeNull();
  });
});
