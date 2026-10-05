import { describe, it, expect } from "vitest";
import { projectSessionOutcomes } from "@synap-core/types/units";
import type { ExpectedOutput, SessionCriterion } from "@synap/playbooks";
import {
  outcomeDeclarationsSchema,
  splitOutcomes,
  upsertOutcomes,
  mergeOutcomesForStart,
} from "../outcome-declarations.js";
import { mergeExpectedOutputs } from "../update-session.js";

/**
 * `outcomes[]` (A4) is an ALIAS over today's storage. The test that matters
 * is the ROUND TRIP: what an agent declares as outcomes is what the read-time
 * projection reads back as outcomes — same keys, same verify, one outcome per
 * declaration (never a slot AND a criterion shown twice).
 */
describe("outcomes → storage → projection (round trip)", () => {
  const declared = outcomeDeclarationsSchema.parse([
    { key: "audit", label: "Current-state audit", kind: "document" },
    {
      label: "Typecheck passes",
      kind: "fact",
      verify: { kind: "capability", capability: "code.typecheck" },
    },
    {
      key: "plan",
      label: "Wave plan",
      kind: "document",
      verify: { kind: "judge", hint: "reuse-first" },
    },
    {
      label: "Founder approval",
      kind: "decision",
      owner: "human",
      blockedReason: "decision",
      why: "Only the founder decides",
    },
  ]);
  const { expectedOutputs, criteria } = splitOutcomes(declared);

  it("a fact is a criterion only; a deliverable is a slot; verify beyond evidence adds a criterion under the SAME key", () => {
    expect(expectedOutputs.map((s) => s.key)).toEqual([
      "audit",
      "plan",
      "founder-approval",
    ]);
    expect(criteria.map((c) => [c.key, c.check.kind])).toEqual([
      ["typecheck-passes", "capability"],
      ["plan", "judge"],
    ]);
  });

  it("the projection reads back exactly the declared outcomes, with their verify", () => {
    const view = projectSessionOutcomes({
      // Through the merge a create/update door runs, so declared keys survive.
      expectedOutputs: mergeExpectedOutputs([], expectedOutputs),
      criteria,
      sessionTerminal: false,
    });
    expect(view.outcomes.map((o) => [o.key, o.verify, o.source])).toEqual([
      ["audit", "evidence", "slot"],
      ["plan", "judge", "slot+criterion"],
      ["founder-approval", "human", "slot"],
      ["typecheck-passes", "capability", "criterion"],
    ]);
    // The person's blocked deliverable ALSO shows as an input pointing at it.
    expect(view.inputs.map((i) => [i.key, i.blocksOutcomeKey])).toEqual([
      ["founder-approval", "founder-approval"],
    ]);
  });
});

describe("update: outcomes UPSERT by key", () => {
  const stored: ExpectedOutput[] = [
    {
      kind: "document",
      label: "Audit v1",
      key: "audit",
      status: "done",
      satisfiedByProposalId: "p-1",
    },
    { kind: "document", label: "Notes", key: "notes" },
  ];
  const criteria: SessionCriterion[] = [
    { key: "fast", statement: "It is fast", check: { kind: "judge" } },
  ];

  it("renames by key, keeps every receipt, appends the new, removes nothing", () => {
    const next = upsertOutcomes(
      { expectedOutputs: stored, criteria },
      outcomeDeclarationsSchema.parse([
        { key: "audit", label: "Audit (final)", kind: "document" },
        { label: "Deck", kind: "artifact" },
        { key: "fast", label: "It is fast (p95 < 200ms)", kind: "fact" },
      ])
    );
    expect(next.expectedOutputs).toEqual([
      { ...stored[0], label: "Audit (final)" },
      stored[1],
      { kind: "artifact", label: "Deck", key: "deck" },
    ]);
    expect(next.criteria).toEqual([
      {
        key: "fast",
        statement: "It is fast (p95 < 200ms)",
        check: { kind: "judge" },
      },
    ]);
    // …and the merge the write runs sees a round-trip, not a forgery.
    expect(() =>
      mergeExpectedOutputs(stored, next.expectedOutputs)
    ).not.toThrow();
  });

  it("start: aliases first, outcomes appended", () => {
    const out = mergeOutcomesForStart({
      outcomes: outcomeDeclarationsSchema.parse([
        { label: "Deck", kind: "artifact" },
      ]),
      expectedOutputs: [{ kind: "document", label: "Notes" }],
    });
    expect(out.expectedOutputs?.map((s) => s.label)).toEqual(["Notes", "Deck"]);
    expect(out).not.toHaveProperty("criteria");
  });

  it("refuses a malformed key and an unknown field (strict)", () => {
    expect(
      outcomeDeclarationsSchema.safeParse([{ label: "X", key: "Not A Slug" }])
        .success
    ).toBe(false);
    expect(
      outcomeDeclarationsSchema.safeParse([{ label: "X", status: "done" }])
        .success
    ).toBe(false);
  });
});
