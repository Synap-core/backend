import { describe, it, expect } from "vitest";
import {
  deriveSlotKeys,
  projectSessionOutcomes,
  readInputs,
  readOutcomes,
  slotKeyBase,
  slotLabelOf,
  stampSlotKeys,
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
 *   H. "a slot and a criterion sharing a key are two outcomes"
 *   I. "an ungraded check on an open session is being worked on" (the AI
 *      spark claims a check nobody is running)
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
    name: "a slot and a criterion sharing a key are ONE outcome, graded by the criterion",
    rulesOut: "H",
    slots: [
      { kind: "report", label: "Founder approves", key: "founder-approves" },
    ],
    criteria: [
      {
        key: "founder-approves",
        statement: "Founder approves the plan",
        check: { kind: "human" },
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
