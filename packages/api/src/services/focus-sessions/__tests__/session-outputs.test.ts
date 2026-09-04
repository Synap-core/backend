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
