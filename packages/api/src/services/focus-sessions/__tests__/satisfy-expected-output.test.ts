/**
 * The honest-deliverable rule, unit level.
 *
 * `status: "done"` on a focus session's expected output must mean "a human
 * approved a write that produced it" — not "the agent said so". These pin the
 * matching + stamping halves of the ONE door; the transaction around them is
 * plumbing, not logic.
 */
import { describe, it, expect } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  selectOutputToSatisfy,
  stampSatisfied,
  readProposalExpectedLabel,
} from "../satisfy-expected-output.js";

const outputs = (): ExpectedOutput[] => [
  { kind: "document", label: "Spec" },
  { kind: "entity", label: "Client record" },
  { kind: "document", label: "Summary" },
];

describe("selectOutputToSatisfy", () => {
  it("matches an approved proposal's targetType to the first pending output of that kind", () => {
    expect(selectOutputToSatisfy(outputs(), "document")).toBe(0);
    expect(selectOutputToSatisfy(outputs(), "entity")).toBe(1);
  });

  it("reuses the vocabulary normalization — no second mapping table", () => {
    // `focus_session` → `session` is an OBJECT_KIND_ALIASES irregular; plural
    // targetTypes depluralize. Both come from `normalizeObjectKind`.
    const list: ExpectedOutput[] = [
      { kind: "session", label: "Follow-up session" },
      { kind: "workspace", label: "New lens" },
    ];
    expect(selectOutputToSatisfy(list, "focus_session")).toBe(0);
    expect(selectOutputToSatisfy(list, "workspaces")).toBe(1);
  });

  it("skips outputs already satisfied — one approval is evidence for one deliverable", () => {
    const list = outputs();
    list[0] = { ...list[0]!, status: "done" };
    expect(selectOutputToSatisfy(list, "document")).toBe(2);
  });

  it("a CLAIM is not a satisfaction — claimedDone does not make an output skippable", () => {
    const list = outputs();
    list[0] = { ...list[0]!, claimedDone: true };
    expect(selectOutputToSatisfy(list, "document")).toBe(0);
  });

  it("returns -1 when no declared output matches the approved target", () => {
    expect(selectOutputToSatisfy(outputs(), "capability")).toBe(-1);
    expect(selectOutputToSatisfy([], "document")).toBe(-1);
  });

  it("an unknown/empty targetType falls back to `entity`, never to a wildcard match", () => {
    // normalizeObjectKind("") === "entity". It must NOT satisfy a document.
    expect(selectOutputToSatisfy(outputs(), null)).toBe(1);
    expect(
      selectOutputToSatisfy([{ kind: "document", label: "Spec" }], undefined)
    ).toBe(-1);
  });
});

describe("selectOutputToSatisfy — the SLOT CLAIM", () => {
  // The live defect this rung fixes: a session owing TWO documents. Approving a
  // draft meant for "Summary" stamped "Spec", because the kind guess returns the
  // first not-done output of the kind and nothing else was ever consulted.
  it("a claim picks the slot it names, not the first of the kind", () => {
    expect(selectOutputToSatisfy(outputs(), "document", "Summary")).toBe(2);
  });

  it("no claim ⇒ the kind guess, unchanged", () => {
    expect(selectOutputToSatisfy(outputs(), "document")).toBe(0);
    expect(selectOutputToSatisfy(outputs(), "document", null)).toBe(0);
    expect(selectOutputToSatisfy(outputs(), "document", "   ")).toBe(0);
  });

  it("matches trimmed and case-insensitively — one comparison on both sides", () => {
    expect(selectOutputToSatisfy(outputs(), "document", "  summary ")).toBe(2);
  });

  it("a claim naming an ALREADY-DONE slot falls back to the kind guess", () => {
    // Stale claim (the slot was satisfied by an earlier approval). The approval
    // is still evidence about this session, so it satisfies the next open slot
    // of the kind rather than stamping nothing.
    const list = outputs();
    list[2] = { ...list[2]!, status: "done" };
    expect(selectOutputToSatisfy(list, "document", "Summary")).toBe(0);
  });

  it("a claim naming no declared slot falls back to the kind guess", () => {
    expect(selectOutputToSatisfy(outputs(), "document", "Nope")).toBe(0);
  });

  it("the claim does NOT outrank the KIND — a labelled slot of another kind is dropped", () => {
    // REVERSED (2026-09-07). This previously returned 1: the claim was allowed
    // to stamp a slot whose declared kind disagreed with what was actually
    // produced, so an ENTITY named like the declared entity slot could satisfy
    // it from a DOCUMENT approval — a deliverable reported delivered that
    // nobody produced. The claim now decides WHICH slot among those the change
    // could satisfy; it never widens the set. Falls to the kind rung.
    expect(selectOutputToSatisfy(outputs(), "document", "Client record")).toBe(
      0
    );
  });

  it("a same-label slot of the WRONG kind never shadows the right one", () => {
    // Two slots share a label across kinds — the claim must land on the one the
    // approval could actually be evidence for.
    const list: ExpectedOutput[] = [
      { kind: "entity", label: "Summary" },
      { kind: "document", label: "Summary" },
    ];
    expect(selectOutputToSatisfy(list, "document", "Summary")).toBe(1);
    expect(selectOutputToSatisfy(list, "entity", "Summary")).toBe(0);
  });

  it("a claim matching nothing at all still returns -1", () => {
    expect(selectOutputToSatisfy(outputs(), "capability", "Nope")).toBe(-1);
  });
});

describe("readProposalExpectedLabel", () => {
  it("reads the TOP-LEVEL claim off a stored proposal payload", () => {
    expect(readProposalExpectedLabel({ expectedLabel: "Spec" })).toBe("Spec");
  });

  it("ignores a nested one — the gate payload is not where the claim lives", () => {
    expect(
      readProposalExpectedLabel({ data: { expectedLabel: "Spec" } })
    ).toBeUndefined();
  });

  it("is undefined for absent, blank, and non-object payloads", () => {
    expect(readProposalExpectedLabel(null)).toBeUndefined();
    expect(readProposalExpectedLabel(undefined)).toBeUndefined();
    expect(readProposalExpectedLabel("Spec")).toBeUndefined();
    expect(readProposalExpectedLabel({})).toBeUndefined();
    expect(readProposalExpectedLabel({ expectedLabel: "  " })).toBeUndefined();
    expect(readProposalExpectedLabel({ expectedLabel: 7 })).toBeUndefined();
  });
});

describe("stampSatisfied", () => {
  it("stamps status AND lineage, so the claim is falsifiable after the fact", () => {
    const next = stampSatisfied(outputs(), 1, "prop-1");
    expect(next[1]).toMatchObject({
      label: "Client record",
      status: "done",
      satisfiedByProposalId: "prop-1",
    });
  });

  it("leaves every other output untouched", () => {
    const next = stampSatisfied(outputs(), 1, "prop-1");
    expect(next[0]).toEqual({ kind: "document", label: "Spec" });
    expect(next[2]).toEqual({ kind: "document", label: "Summary" });
    expect(next).toHaveLength(3);
  });

  it("preserves an agent's own claim alongside the approval-backed stamp", () => {
    const list = outputs();
    list[0] = { ...list[0]!, claimedDone: true };
    const next = stampSatisfied(list, 0, "prop-2");
    expect(next[0]).toMatchObject({
      claimedDone: true,
      status: "done",
      satisfiedByProposalId: "prop-2",
    });
  });
});
