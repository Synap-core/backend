/**
 * The pure halves of REFUSE (plan d717d6ac §3), each row naming the rival it
 * rules out:
 *   - `criterionMetBy`: a refused act / provide task under a person-checked
 *     criterion must NOT grade it pass (rival: "an answered deed meets it").
 *   - `paramValueFromAnswer`: a refusal writes no param, not even on a
 *     credential-named param that refuses every other answer (rival: "the
 *     credential check runs first").
 *   - `stampUnblocked({ keepBlocker })`: the refusal's hand-back keeps a
 *     blocker the answer would clear (rival: "every hand-back clears it").
 *   - the re-ask guard (`isIdenticalReaskOfDecline`, `declinedReaskLabels`):
 *     refuses ONLY the identical ask, ONLY while the refusal stands, on the
 *     slot's effective ask (an ask-less decision slot's derived confirm).
 */
import { describe, expect, it } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  askFingerprint,
  effectiveSlotAsk,
  type Ask,
} from "@synap-core/types/ask";
import { criterionMetBy } from "../satisfy-expected-output.js";
import { paramOwedSlots, paramValueFromAnswer } from "../param-slots.js";
import { stampUnblocked } from "../block-output.js";
import {
  declinedReaskError,
  isIdenticalReaskOfDecline,
} from "../declined-reask.js";
import { declinedReaskLabels } from "../update-session.js";

const DECLINED = { type: "declined" as const, reason: "not this one" };

describe("a refusal meets no criterion", () => {
  const criteria = [
    { key: "contract-signed", check: { kind: "human" as const } },
  ];
  const task = (mode: "act" | "provide") =>
    ({
      key: "contract-signed",
      kind: "task",
      label: "Sign the contract",
      owner: "human",
      blockedReason: "physical",
      ask:
        mode === "act"
          ? { mode: "act", steps: ["Sign it"] }
          : { mode: "provide", provide: { kind: "file" } },
    }) as unknown as ExpectedOutput;

  for (const mode of ["act", "provide"] as const) {
    it(`${mode}: met by the deed, never by its refusal`, () => {
      expect(criterionMetBy([task(mode)], 0, criteria)).toBe("contract-signed");
      expect(criterionMetBy([task(mode)], 0, criteria, DECLINED)).toBeNull();
    });
  }
});

describe("a refusal writes no run param", () => {
  const param = (name: string) =>
    paramOwedSlots(
      [{ name, type: "text", required: true } as never],
      "Deploy",
      "2026-11-16T00:00:00.000Z"
    )[0]!;

  it("an ordinary param: none, where an answer in words writes the value", () => {
    expect(
      paramValueFromAnswer(param("topic"), { type: "text" }, "AI")
    ).toMatchObject({
      status: "value",
      value: "AI",
    });
    expect(paramValueFromAnswer(param("topic"), DECLINED, "Refused")).toEqual({
      status: "none",
    });
  });

  it("a credential-named param: none, never refused (the person may always say no)", () => {
    expect(
      paramValueFromAnswer(param("api_token"), { type: "text" }, "sk_live_1")
        .status
    ).toBe("invalid");
    expect(
      paramValueFromAnswer(param("api_token"), DECLINED, "Refused")
    ).toEqual({
      status: "none",
    });
  });
});

describe("the refusal's hand-back keeps the blocker", () => {
  const slot = {
    kind: "document",
    label: "Token",
    owner: "human",
    blockedReason: "credential",
    why: "CI needs it",
    ask: { mode: "confirm" },
    blocks: { to: "fixing" },
    blockerKey: "no_token",
    clearedBy: { answer: true },
  } as unknown as ExpectedOutput;

  it("an answer's hand-back clears it; a refusal's keeps it", () => {
    const [cleared] = stampUnblocked([slot], "Token");
    expect(cleared).not.toHaveProperty("blocks");
    const [kept] = stampUnblocked([slot], "Token", { keepBlocker: true });
    expect(kept).toMatchObject({
      blocks: { to: "fixing" },
      blockerKey: "no_token",
      clearedBy: { answer: true },
    });
    // The person's turn still ends: ownership and the ask go either way.
    expect(kept).not.toHaveProperty("owner");
    expect(kept).not.toHaveProperty("ask");
  });
});

describe("the re-ask guard", () => {
  const ASK = {
    mode: "choose",
    options: [{ label: "EU" }, { label: "US" }],
  } as Ask;
  const refusedSlot = (
    ask: Ask | null,
    extra: Record<string, unknown> = {}
  ) => ({
    kind: "decision",
    label: "Stripe account",
    ...extra,
    answer: {
      text: "Refused",
      value: DECLINED,
      askFingerprint: askFingerprint(ask),
    },
  });
  const reask = (ask: Ask | null, extra: Record<string, unknown> = {}) => ({
    kind: "decision",
    label: "Stripe account",
    owner: "human",
    blockedReason: "decision",
    ...(ask ? { ask } : {}),
    ...extra,
  });

  it("refuses the identical ask while the refusal stands", () => {
    expect(isIdenticalReaskOfDecline(refusedSlot(ASK), reask(ASK))).toBe(true);
  });

  it("lets a changed ask through", () => {
    const changed = {
      ...ASK,
      options: [{ label: "EU" }, { label: "UK" }],
    } as Ask;
    expect(isIdenticalReaskOfDecline(refusedSlot(ASK), reask(changed))).toBe(
      false
    );
  });

  it("only while the refusal stands: not on a slot still the person's, nor on any other answer", () => {
    expect(
      isIdenticalReaskOfDecline(
        refusedSlot(ASK, { owner: "human" }),
        reask(ASK)
      )
    ).toBe(false);
    expect(
      isIdenticalReaskOfDecline(
        {
          ...refusedSlot(ASK),
          answer: {
            text: "EU",
            value: { type: "chip" },
            askFingerprint: askFingerprint(ASK),
          },
        },
        reask(ASK)
      )
    ).toBe(false);
    // A refusal recorded with no fingerprint (never stamped) cannot be matched.
    expect(
      isIdenticalReaskOfDecline(
        { ...refusedSlot(ASK), answer: { text: "Refused", value: DECLINED } },
        reask(ASK)
      )
    ).toBe(false);
    // Not a hand-over to the person at all.
    expect(
      isIdenticalReaskOfDecline(refusedSlot(ASK), {
        ...reask(ASK),
        owner: undefined,
      })
    ).toBe(false);
  });

  it("reads the EFFECTIVE ask: an ask-less decision slot asks its derived confirm", () => {
    const derived = effectiveSlotAsk(reask(null)) as Ask;
    expect(derived?.mode).toBe("confirm");
    expect(isIdenticalReaskOfDecline(refusedSlot(derived), reask(null))).toBe(
      true
    );
  });

  it("the wholesale patch: names the identical re-ask, passes a changed one and an echo", () => {
    const stored = [refusedSlot(ASK)] as unknown as ExpectedOutput[];
    expect(
      declinedReaskLabels(stored, [reask(ASK) as unknown as ExpectedOutput])
    ).toEqual(["Stripe account"]);
    expect(
      declinedReaskLabels(stored, [
        reask({
          ...ASK,
          options: [{ label: "UK" }],
        } as Ask) as unknown as ExpectedOutput,
      ])
    ).toEqual([]);
    // The agent echoing the slot back as it stands is not a re-ask.
    expect(declinedReaskLabels(stored, stored)).toEqual([]);
    expect(declinedReaskError(["Stripe account"])).toMatch(
      /^Refused: "Stripe account": The person refused this exact ask/
    );
  });
});
