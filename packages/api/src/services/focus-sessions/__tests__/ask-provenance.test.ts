/**
 * WHO asked — `askedBy` / `askCause` are SERVER-STAMPED by the door that hands
 * a slot to the person, carried while it is owed, dropped with the ownership,
 * and never authored by a client (Resolve-XP W6a, founder decision 4:
 * "Never 'An agent'"). Pure: the stamp, the real mutation door, the merge.
 */
import { describe, it, expect } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import { stampAskProvenance } from "../slot-asked-event.js";
import { stampBlocked, stampUnblocked } from "../block-output.js";
import {
  applyOutputMutations,
  mergeExpectedOutputs,
  reconcileOwedSince,
} from "../update-session.js";

const AGENT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

const agentSlot: ExpectedOutput = { kind: "doc", label: "Stripe key" };
const owedBy = (askedBy: string): ExpectedOutput => ({
  kind: "doc",
  label: "Stripe key",
  owner: "human",
  blockedReason: "credential",
  owedSince: "2026-10-20T00:00:00.000Z",
  ask: { mode: "confirm", prompt: "Use the live key?" },
  askedBy,
});

describe("stampAskProvenance — the one stamp", () => {
  it("stamps the acting agent on a slot this write newly handed over", () => {
    const after = stampBlocked([agentSlot], "Stripe key", "credential");
    const [s] = stampAskProvenance([agentSlot], after, { askedBy: AGENT });
    expect(s!.askedBy).toBe(AGENT);
  });

  it("a re-ask by ANOTHER agent re-stamps; an unchanged owed slot keeps its asker", () => {
    const stored = owedBy(AGENT);
    const [kept] = stampAskProvenance([stored], [{ ...stored }], {
      askedBy: OTHER,
    });
    expect(kept!.askedBy).toBe(AGENT);
    const reasked = { ...stored, ask: { mode: "confirm" as const } };
    const [moved] = stampAskProvenance([stored], [reasked], { askedBy: OTHER });
    expect(moved!.askedBy).toBe(OTHER);
  });

  it("the person handing it to themselves names NOBODY (an old asker never rides)", () => {
    const stored = { ...owedBy(AGENT), owner: "agent" as const };
    const after = stampBlocked([stored], "Stripe key", "decision");
    const [s] = stampAskProvenance([stored], after, {});
    expect(s!.askedBy).toBeUndefined();
  });

  it("a system producer names its cause", () => {
    const after = stampBlocked([agentSlot], "Stripe key", "decision");
    const cause = { kind: "decision" as const, ref: { kind: "entity", id: "d" } };
    const [s] = stampAskProvenance([agentSlot], after, { askCause: cause });
    expect(s!.askCause).toEqual(cause);
    expect(s!.askedBy).toBeUndefined();
  });
});

describe("the doors stamp it (reachability, not shape)", () => {
  it("applyOutputMutations — an agent's addOutput owed from birth", () => {
    const { outputs } = applyOutputMutations(
      [],
      {
        addOutput: {
          kind: "doc",
          label: "Pick a tone",
          owner: "human",
          blockedReason: "decision",
          ask: { mode: "confirm" },
        },
      },
      { askedBy: AGENT }
    );
    expect(outputs[0]!.askedBy).toBe(AGENT);
  });

  it("applyOutputMutations — an agent's wholesale patch handing a slot over", () => {
    const { outputs } = applyOutputMutations(
      [agentSlot],
      {
        expectedOutputs: [
          { ...agentSlot, owner: "human", blockedReason: "credential" },
        ],
      },
      { keepUnlisted: true, askedBy: AGENT }
    );
    expect(outputs[0]!.askedBy).toBe(AGENT);
  });

  it("the person's own patch on an owed slot keeps the agent that asked it", () => {
    const stored = owedBy(AGENT);
    const { outputs } = applyOutputMutations([stored], {
      expectedOutputs: [{ kind: "doc", label: "Stripe key", owner: "human" }],
    });
    expect(outputs[0]!.askedBy).toBe(AGENT);
  });
});

describe("authority and lifetime", () => {
  it("a client cannot author or change it — refused like every receipt", () => {
    expect(() =>
      mergeExpectedOutputs(
        [owedBy(AGENT)],
        [{ ...owedBy(AGENT), askedBy: OTHER }]
      )
    ).toThrow(/server-stamped/i);
    // On a slot being born it is dropped, never believed.
    const [born] = mergeExpectedOutputs(
      [],
      [{ ...owedBy(OTHER), label: "Fresh" }]
    );
    expect(born!.askedBy).toBeUndefined();
  });

  it("it goes with the ownership: unblock, hand back, reconcile", () => {
    expect(stampUnblocked([owedBy(AGENT)], "Stripe key")[0]!.askedBy)
      .toBeUndefined();
    const withCause = {
      ...owedBy(AGENT),
      askCause: { kind: "run" as const },
    };
    const back = reconcileOwedSince({ ...withCause, owner: "agent" });
    expect(back.askedBy).toBeUndefined();
    expect(back.askCause).toBeUndefined();
  });
});
