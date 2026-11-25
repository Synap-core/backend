import { describe, it, expect } from "vitest";
import {
  checkedOutputKeys,
  criteriaNamingNoOutput,
  deriveSlotKeys,
  nameSharedKeyOutputs,
  outcomeSlotKeys,
  projectSessionOutcomes,
  readInputs,
  readOutcomes,
  slotKeyBase,
  slotLabelOf,
  stampSlotKeys,
  unmetRequiredOutcomes,
  type OutcomeCriterionLike,
} from "./outcome.js";
import { CRITERION_SLOT_KIND } from "../focus-sessions/criterion-slot.js";
import { PARAM_SLOT_KIND } from "../focus-sessions/param-slot.js";
import type { EvaluationRowLike } from "../focus-sessions/verdict.js";

const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-01T11:00:00.000Z";

/**
 * Every row names the RIVAL rule it rules out — a row on which the rival and
 * the real rule agree is decoration, not coverage.
 *
 *   A. "every human-owned slot is an input"   (a person's own deliverable
 *      would leave the outcome list for the needs list)
 *   B. "a blocked slot is an input INSTEAD of an outcome" (the outcome
 *      vanishes the moment the agent asks about it)
 *   C. "every slot is an outcome"             (a param / grade slot becomes a
 *      second outcome)
 *   D. "a retired human slot is still an input" (cancelled work keeps asking)
 *   E. "claimedDone is met"                   (the agent grades itself)
 *   F. "latest row wins"                      (a judge after a human un-grades)
 *   G. "evidence joins by label only"         (a renamed slot loses its proof)
 *   H. "a slot and the criterion checking it are two outcomes"
 *   I. "an ungraded check on an open session is being worked on" (the AI
 *      spark claims a check nobody is running)
 *   J. "a criterion sharing a slot's key checks it" (the pre-W4 same-key
 *      fold: pairing is `outputKey`, never the key)
 *   K. "one passing check meets the output" (an output's checks all count:
 *      its kind's and its step's, D4 a)
 *   L. "a delivered slot is met" (a required criterion that failed, or has
 *      no grade yet, still holds a delivered output: the projection must agree
 *      with `computeSessionVerdict` and the close check)
 */
interface Row {
  name: string;
  rulesOut: string;
  slots: unknown[];
  criteria?: OutcomeCriterionLike[];
  evaluations?: EvaluationRowLike[];
  terminal?: boolean;
  outcomes: Array<{
    key: string;
    state: string;
    met: boolean;
    verify?: string;
  }>;
  inputs: Array<{
    key: string;
    need: string;
    blocks: string | null;
    open: boolean;
  }>;
}

const ROWS: Row[] = [
  {
    name: "an ungraded judge check on an OPEN session reads Not checked, never working",
    rulesOut: "I",
    slots: [],
    criteria: [
      {
        key: "evidence-cited",
        statement: "Every gap cites file:line",
        check: { kind: "judge" },
      },
    ],
    evaluations: [],
    terminal: false,
    outcomes: [
      {
        key: "evidence-cited",
        state: "unmeasured",
        met: false,
        verify: "judge",
      },
    ],
    inputs: [],
  },
  {
    name: "a person's own deliverable is an outcome checked by them, not an input",
    rulesOut: "A",
    slots: [
      {
        kind: "decision",
        label: "Top 10 approved",
        owner: "human",
        owedSince: T0,
      },
    ],
    outcomes: [
      {
        key: "top-10-approved",
        state: "needs_you",
        met: false,
        verify: "human",
      },
    ],
    inputs: [],
  },
  {
    name: "a slot blocked on a decision is BOTH an outcome and an input pointing at it",
    rulesOut: "A+B",
    slots: [
      {
        kind: "report",
        label: "50 qualified leads",
        owner: "human",
        blockedReason: "decision",
        why: "Include agencies outside France?",
        owedSince: T0,
      },
    ],
    outcomes: [
      {
        key: "50-qualified-leads",
        state: "needs_you",
        met: false,
        verify: "human",
      },
    ],
    inputs: [
      {
        key: "50-qualified-leads",
        need: "decision",
        blocks: "50-qualified-leads",
        open: true,
      },
    ],
  },
  {
    name: "an escalated criterion is that criterion's grade, never a second outcome",
    rulesOut: "C",
    slots: [
      {
        kind: CRITERION_SLOT_KIND,
        label: "Check: Each lead has a reason",
        criterionKey: "lead-reason",
        owner: "human",
        blockedReason: "decision",
        owedSince: T0,
      },
    ],
    criteria: [
      {
        key: "lead-reason",
        statement: "Each lead has a reason",
        check: { kind: "judge" },
      },
    ],
    evaluations: [
      {
        criterionKey: "lead-reason",
        verdict: "fail",
        evaluatorKind: "judge",
        createdAt: T0,
        attempt: 1,
      },
      {
        criterionKey: "lead-reason",
        verdict: "unmeasured",
        evaluatorKind: "judge",
        createdAt: T1,
        attempt: 2,
      },
    ],
    outcomes: [
      { key: "lead-reason", state: "needs_you", met: false, verify: "judge" },
    ],
    inputs: [
      {
        key: "check-each-lead-has-a-reason",
        need: "grade",
        blocks: "lead-reason",
        open: true,
      },
    ],
  },
  {
    name: "a param slot asks for a value and yields nothing",
    rulesOut: "C",
    slots: [
      {
        kind: PARAM_SLOT_KIND,
        label: "Answer: Region",
        paramName: "region",
        owner: "human",
        blockedReason: "decision",
        owedSince: T0,
      },
    ],
    outcomes: [],
    inputs: [{ key: "answer-region", need: "param", blocks: null, open: true }],
  },
  {
    name: "a retired human slot is neither met nor asked",
    rulesOut: "D",
    slots: [
      {
        kind: "credential",
        label: "Stripe key",
        owner: "human",
        blockedReason: "credential",
        owedSince: T0,
        retiredAt: T1,
        retiredReason: "session_cancelled",
      },
    ],
    terminal: true,
    outcomes: [{ key: "stripe-key", state: "done", met: false }],
    inputs: [],
  },
  {
    name: "claimedDone without a stamp is a judgement owed, not met",
    rulesOut: "E",
    slots: [{ kind: "document", label: "Outreach message", claimedDone: true }],
    outcomes: [
      {
        key: "outreach-message",
        state: "needs_review",
        met: false,
        verify: "evidence",
      },
    ],
    inputs: [],
  },
  {
    name: "a human pass outranks a LATER judge fail",
    rulesOut: "F",
    slots: [],
    criteria: [
      {
        key: "typecheck",
        statement: "Typecheck passes",
        check: { kind: "evidence" },
      },
    ],
    evaluations: [
      {
        criterionKey: "typecheck",
        verdict: "pass",
        evaluatorKind: "human",
        createdAt: T0,
      },
      {
        criterionKey: "typecheck",
        verdict: "fail",
        evaluatorKind: "judge",
        createdAt: T1,
      },
    ],
    outcomes: [
      { key: "typecheck", state: "done", met: true, verify: "evidence" },
    ],
    inputs: [],
  },
  {
    name: "a slot and the criterion naming it (outputKey) are ONE outcome, graded by the criterion",
    rulesOut: "H",
    slots: [
      { kind: "report", label: "Founder approves", key: "founder-approves" },
    ],
    criteria: [
      {
        key: "founder-approves",
        statement: "Founder approves the plan",
        check: { kind: "human" },
        outputKey: "founder-approves",
      },
    ],
    evaluations: [
      {
        criterionKey: "founder-approves",
        verdict: "pass",
        evaluatorKind: "human",
        createdAt: T0,
      },
    ],
    outcomes: [
      { key: "founder-approves", state: "done", met: true, verify: "human" },
    ],
    inputs: [],
  },
  {
    name: "a criterion sharing a slot's key but naming no output is its own outcome",
    rulesOut: "J",
    slots: [{ kind: "report", label: "Plan", key: "plan" }],
    criteria: [
      { key: "plan", statement: "The plan is sound", check: { kind: "judge" } },
    ],
    evaluations: [
      {
        criterionKey: "plan",
        verdict: "pass",
        evaluatorKind: "judge",
        createdAt: T0,
      },
    ],
    outcomes: [
      { key: "plan", state: "working", met: false, verify: "evidence" },
      { key: "plan", state: "done", met: true, verify: "judge" },
    ],
    inputs: [],
  },
  {
    name: "an output with two checks is met only when both pass",
    rulesOut: "K",
    slots: [{ kind: "document", label: "Deck", key: "deck" }],
    criteria: [
      {
        key: "on-brand",
        statement: "The deck follows the brand guide",
        check: { kind: "judge" },
        outputKey: "deck",
      },
      {
        key: "has-pricing",
        statement: "The deck has a pricing slide",
        check: { kind: "evidence" },
        outputKey: "deck",
      },
    ],
    evaluations: [
      {
        criterionKey: "on-brand",
        verdict: "pass",
        evaluatorKind: "judge",
        createdAt: T0,
      },
      {
        criterionKey: "has-pricing",
        verdict: "fail",
        evaluatorKind: "evidence",
        createdAt: T1,
      },
    ],
    outcomes: [{ key: "deck", state: "failed", met: false, verify: "judge" }],
    inputs: [],
  },
  {
    name: "a DELIVERED output whose required criterion failed is not met",
    rulesOut: "L",
    slots: [
      {
        kind: "pull_request",
        label: "PR",
        key: "pr",
        status: "done",
        attestedBy: "u",
      },
    ],
    criteria: [
      {
        key: "tests-pass",
        statement: "Tests pass",
        check: { kind: "evidence" },
        outputKey: "pr",
      },
    ],
    evaluations: [
      {
        criterionKey: "tests-pass",
        verdict: "fail",
        evaluatorKind: "evidence",
        createdAt: T0,
      },
    ],
    outcomes: [{ key: "pr", state: "failed", met: false, verify: "evidence" }],
    inputs: [],
  },
  {
    name: "a DELIVERED output whose required criterion has no grade yet is not met",
    rulesOut: "L",
    slots: [
      {
        kind: "pull_request",
        label: "PR",
        key: "pr",
        status: "done",
        attestedBy: "u",
      },
    ],
    criteria: [
      {
        key: "tests-pass",
        statement: "Tests pass",
        check: { kind: "evidence" },
        outputKey: "pr",
      },
    ],
    outcomes: [
      { key: "pr", state: "unmeasured", met: false, verify: "evidence" },
    ],
    inputs: [],
  },
  {
    name: "a DELIVERED output with only an OPTIONAL failing criterion is met",
    rulesOut: "L",
    slots: [
      {
        kind: "pull_request",
        label: "PR",
        key: "pr",
        status: "done",
        attestedBy: "u",
      },
    ],
    criteria: [
      {
        key: "tidy",
        statement: "The diff is tidy",
        required: false,
        check: { kind: "judge" },
        outputKey: "pr",
      },
    ],
    evaluations: [
      {
        criterionKey: "tidy",
        verdict: "fail",
        evaluatorKind: "judge",
        createdAt: T0,
      },
    ],
    outcomes: [{ key: "pr", state: "done", met: true, verify: "judge" }],
    inputs: [],
  },
  {
    name: "an agent slot whose question was answered: outcome stays, input closed",
    rulesOut: "B",
    slots: [
      {
        kind: "report",
        label: "Lead list",
        answer: {
          text: "EU",
          messageId: null,
          answeredBy: "u",
          answeredAt: T1,
        },
      },
    ],
    outcomes: [{ key: "lead-list", state: "working", met: false }],
    inputs: [
      { key: "lead-list", need: "decision", blocks: "lead-list", open: false },
    ],
  },
];

describe("projectSessionOutcomes — discriminating rows", () => {
  for (const row of ROWS) {
    it(`${row.name} (rules out ${row.rulesOut})`, () => {
      const view = projectSessionOutcomes({
        expectedOutputs: row.slots,
        criteria: row.criteria,
        evaluations: row.evaluations,
        sessionTerminal: row.terminal ?? false,
      });
      expect(
        view.outcomes.map((o) => ({
          key: o.key,
          state: o.state.state,
          met: o.met,
          ...(row.outcomes.some((x) => x.verify) ? { verify: o.verify } : {}),
        }))
      ).toEqual(
        row.outcomes.map((o) => ({
          key: o.key,
          state: o.state,
          met: o.met,
          ...(row.outcomes.some((x) => x.verify) ? { verify: o.verify } : {}),
        }))
      );
      expect(
        view.inputs.map((i) => ({
          key: i.key,
          need: i.need,
          blocks: i.blocksOutcomeKey,
          open: i.open,
        }))
      ).toEqual(row.inputs);
    });
  }
});

describe("evidence and unattached", () => {
  const slots = [
    { kind: "document", label: "Brief", key: "brief" },
    { kind: "document", label: "Deck", key: "deck" },
  ];
  it("joins by KEY before label — a claim naming B's key lands on B even when its label is A's (rules out G)", () => {
    const view = projectSessionOutcomes({
      expectedOutputs: slots,
      produced: [
        { id: "document:1", expected: { key: "deck", label: "Brief" } },
        { id: "document:2", expected: { label: "brief" } },
        { id: "entity:3" },
        { id: "entity:4", expected: { label: "nothing declared" } },
      ],
      sessionTerminal: false,
    });
    const ev = Object.fromEntries(
      view.outcomes.map((o) => [o.key, o.evidence.map((e) => e.id)])
    );
    expect(ev).toEqual({ brief: ["document:2"], deck: ["document:1"] });
    expect(view.unattached.map((u) => u.id)).toEqual(["entity:3", "entity:4"]);
  });

  it("counts met over non-retired outcomes", () => {
    const view = projectSessionOutcomes({
      expectedOutputs: [
        { kind: "a", label: "A", status: "done" },
        { kind: "b", label: "B" },
        { kind: "c", label: "C", retiredAt: T0 },
      ],
      criteria: [
        { key: "k", statement: "K holds", check: { kind: "evidence" } },
      ],
      evaluations: [
        {
          criterionKey: "k",
          verdict: "pass",
          evaluatorKind: "evidence",
          createdAt: T0,
        },
      ],
      sessionTerminal: false,
    });
    expect(view.counts).toEqual({ met: 2, total: 3 });
  });

  it("readOutcomes / readInputs are the projection's two halves", () => {
    const input = {
      expectedOutputs: [
        {
          kind: "report",
          label: "R",
          owner: "human",
          blockedReason: "credential",
        },
      ],
      sessionTerminal: false,
    };
    expect(readOutcomes(input).map((o) => o.key)).toEqual(["r"]);
    expect(readInputs(input).map((i) => i.need)).toEqual(["credential"]);
  });
});

describe("criteria hang on their output (rule 7, W4)", () => {
  const slots = [
    { kind: "document", label: "Deck", key: "deck" },
    {
      kind: CRITERION_SLOT_KIND,
      label: "Grade: on brand",
      key: "grade-on-brand",
      criterionKey: "on-brand",
      owner: "human",
    },
  ];
  const criteria: OutcomeCriterionLike[] = [
    {
      key: "on-brand",
      statement: "On brand",
      check: { kind: "judge" },
      outputKey: "deck",
    },
    {
      key: "has-pricing",
      statement: "Has a pricing slide",
      check: { kind: "evidence" },
      outputKey: "deck",
      stageKey: "build",
    },
    {
      key: "orphan",
      statement: "Names an output the session does not hold",
      check: { kind: "judge" },
      outputKey: "nope",
    },
  ];
  const pass = (criterionKey: string): EvaluationRowLike => ({
    criterionKey,
    verdict: "pass",
    evaluatorKind: "judge",
    createdAt: T0,
  });

  it("lists every check under its output, in declared order, each with its own state", () => {
    const view = projectSessionOutcomes({
      expectedOutputs: slots,
      criteria,
      evaluations: [pass("has-pricing")],
      sessionTerminal: false,
    });
    expect(view.outcomes.map((o) => [o.key, o.source])).toEqual([
      ["deck", "slot+criterion"],
      ["orphan", "criterion"],
    ]);
    const deck = view.outcomes[0]!;
    expect(deck.met).toBe(false);
    expect(
      deck.criteria?.map((c) => [c.key, c.met, c.state.state, c.stageKey])
    ).toEqual([
      ["on-brand", false, "needs_you", undefined],
      ["has-pricing", true, "done", "build"],
    ]);
    // The grade a person owes on a check blocks the OUTPUT it checks.
    expect(view.inputs.map((i) => [i.key, i.blocksOutcomeKey])).toEqual([
      ["grade-on-brand", "deck"],
    ]);
  });

  it("met once every check passes, with the latest pass as its verdict", () => {
    const view = projectSessionOutcomes({
      expectedOutputs: slots,
      criteria,
      evaluations: [
        pass("on-brand"),
        { ...pass("has-pricing"), createdAt: T1 },
      ],
      sessionTerminal: false,
    });
    const deck = view.outcomes[0]!;
    expect(deck.met).toBe(true);
    expect(deck.metBy).toBe("verdict");
    expect(deck.verdict?.at).toBe(T1);
  });

  it("a required slot stays required when its only criteria are optional; an optional slot a required criterion checks becomes required", () => {
    const optionalOnly = projectSessionOutcomes({
      expectedOutputs: [slots[0]],
      criteria: [{ ...criteria[0]!, required: false }],
      sessionTerminal: false,
    });
    expect(optionalOnly.outcomes[0]!.required).toBe(true);
    const optionalSlot = projectSessionOutcomes({
      expectedOutputs: [{ ...slots[0]!, optional: true }],
      criteria: [criteria[0]!],
      sessionTerminal: false,
    });
    expect(optionalSlot.outcomes[0]!.required).toBe(true);
  });

  it("an optional check never holds the output while a required one counts", () => {
    const view = projectSessionOutcomes({
      expectedOutputs: [slots[0]],
      criteria: [{ ...criteria[0]!, required: false }, criteria[1]!],
      evaluations: [pass("has-pricing")],
      sessionTerminal: false,
    });
    expect(view.outcomes[0]!.met).toBe(true);
  });
});

describe("the pairing helpers (W4)", () => {
  const slots = [
    { kind: "document", label: "Plan", key: "plan" },
    { kind: PARAM_SLOT_KIND, label: "Region", key: "region" },
    { kind: CRITERION_SLOT_KIND, label: "Grade", key: "grade" },
    { kind: "report", label: "Lead list" },
  ];

  it("outcomeSlotKeys: the outcome slots only, keyed as stamped, in order", () => {
    expect(outcomeSlotKeys(slots)).toEqual([
      { index: 0, key: "plan" },
      { index: 3, key: "lead-list" },
    ]);
    expect(outcomeSlotKeys("not an array")).toEqual([]);
  });

  it("checkedOutputKeys: only a REQUIRED criterion holds its slot", () => {
    const c = (required?: boolean) => ({
      outputKey: "plan",
      ...(required === undefined ? {} : { required }),
    });
    expect([...checkedOutputKeys([c()])]).toEqual(["plan"]);
    expect([...checkedOutputKeys([c(false)])]).toEqual([]);
  });

  it("nameSharedKeyOutputs: a same-key criterion names its outcome slot; method, param and named ones are left alone", () => {
    const criteria = [
      { key: "plan", statement: "Sound", check: { kind: "judge" as const } },
      { key: "lead-list", statement: "EU", check: { kind: "judge" as const } },
      { key: "region", statement: "Set", check: { kind: "judge" as const } },
      {
        key: "plan-method",
        statement: "Reviewed",
        check: { kind: "judge" as const },
        outputKey: "plan",
      },
      {
        key: "nothing",
        statement: "Free",
        check: { kind: "judge" as const },
      },
    ];
    expect(
      nameSharedKeyOutputs(criteria, slots).map((c) => [c.key, c.outputKey])
    ).toEqual([
      ["plan", "plan"],
      ["lead-list", "lead-list"],
      ["region", undefined],
      ["plan-method", "plan"],
      ["nothing", undefined],
    ]);
    const method = [{ ...criteria[0]!, about: "method" as const }];
    expect(nameSharedKeyOutputs(method, slots)).toBe(method);
    expect(nameSharedKeyOutputs(criteria.slice(2), slots)).toEqual(
      criteria.slice(2)
    );
  });

  it("criteriaNamingNoOutput: an outputKey that names no outcome slot", () => {
    expect(
      criteriaNamingNoOutput(
        [
          { key: "a", outputKey: "plan" },
          { key: "b", outputKey: "region" },
          { key: "c", outputKey: "missing" },
          { key: "d" },
        ],
        slots
      )
    ).toEqual(["b", "c"]);
  });
});

describe("slot keys", () => {
  it("accepts all three stored slot shapes and never yields an empty name", () => {
    expect(slotLabelOf({ kind: "report", label: "Weekly report" })).toBe(
      "Weekly report"
    );
    expect(
      slotLabelOf({ type: "document", description: "A research report" })
    ).toBe("A research report");
    expect(slotLabelOf({ kind: "entity", profileSlug: "lead_list" })).toBe(
      "Lead list"
    );
    expect(
      deriveSlotKeys([{ type: "document", description: "A research report" }])
    ).toEqual(["a-research-report"]);
  });

  it("derives deterministic, collision-free keys and keeps stored ones", () => {
    expect(
      deriveSlotKeys([
        { label: "Report" },
        { label: "report" },
        { label: "Rapport été", key: "report-2" },
        "garbage",
        { label: "", kind: "" },
      ])
    ).toEqual(["report", "report-3", "report-2", null, "output"]);
  });

  it("a stored duplicate key is held by its first holder only", () => {
    expect(
      deriveSlotKeys([
        { label: "X", key: "k" },
        { label: "Y", key: "k" },
      ])
    ).toEqual(["k", "y"]);
  });

  it("stamping writes exactly what a reader derives, and is idempotent", () => {
    const legacy = [
      { label: "Report" },
      { label: "Report" },
      { label: "Déjà vu" },
    ];
    const stamped = stampSlotKeys(legacy);
    expect(stamped.map((s) => (s as { key?: string }).key)).toEqual(
      deriveSlotKeys(legacy)
    );
    expect(stampSlotKeys(stamped)).toBe(stamped);
    expect(stampSlotKeys(null)).toBe(null);
    expect(slotKeyBase("Déjà vu!")).toBe("deja-vu");
  });

  it("the projection's slot keys equal the stamped keys (read = write)", () => {
    const legacy = [
      { kind: "doc", label: "Report" },
      { kind: "doc", label: "Report" },
    ];
    expect(
      readOutcomes({ expectedOutputs: legacy, sessionTerminal: false }).map(
        (o) => o.key
      )
    ).toEqual(
      readOutcomes({
        expectedOutputs: stampSlotKeys(legacy),
        sessionTerminal: false,
      }).map((o) => o.key)
    );
  });
});

/**
 * WHICH door met an outcome (A3). Rival I: "status done is enough" — it
 * cannot tell an approval from the pre-A3 agent self-mark, which is exactly
 * the receipt-less `done` this field exists to expose.
 */
describe("metBy — the door that earned the `done` (rules out I)", () => {
  const view = projectSessionOutcomes({
    expectedOutputs: [
      {
        kind: "doc",
        label: "Approved",
        status: "done",
        satisfiedByProposalId: "p1",
      },
      {
        kind: "doc",
        label: "Attested",
        status: "done",
        owner: "human",
        attestedBy: "u1",
      },
      {
        kind: "doc",
        label: "Evidenced",
        status: "done",
        claimedDone: true,
        satisfiedByEvidence: { kind: "output", id: "document:d1", at: T0 },
      },
      { kind: "doc", label: "Self-marked", status: "done" },
      { kind: "doc", label: "Claimed only", claimedDone: true },
    ],
    criteria: [
      { key: "proven", statement: "It is proven", check: { kind: "judge" } },
    ],
    evaluations: [
      {
        criterionKey: "proven",
        verdict: "pass",
        evaluatorKind: "judge",
        createdAt: T1,
        attempt: 1,
      },
    ],
    sessionTerminal: false,
  });
  const by = Object.fromEntries(view.outcomes.map((o) => [o.label, o.metBy]));

  it("names approval, attestation, evidence and verdict apart", () => {
    expect(by["Approved"]).toBe("approval");
    expect(by["Attested"]).toBe("attestation");
    expect(by["Evidenced"]).toBe("evidence");
    expect(by["It is proven"]).toBe("verdict");
  });

  it("a done with no receipt is `unverified`, and a bare claim is not met", () => {
    expect(by["Self-marked"]).toBe("unverified");
    expect(by["Claimed only"]).toBeNull();
    expect(
      view.outcomes.find((o) => o.label === "Claimed only")?.state.state
    ).toBe("needs_review");
  });
});

describe("an OPTIONAL slot never holds a gate (rules out 'every slot is required')", () => {
  const view = (slots: unknown[]) =>
    projectSessionOutcomes({
      expectedOutputs: slots,
      criteria: [],
      evaluations: [],
      sessionTerminal: true,
    });

  it("unfilled: not required, not met, no unmet required outcome, no input raised", () => {
    const v = view([
      {
        kind: "invoice",
        label: "Milestone invoice",
        key: "milestone-invoice",
        owner: "human",
        blockedReason: "needs_decision",
        optional: true,
      },
    ]);
    expect(v.outcomes[0]).toMatchObject({
      key: "milestone-invoice",
      required: false,
      met: false,
    });
    expect(unmetRequiredOutcomes(v.outcomes)).toEqual([]);
    expect(v.inputs.filter((i) => i.open)).toEqual([]);
  });

  it("filled: met and done, like any delivered slot", () => {
    const v = view([
      {
        kind: "invoice",
        label: "Milestone invoice",
        key: "milestone-invoice",
        optional: true,
        status: "done",
        attestedBy: "user-1",
      },
    ]);
    expect(v.outcomes[0]).toMatchObject({ met: true, required: false });
    expect(v.outcomes[0]!.state.state).toBe("done");
  });

  it("a required sibling still holds the gate", () => {
    const v = view([
      { kind: "invoice", label: "Milestone invoice", optional: true },
      { kind: "report", label: "Acceptance note" },
    ]);
    expect(unmetRequiredOutcomes(v.outcomes)).toEqual(["acceptance-note"]);
  });
});

/**
 * A DECISION the person answered, whose decision the pod filed, IS met (rule
 * 6b, founder 2 Nov 2026). The first fixture is a slot exactly as the pod
 * stored it on session 2c9791ac (answered before the rule existed, then
 * claimed by the agent as a workaround): it must read met with no backfill.
 * Rivals ruled out: "only `done` is met" (the 2 Nov reading: 2 of 6),
 * "a claim on an answered decision waits for review", "a decisionId alone is
 * the proof" (an ask the reactor opened for a decision, still unanswered),
 * "any answer is the proof" (its filing failed: no decisionId), "a re-asked
 * slot keeps its old proof", "a criterion grade is a decision".
 */
describe("an answered decision is met by its answer (rule 6b)", () => {
  const CHOSEN = {
    text: "Graph node of an owed outcome",
    value: { type: "chip", chip: { label: "Graph node of an owed outcome" } },
    question: "248 of 314 tasks are todo and nothing closes them",
    answeredAt: T0,
    answeredBy: "u1",
    askSnapshot: {
      why: "248 of 314 tasks are todo and nothing closes them",
      mode: "choose",
      options: [{ label: "Graph node of an owed outcome", recommended: true }],
      chosenKey: "Graph node of an owed outcome",
      recommendedKey: "Graph node of an owed outcome",
      followedRecommendation: true,
    },
  };
  const STORED_2C9791AC = {
    key: "d4-tasks",
    kind: "decision",
    label: "Tasks model",
    answer: CHOSEN,
    decisionId: "15a36421-6303-4fa3-8021-f1394bd81721",
    claimedDone: true,
  };
  const project = (slots: unknown[], terminal = true) =>
    projectSessionOutcomes({
      expectedOutputs: slots,
      produced: [
        {
          id: "entity:15a36421-6303-4fa3-8021-f1394bd81721",
          expected: { key: "d4-tasks", label: "Tasks model" },
        },
      ],
      sessionTerminal: terminal,
    });

  it("the stored 2c9791ac slot reads met by the answer, done, the person's, with its decision as evidence", () => {
    const view = project([STORED_2C9791AC]);
    const [o] = view.outcomes;
    expect(o).toMatchObject({
      key: "d4-tasks",
      met: true,
      metBy: "answer",
      owner: "human",
      verify: "human",
      retired: false,
    });
    expect(o!.state.state).toBe("done");
    expect(o!.evidence.map((e) => e.id)).toEqual([
      "entity:15a36421-6303-4fa3-8021-f1394bd81721",
    ]);
    expect(view.counts).toEqual({ met: 1, total: 1 });
    expect(unmetRequiredOutcomes(view.outcomes)).toEqual([]);
    // Still a receipt on the input side: answered, not open.
    expect(view.inputs[0]).toMatchObject({ answered: true, open: false });
  });

  it("without the agent's claim too (the answer alone is the proof)", () => {
    const { claimedDone: _c, ...unclaimed } = STORED_2C9791AC;
    const [o] = project([unclaimed], false).outcomes;
    expect(o).toMatchObject({ met: true, metBy: "answer" });
    expect(o!.state.state).toBe("done");
  });

  it("a confirm answered Yes or No is met the same way", () => {
    const [o] = project([
      {
        ...STORED_2C9791AC,
        answer: {
          ...CHOSEN,
          askSnapshot: { mode: "confirm", chosenKey: "no" },
        },
      },
    ]).outcomes;
    expect(o).toMatchObject({ met: true, metBy: "answer" });
  });

  const unmet: Array<[string, Record<string, unknown>]> = [
    [
      "an open ask on a decision (decisionId, no answer)",
      {
        kind: "decision",
        label: "Tasks model",
        decisionId: "d-1",
        owner: "human",
        blockedReason: "decision",
        ask: { mode: "choose", options: [{ label: "A" }] },
      },
    ],
    [
      "an answer whose decision was never filed (no decisionId)",
      {
        kind: "decision",
        label: "Tasks model",
        answer: CHOSEN,
      },
    ],
    [
      "a re-asked slot (old answer archived)",
      {
        kind: "decision",
        label: "Tasks model",
        decisionId: "d-1",
        owner: "human",
        answerHistory: [CHOSEN],
      },
    ],
    [
      "a form answer (files no decision)",
      {
        kind: "decision",
        label: "Tasks model",
        decisionId: "d-1",
        answer: { ...CHOSEN, askSnapshot: { mode: "form" } },
      },
    ],
  ];
  it.each(unmet)("%s is not met", (_name, slot) => {
    const [o] = project([slot], false).outcomes;
    expect(o).toMatchObject({ met: false, metBy: null });
    expect(unmetRequiredOutcomes([o!])).toEqual([o!.key]);
  });

  it("a criterion grade is never a decision's proof (an input, not an outcome)", () => {
    const view = project([
      {
        kind: CRITERION_SLOT_KIND,
        label: "Grade: tests pass",
        criterionKey: "tests-pass",
        owner: "human",
        decisionId: "d-1",
        answer: CHOSEN,
      },
    ]);
    expect(view.outcomes).toEqual([]);
  });

  it("a retired decision stays retired (rule 5 before 6b)", () => {
    const [o] = project([{ ...STORED_2C9791AC, retiredAt: T1 }]).outcomes;
    expect(o).toMatchObject({ met: false, retired: true });
  });
});
