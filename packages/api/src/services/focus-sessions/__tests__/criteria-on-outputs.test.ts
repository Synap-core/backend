/**
 * Work-model W4: a criterion checks the output it NAMES (`outputKey`), never
 * the one it shares a key with. Every closer that leaves a checked slot to its
 * criterion's evaluator reads the one pairing (`checkedOutputKeys`). Each pair
 * of rows rules out the pre-W4 rival "a criterion of the same key checks the
 * slot": the same-key criterion with no `outputKey` must let the closer close
 * the slot, the one naming it must hold it.
 */
import { describe, expect, it } from "vitest";
import {
  checkedOutputKeys,
  projectSessionOutcomes,
  stampSlotKeys,
} from "@synap-core/types/units";
import { parsePullRequestRef } from "@synap-core/types";
import {
  collectPlaybookCriteria,
  type ExpectedOutput,
  type SessionCriterion,
} from "@synap/playbooks";
import {
  selectClaimsWithEvidence,
  selectMergedPullRequestSlots,
  selectSlotsMetByRef,
} from "../satisfy-expected-output.js";
import { criteriaAboutOutcome } from "../../dev-loop/recheck-criteria.js";
import { outputKeyWarnings } from "../update-session.js";

const PR_URL = "https://github.com/Synap-core/backend/pull/1200";
const slot: ExpectedOutput = {
  kind: "pull_request",
  label: "Backend PR",
  key: "pr-backend",
  claimedDone: true,
  ref: { url: PR_URL },
};
const sameKey: SessionCriterion = {
  key: "pr-backend",
  statement: "Merged and green",
  check: { kind: "judge" },
};
const naming: SessionCriterion = {
  key: "merged-green",
  statement: "Merged and green",
  check: { kind: "judge" },
  outputKey: "pr-backend",
};

describe("closers pair a criterion with a slot by outputKey only", () => {
  it("the one pairing: outputKey, never the key", () => {
    expect([...checkedOutputKeys([sameKey])]).toEqual([]);
    expect([...checkedOutputKeys([naming])]).toEqual(["pr-backend"]);
  });

  it("evidence: a claim closes beside a same-key criterion, holds under one naming it", () => {
    const evidence = new Map([
      ["pr-backend", { kind: "output" as const, id: "o-1" }],
    ]);
    expect(
      selectClaimsWithEvidence([slot], evidence, checkedOutputKeys([sameKey]))
    ).toHaveLength(1);
    expect(
      selectClaimsWithEvidence([slot], evidence, checkedOutputKeys([naming]))
    ).toEqual([]);
  });

  it("an OPTIONAL criterion naming the slot never holds it: evidence and the merge still close it", () => {
    const optional = checkedOutputKeys([{ ...naming, required: false }]);
    const evidence = new Map([
      ["pr-backend", { kind: "output" as const, id: "o-1" }],
    ]);
    expect(selectClaimsWithEvidence([slot], evidence, optional)).toHaveLength(
      1
    );
    expect(
      selectMergedPullRequestSlots(
        [slot],
        parsePullRequestRef(PR_URL)!,
        optional
      )
    ).toHaveLength(1);
  });

  it("merge: the PR slot closes beside a same-key criterion, holds under one naming it", () => {
    const pr = parsePullRequestRef(PR_URL)!;
    expect(
      selectMergedPullRequestSlots([slot], pr, checkedOutputKeys([sameKey]))
    ).toHaveLength(1);
    expect(
      selectMergedPullRequestSlots([slot], pr, checkedOutputKeys([naming]))
    ).toEqual([]);
  });

  it("approval by ref: closes beside a same-key criterion, holds under one naming it", () => {
    const doc: ExpectedOutput = {
      kind: "document",
      label: "Spec",
      key: "spec",
      ref: { kind: "document", id: "d-1" },
    };
    const ref = { kind: "document" as const, id: "d-1" };
    const keyed = { ...sameKey, key: "spec" };
    expect(
      selectSlotsMetByRef([doc], ref, checkedOutputKeys([keyed]))
    ).toHaveLength(1);
    expect(
      selectSlotsMetByRef(
        [doc],
        ref,
        checkedOutputKeys([{ ...keyed, outputKey: "spec" }])
      )
    ).toEqual([]);
  });

  it("an event re-grades the criteria ABOUT the outcome: the one naming it, not the same key", () => {
    expect(
      criteriaAboutOutcome([sameKey, naming], "pr-backend").map((c) => c.key)
    ).toEqual(["merged-green"]);
  });
});

describe("a playbook step's criteria check the step's output (D4 b)", () => {
  it("a stage criterion naming the stage output's key is listed under it", () => {
    const playbook = {
      criteria: [
        {
          key: "on-brand",
          statement: "The deck follows the brand guide",
          check: { kind: "judge" },
          outputKey: "deck",
        },
      ],
      stages: [
        {
          key: "draft",
          expectedOutputs: [{ kind: "document", label: "Deck" }],
          criteria: [
            {
              key: "has-pricing",
              statement: "The deck has a pricing slide",
              check: { kind: "judge" },
              outputKey: "deck",
            },
          ],
        },
      ],
    };
    // The slot a stage declares is keyed from its label at birth.
    const slots = stampSlotKeys([{ kind: "document", label: "Deck" }]);
    const view = projectSessionOutcomes({
      expectedOutputs: slots,
      criteria: collectPlaybookCriteria(playbook),
      sessionTerminal: false,
    });
    expect(view.outcomes).toHaveLength(1);
    expect(view.outcomes[0]!.criteria?.map((c) => [c.key, c.stageKey])).toEqual(
      [
        ["on-brand", undefined],
        ["has-pricing", "draft"],
      ]
    );
  });
});

describe("an outputKey that names no output is said back (W4)", () => {
  it("one sentence per sent criterion naming no outcome slot; stage criteria are left out", () => {
    const sent: SessionCriterion[] = [
      naming,
      { ...naming, key: "orphan", outputKey: "deck" },
      { ...naming, key: "later", outputKey: "deck", stageKey: "draft" },
    ];
    const warnings = outputKeyWarnings(sent, [slot]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Criterion "orphan"');
    expect(warnings[0]).toContain('"deck"');
    expect(outputKeyWarnings(undefined, [slot])).toEqual([]);
  });
});
