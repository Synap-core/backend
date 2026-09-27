/**
 * THE ASK ON A SLOT — how a person can answer a blocker (confirm / choose /
 * form / act / provide), carried end to end.
 *
 * `ExpectedOutput.ask` is AGENT-DECLARED (client-declarable, like `ref`), parsed
 * with the ONE schema in `@synap-core/types/ask`, and must survive every door
 * that touches a slot: the wire, the wholesale merge (silence KEEPS, `null`
 * CLEARS), `addOutput`, the targeted block door, the owed read and the needs-you
 * signal a tray renders. And it must LEAVE with the hand-back
 * (`stampUnblocked`): once the slot is the agent's there is nothing left for
 * the person to answer.
 *
 * The owed read also now carries `ref` — before this, a tray could name a
 * blocker but not open the page the agent pointed at without re-reading the
 * whole session.
 *
 * Pure functions only.
 */
import { describe, it, expect } from "vitest";
import type { ExpectedOutput, SlotAsk } from "@synap/playbooks";
import { stampBlocked, stampUnblocked } from "../block-output.js";
import {
  addOutputWireSchema,
  applyOutputMutations,
  CLIENT_DECLARABLE_OUTPUT_FIELDS,
  expectedOutputWireSchema,
  mergeExpectedOutputs,
  sanitizeDeclaredOutputs,
} from "../update-session.js";
import { projectOwedSlots } from "../owed-outputs.js";
import { signalFromOwedSlot } from "../../signals/needs-you-union.js";

const AT = new Date("2026-09-08T09:00:00.000Z");
const CHOOSE: SlotAsk = {
  mode: "choose",
  options: [
    { label: "EU account", value: "eu", recommended: true },
    { label: "US account", value: "us" },
  ],
};
const REF = { url: "https://dashboard.stripe.com/apikeys" };

const blockedSlot = (over: Partial<ExpectedOutput> = {}): ExpectedOutput => ({
  kind: "entity",
  label: "Stripe key",
  owner: "human",
  blockedReason: "decision",
  why: "Which Stripe account?",
  owedSince: AT.toISOString(),
  ref: REF,
  ask: CHOOSE,
  ...over,
});

describe("the wire parses `ask` with the ONE ask schema", () => {
  it("accepts a well-formed ask and a null (CLEAR)", () => {
    expect(
      expectedOutputWireSchema.parse({ kind: "k", label: "l", ask: CHOOSE }).ask
    ).toEqual(CHOOSE);
    expect(
      expectedOutputWireSchema.parse({ kind: "k", label: "l", ask: null }).ask
    ).toBeNull();
  });

  it("refuses an unknown mode and a non-http act url", () => {
    expect(
      expectedOutputWireSchema.safeParse({
        kind: "k",
        label: "l",
        ask: { mode: "grade" },
      }).success
    ).toBe(false);
    expect(
      expectedOutputWireSchema.safeParse({
        kind: "k",
        label: "l",
        ask: { mode: "act", url: "javascript:alert(1)" },
      }).success
    ).toBe(false);
  });

  it("drops an AI-authored credential field from a form ask at the parse", () => {
    const parsed = expectedOutputWireSchema.parse({
      kind: "k",
      label: "l",
      ask: {
        mode: "form",
        form: {
          fields: [
            { key: "account", label: "Account", type: "text" },
            { key: "key", label: "API key", type: "api_key" },
          ],
        },
      },
    });
    expect(
      parsed.ask?.mode === "form" && parsed.ask.form.fields.map((f) => f.key)
    ).toEqual(["account"]);
  });
});

describe("addOutputWireSchema is DERIVED from the declarable fields", () => {
  it("has exactly the client-declarable keys — `ref` and `ask` included", () => {
    expect(Object.keys(addOutputWireSchema.shape).sort()).toEqual(
      [...CLIENT_DECLARABLE_OUTPUT_FIELDS].sort()
    );
    expect(Object.keys(addOutputWireSchema.shape)).toEqual(
      expect.arrayContaining(["ref", "ask"])
    );
  });

  it("strips every server-stamped field", () => {
    const parsed = addOutputWireSchema.parse({
      kind: "k",
      label: "l",
      status: "done",
      attestedBy: "someone",
      ask: { mode: "confirm" },
    });
    expect(parsed).toEqual({ kind: "k", label: "l", ask: { mode: "confirm" } });
  });
});

describe("the wholesale merge — silence KEEPS, null CLEARS", () => {
  it("keeps a stored ask when a naive patch is silent about it", () => {
    const [merged] = mergeExpectedOutputs(
      [blockedSlot()],
      [{ kind: "entity", label: "Stripe key" }]
    );
    expect(merged!.ask).toEqual(CHOOSE);
  });

  it("clears it on an explicit null, leaving no null in storage", () => {
    const [merged] = mergeExpectedOutputs(
      [blockedSlot()],
      [{ kind: "entity", label: "Stripe key", ask: null }]
    );
    expect(merged).not.toHaveProperty("ask");
    // The ref, which the patch was silent about, stays.
    expect(merged!.ref).toEqual(REF);
  });

  it("replaces it when the patch states a new one", () => {
    const [merged] = mergeExpectedOutputs(
      [blockedSlot()],
      [{ kind: "entity", label: "Stripe key", ask: { mode: "confirm" } }]
    );
    expect(merged!.ask).toEqual({ mode: "confirm" });
  });

  it("stores no null ask or ref on a slot declared at birth", () => {
    const [born] = sanitizeDeclaredOutputs(
      [{ kind: "k", label: "l", ask: null, ref: null }],
      AT
    );
    expect(born).not.toHaveProperty("ask");
    expect(born).not.toHaveProperty("ref");
  });
});

describe("addOutput carries the ask", () => {
  it("appends a blocked slot with its ask in one call", () => {
    const { outputs } = applyOutputMutations([], {
      addOutput: {
        kind: "entity",
        label: "Stripe key",
        owner: "human",
        blockedReason: "decision",
        ask: CHOOSE,
      },
    });
    expect(outputs[0]!.ask).toEqual(CHOOSE);
  });
});

describe("the block door and the hand-back", () => {
  it("stampBlocked sets, keeps and clears the ask like ref", () => {
    const base: ExpectedOutput[] = [{ kind: "entity", label: "Stripe key" }];
    const [set] = stampBlocked(
      base,
      "Stripe key",
      "decision",
      null,
      AT,
      undefined,
      CHOOSE
    );
    expect(set!.ask).toEqual(CHOOSE);
    const [kept] = stampBlocked([set!], "Stripe key", "decision", null, AT);
    expect(kept!.ask).toEqual(CHOOSE);
    const [cleared] = stampBlocked(
      [set!],
      "Stripe key",
      "decision",
      null,
      AT,
      undefined,
      null
    );
    expect(cleared).not.toHaveProperty("ask");
  });

  it("stampUnblocked removes the ask with the ownership fields and KEEPS the ref", () => {
    const [back] = stampUnblocked([blockedSlot()], "Stripe key");
    expect(back).not.toHaveProperty("ask");
    expect(back).not.toHaveProperty("owner");
    expect(back!.ref).toEqual(REF);
  });
});

describe("the owed read and the needs-you signal carry ref + ask", () => {
  const row = {
    id: "sess-1",
    goal: "Take payments",
    status: "active",
    workspaceId: null,
    projectId: null,
    expectedOutputs: [blockedSlot()],
  };

  it("projectOwedSlots carries the pointer and the ask", () => {
    const [owed] = projectOwedSlots(row);
    expect(owed!.ref).toEqual(REF);
    expect(owed!.ask).toEqual(CHOOSE);
  });

  it("omits both when the slot declared neither", () => {
    const [owed] = projectOwedSlots({
      ...row,
      expectedOutputs: [blockedSlot({ ref: undefined, ask: undefined })],
    });
    expect(owed).not.toHaveProperty("ref");
    expect(owed).not.toHaveProperty("ask");
  });

  it("signalFromOwedSlot projects them as slotRef + ask (from the REAL owed row)", () => {
    const [owed] = projectOwedSlots(row);
    const signal = signalFromOwedSlot(owed!);
    expect(signal.slotRef).toEqual(REF);
    expect(signal.ask).toEqual(CHOOSE);
    // `target` stays the signal's own door — the session.
    expect(signal.target).toEqual({ kind: "session", id: "sess-1" });
  });
});
