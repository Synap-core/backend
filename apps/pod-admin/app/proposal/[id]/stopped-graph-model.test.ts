import { describe, expect, it } from "vitest";
import { proposalPageT } from "./copy";
import {
  kindMissingLine,
  stoppedGraphReport,
  stoppedHeader,
} from "./stopped-graph-model";

/**
 * The pod's record of a graph that stopped part-way, in the shape
 * `runMaterializationUnderReceipt` stamps it (`buildStoppedRunRecord`), for
 * the live case of proposal e8fc00d6: an existing audience linked, three pain
 * points filed, the trend refused (its kind lives in Ecosystem), the six
 * links never tried.
 */
const DATA = {
  operations: [
    { op: "create_entity", ref: "aud", title: "aud", existingEntityId: "a-1" },
    { op: "create_entity", ref: "p1", title: "Stale facts kept" },
    { op: "create_entity", ref: "p2", title: "Deletes leak" },
    { op: "create_entity", ref: "p3", title: "No portable memory" },
    { op: "create_entity", ref: "t", title: "Users demand deletion" },
    {
      op: "create_relation",
      sourceRef: "p1",
      targetRef: "aud",
      type: "relates_to",
    },
  ],
  materialized: {
    entityIds: ["e-1", "e-2", "e-3"],
    opCount: 6,
    byOp: {
      aud: { op: "create_entity", entityId: "a-1", linked: true },
      p1: { op: "create_entity", entityId: "e-1", linked: false },
      p2: { op: "create_entity", entityId: "e-2", linked: false },
      p3: { op: "create_entity", entityId: "e-3", linked: false },
    },
    failedOp: {
      key: "t",
      opIndex: 4,
      op: "create_entity",
      title: "Users demand deletion",
      reason:
        "Couldn't file it — the kind \"Trend\" isn't available in Foundation.",
      errorClass: "kind_missing",
    },
    notRun: [{ key: "p1->aud:relates_to", opIndex: 5, op: "create_relation" }],
    skipped: [],
  },
  failure: {
    errorClass: "kind_missing",
    kindMissing: {
      profileSlug: "trend",
      kindName: "Trend",
      workspaceId: "ws-f",
      workspaceName: "Foundation",
      foundIn: [{ workspaceId: "ws-e", name: "Ecosystem" }],
    },
  },
};
/** The pod's review graph resolves the linked record's real title. */
const GRAPH = {
  entities: [{ ref: "aud", title: "BYOA technical operators" }],
};

describe("stoppedGraphReport", () => {
  const t = proposalPageT();

  it("says how many items were filed, could not be, and were never tried", () => {
    const report = stoppedGraphReport({ data: DATA, graph: GRAPH })!;
    expect(report).not.toBeNull();
    expect(stoppedHeader(report, t)).toBe(
      "4 of 6 items filed · 1 could not be filed · 1 not tried"
    );
  });

  it("lists the filed records by title, linkable, the linked one by its real title", () => {
    const report = stoppedGraphReport({ data: DATA, graph: GRAPH })!;
    expect(report.landed).toEqual([
      {
        key: "aud",
        label: "BYOA technical operators",
        entityId: "a-1",
        linked: true,
      },
      { key: "p1", label: "Stale facts kept", entityId: "e-1" },
      { key: "p2", label: "Deletes leak", entityId: "e-2" },
      { key: "p3", label: "No portable memory", entityId: "e-3" },
    ]);
    expect(report.failed).toMatchObject({
      key: "t",
      label: "Users demand deletion",
    });
    expect(report.notRun).toEqual([
      {
        key: "p1->aud:relates_to",
        label: "Stale facts kept → BYOA technical operators",
      },
    ]);
  });

  it("names the kind, the space and where it exists", () => {
    const report = stoppedGraphReport({ data: DATA, graph: GRAPH })!;
    expect(kindMissingLine(report.kindMissing!, t)).toBe(
      "Kind “Trend” isn’t available in Foundation. It exists in Ecosystem."
    );
    expect(
      kindMissingLine(
        {
          kind: "Trend",
          space: "Foundation",
          elsewhere: ["Ecosystem", "Lab", "Studio"],
        },
        t
      )
    ).toBe(
      "Kind “Trend” isn’t available in Foundation. It exists in Ecosystem, Lab and Studio."
    );
    expect(kindMissingLine({ kind: "trend", elsewhere: [] }, t)).toBe(
      "Kind “trend” isn’t available in this space. No other space you can see has it either."
    );
  });

  it("is absent for a failure that is not a stopped graph", () => {
    // The placeholder a receipt is inserted with, and an older failed row.
    expect(
      stoppedGraphReport({ data: { materialized: { entityIds: [] } } })
    ).toBeNull();
    expect(stoppedGraphReport({ data: null })).toBeNull();
  });
});
