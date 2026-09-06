/**
 * The three-ledger join, unit level.
 *
 * A session's outputs live in `produced` edges, `artifacts` rows and
 * `expected_outputs` jsonb, and until this door they were reconciled by a
 * kind-string GUESS in the frontend. These pin the precedence that replaces it:
 * ID JOIN first, PROPOSAL LINEAGE second, kind matching only as a last resort
 * for an expected output that carries no lineage at all.
 */
import { describe, it, expect } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  joinSessionOutputs,
  type JoinArtifactRow,
  type JoinProducedRow,
  type JoinProposalRow,
} from "../session-outputs.js";

const ENTITY_A = "11111111-1111-4111-8111-111111111111";
const DOC_A = "22222222-2222-4222-8222-222222222222";
const DOC_B = "33333333-3333-4333-8333-333333333333";
const PROPOSAL = "44444444-4444-4444-8444-444444444444";

const t = (min: number) => new Date(Date.UTC(2026, 8, 4, 12, min));

const artifact = (over: Partial<JoinArtifactRow>): JoinArtifactRow => ({
  id: "row-id",
  kind: "entity",
  refId: ENTITY_A,
  cellKey: null,
  title: "Artifact title",
  originKind: "agent",
  state: "working",
  createdAt: t(1),
  ...over,
});

const empty = {
  artifacts: [] as JoinArtifactRow[],
  produced: [] as JoinProducedRow[],
  expectedOutputs: [] as ExpectedOutput[],
  proposals: [] as JoinProposalRow[],
  titles: new Map<string, string>(),
};

describe("joinSessionOutputs — id join", () => {
  it("collapses an artifact row and a produced edge naming the same object", () => {
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [artifact({})],
      produced: [{ toType: "entity", toId: ENTITY_A, createdAt: t(5) }],
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.source).toEqual(["artifact", "produced_edge"]);
    // The EARLIEST sighting is when the session produced it.
    expect(outputs[0]!.producedAt).toEqual(t(1));
  });

  it("navigates by refId, never the artifact row id", () => {
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [artifact({})],
    });
    expect(outputs[0]!.refId).toBe(ENTITY_A);
    expect(outputs[0]!.id).toBe(`entity:${ENTITY_A}`);
    expect(outputs[0]!.refId).not.toBe("row-id");
  });

  it("a cell artifact has no backing object — its own row id is the coordinate", () => {
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [
        artifact({
          id: "cell-row",
          kind: "cell",
          refId: null,
          cellKey: "table-view",
        }),
      ],
    });
    expect(outputs[0]!.refId).toBe("table-view");
  });

  it("prefers the live title over the artifact's stored copy", () => {
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [artifact({ title: "Stale" })],
      titles: new Map([[`entity:${ENTITY_A}`, "Renamed since"]]),
    });
    expect(outputs[0]!.title).toBe("Renamed since");
  });
});

describe("joinSessionOutputs — expected outputs", () => {
  it("proposal lineage beats the kind guess", () => {
    // Two documents. The kind guess would claim the FIRST; the approved
    // proposal names the SECOND, and evidence wins.
    const { outputs, pendingExpected } = joinSessionOutputs({
      ...empty,
      artifacts: [
        artifact({ id: "a1", kind: "document", refId: DOC_A, createdAt: t(1) }),
        artifact({ id: "a2", kind: "document", refId: DOC_B, createdAt: t(2) }),
      ],
      expectedOutputs: [
        {
          kind: "document",
          label: "Spec",
          status: "done",
          satisfiedByProposalId: PROPOSAL,
        },
      ],
      proposals: [
        {
          id: PROPOSAL,
          targetType: "document",
          targetId: DOC_B,
          agentUserId: "agent-1",
        },
      ],
    });
    expect(pendingExpected).toEqual([]);
    expect(outputs.find((o) => o.refId === DOC_A)!.expected).toBeUndefined();
    expect(outputs.find((o) => o.refId === DOC_B)!.expected).toEqual({
      label: "Spec",
      status: "done",
      satisfiedByProposalId: PROPOSAL,
    });
  });

  it("falls back to kind matching ONLY when there is no lineage to read", () => {
    const { outputs, pendingExpected } = joinSessionOutputs({
      ...empty,
      artifacts: [artifact({ kind: "document", refId: DOC_A })],
      expectedOutputs: [{ kind: "document", label: "Spec", claimedDone: true }],
    });
    expect(pendingExpected).toEqual([]);
    expect(outputs[0]!.expected).toEqual({ label: "Spec", claimedDone: true });
    expect(outputs[0]!.source).toEqual(["artifact", "expected"]);
  });

  it("a declared deliverable with nothing behind it is pendingExpected", () => {
    const { outputs, pendingExpected } = joinSessionOutputs({
      ...empty,
      artifacts: [artifact({ kind: "entity", refId: ENTITY_A })],
      expectedOutputs: [{ kind: "document", label: "Spec" }],
    });
    expect(outputs[0]!.expected).toBeUndefined();
    expect(pendingExpected).toEqual([{ kind: "document", label: "Spec" }]);
  });

  it("lineage pointing at an object this session never produced stays pending", () => {
    // The stamp says done; no produced object carries that coordinate. Reporting
    // it as delivered would be the self-certifying lie the door exists to stop.
    const { pendingExpected } = joinSessionOutputs({
      ...empty,
      artifacts: [artifact({ kind: "document", refId: DOC_A })],
      expectedOutputs: [
        {
          kind: "document",
          label: "Spec",
          status: "done",
          satisfiedByProposalId: PROPOSAL,
        },
      ],
      proposals: [
        {
          id: PROPOSAL,
          targetType: "document",
          targetId: DOC_B,
          agentUserId: null,
        },
      ],
    });
    expect(pendingExpected).toHaveLength(1);
  });

  it("one object satisfies at most one deliverable", () => {
    const { outputs, pendingExpected } = joinSessionOutputs({
      ...empty,
      artifacts: [artifact({ kind: "document", refId: DOC_A })],
      expectedOutputs: [
        { kind: "document", label: "Spec" },
        { kind: "document", label: "Summary" },
      ],
    });
    expect(outputs[0]!.expected!.label).toBe("Spec");
    expect(pendingExpected.map((e) => e.label)).toEqual(["Summary"]);
  });
});

describe("joinSessionOutputs — provenance", () => {
  it("reads agent provenance from the artifact ledger", () => {
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [artifact({ originKind: "agent" })],
    });
    expect(outputs[0]!.producedBy).toBe("agent");
  });

  it("a produced edge carries no origin — the satisfying proposal supplies it", () => {
    const { outputs } = joinSessionOutputs({
      ...empty,
      produced: [{ toType: "entity", toId: ENTITY_A, createdAt: t(3) }],
      expectedOutputs: [
        {
          kind: "entity",
          label: "Client record",
          satisfiedByProposalId: PROPOSAL,
        },
      ],
      proposals: [
        {
          id: PROPOSAL,
          targetType: "entity",
          targetId: ENTITY_A,
          agentUserId: "agent-1",
        },
      ],
    });
    expect(outputs[0]!.source).toEqual(["produced_edge", "expected"]);
    expect(outputs[0]!.producedBy).toBe("agent");
  });

  it("orders outputs oldest first", () => {
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [
        artifact({ id: "a2", kind: "document", refId: DOC_B, createdAt: t(9) }),
        artifact({ id: "a1", kind: "document", refId: DOC_A, createdAt: t(2) }),
      ],
    });
    expect(outputs.map((o) => o.refId)).toEqual([DOC_A, DOC_B]);
  });
});

/**
 * Rule 3 — DECLARED LABEL. A person attaching an object they made by hand
 * leaves no proposal, so lineage cannot speak for them. Without an explicit
 * label claim the join could only ever put such an output on the FIRST declared
 * slot of its kind, which is wrong the moment two documents are declared.
 */
describe("joinSessionOutputs — declared label", () => {
  it("an artifact's expectedLabel claims THAT slot, not the first of its kind", () => {
    const { outputs, pendingExpected } = joinSessionOutputs({
      ...empty,
      artifacts: [
        artifact({
          kind: "document",
          refId: DOC_A,
          originKind: "user",
          expectedLabel: "Summary",
        }),
      ],
      expectedOutputs: [
        { kind: "document", label: "Spec" },
        { kind: "document", label: "Summary" },
      ],
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.expected!.label).toBe("Summary");
    expect(outputs[0]!.producedBy).toBe("human");
    expect(pendingExpected.map((e) => e.label)).toEqual(["Spec"]);
  });

  it("claiming a slot never stamps it done", () => {
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [
        artifact({ kind: "document", refId: DOC_A, expectedLabel: "Spec" }),
      ],
      expectedOutputs: [{ kind: "document", label: "Spec" }],
    });
    expect(outputs[0]!.expected).toEqual({ label: "Spec" });
    expect(outputs[0]!.expected!.status).toBeUndefined();
  });

  it("a label claim outranks the kind guess for a DIFFERENT object", () => {
    // DOC_A is older, so the kind fallback would have taken it for "Spec".
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [
        artifact({ kind: "document", refId: DOC_A, createdAt: t(1) }),
        artifact({
          kind: "document",
          refId: DOC_B,
          createdAt: t(2),
          expectedLabel: "Spec",
        }),
      ],
      expectedOutputs: [{ kind: "document", label: "Spec" }],
    });
    const spec = outputs.find((o) => o.expected?.label === "Spec");
    expect(spec!.refId).toBe(DOC_B);
  });

  it("a guess may not overrule a claim for a different slot", () => {
    const { outputs, pendingExpected } = joinSessionOutputs({
      ...empty,
      artifacts: [
        artifact({ kind: "document", refId: DOC_A, expectedLabel: "Nope" }),
      ],
      expectedOutputs: [{ kind: "document", label: "Spec" }],
    });
    // The artifact said it was "Nope"; letting the kind guess file it under
    // "Spec" anyway would make the claim inert and the report wrong.
    expect(outputs[0]!.expected).toBeUndefined();
    expect(pendingExpected.map((e) => e.label)).toEqual(["Spec"]);
  });

  it("proposal lineage still wins over a label claim", () => {
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [
        artifact({ kind: "document", refId: DOC_A, createdAt: t(1) }),
        artifact({
          kind: "document",
          refId: DOC_B,
          createdAt: t(2),
          expectedLabel: "Spec",
        }),
      ],
      expectedOutputs: [
        { kind: "document", label: "Spec", satisfiedByProposalId: PROPOSAL },
      ],
      proposals: [
        {
          id: PROPOSAL,
          targetType: "document",
          targetId: DOC_A,
          agentUserId: null,
        },
      ],
    });
    const spec = outputs.find((o) => o.expected?.label === "Spec");
    expect(spec!.refId).toBe(DOC_A);
  });
});

/**
 * `automation` and `playbook` joined the `artifacts.kind` enum in 0246. A
 * session whose whole point was "set up the follow-up rule" produced an
 * automation, and the ledger had no value to record it under.
 *
 * The join's coordinate is `normalizeObjectKind(kind):refId`, so what has to
 * hold is a ROUND TRIP: the kind the door wrote must survive normalization and
 * still key the live title `resolveTitles` looked up. A kind that normalized to
 * something else (the way `workflow` normalizes to `automation`) would produce
 * an output whose title silently fell back to the stored copy.
 */
describe("joinSessionOutputs — automation and playbook outputs", () => {
  const AUTOMATION = "55555555-5555-4555-8555-555555555555";
  const PLAYBOOK = "66666666-6666-4666-8666-666666666666";

  it("round-trips an automation artifact and takes its live name", () => {
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [
        artifact({ kind: "automation", refId: AUTOMATION, title: "Stale" }),
      ],
      // The key `resolveTitles` writes for `automations.name`.
      titles: new Map([[`automation:${AUTOMATION}`, "Renewal follow-up"]]),
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.kind).toBe("automation");
    expect(outputs[0]!.id).toBe(`automation:${AUTOMATION}`);
    expect(outputs[0]!.refId).toBe(AUTOMATION);
    expect(outputs[0]!.title).toBe("Renewal follow-up");
  });

  it("round-trips a playbook artifact and takes its live name", () => {
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [
        artifact({ kind: "playbook", refId: PLAYBOOK, title: "Stale" }),
      ],
      titles: new Map([[`playbook:${PLAYBOOK}`, "Client onboarding"]]),
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.kind).toBe("playbook");
    expect(outputs[0]!.id).toBe(`playbook:${PLAYBOOK}`);
    expect(outputs[0]!.refId).toBe(PLAYBOOK);
    expect(outputs[0]!.title).toBe("Client onboarding");
  });

  it("collapses an automation artifact and a `produced` edge naming it", () => {
    // The edge ledger writes `toType` from a different vocabulary — `workflow`
    // normalizes onto `automation`, so both must land on ONE output rather than
    // two rows for the same rule.
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [artifact({ kind: "automation", refId: AUTOMATION })],
      produced: [{ toType: "workflow", toId: AUTOMATION, createdAt: t(5) }],
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.source).toEqual(["artifact", "produced_edge"]);
  });

  it("satisfies a declared automation slot by id join", () => {
    const { outputs } = joinSessionOutputs({
      ...empty,
      artifacts: [artifact({ kind: "automation", refId: AUTOMATION })],
      expectedOutputs: [{ kind: "automation", label: "The rule" }],
    });
    const slot = outputs.find((o) => o.expected?.label === "The rule");
    expect(slot!.refId).toBe(AUTOMATION);
  });
});
