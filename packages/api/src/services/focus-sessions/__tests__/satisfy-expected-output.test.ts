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
