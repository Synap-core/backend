/**
 * The RULE object's pure half: metadata shape, flow hashing, and DIVERGENCE
 * DETECTION.
 *
 * The rule is the SOURCE; the automation is DERIVED. Editing a produced
 * automation directly must not silently rewrite the rule — so the rule stores
 * a hash of the flowDefinition it produced and a reader COMPARES. Detection
 * only; nothing here reconciles.
 */

import { describe, it, expect } from "vitest";
import {
  buildRuleMetadata,
  detectRuleDivergence,
  hashFlowDefinition,
  readRuleMetadata,
  ruleNameFromIntent,
  RULE_METADATA_KEY,
} from "./index.js";

const FLOW = { nodes: [{ id: "a", type: "log" }], edges: [] };

/** Minimal chainable stand-in for the drizzle select used by the detector. */
function fakeDb(rows: Array<{ id: string; flowDefinition: unknown }>) {
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
  } as never;
}

describe("flow hashing", () => {
  it("is stable across key order (a re-serialised flow is not divergence)", () => {
    expect(hashFlowDefinition({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(
      hashFlowDefinition({ b: [2, { d: 4, c: 3 }], a: 1 })
    );
  });

  it("changes when the flow actually changes", () => {
    expect(hashFlowDefinition(FLOW)).not.toBe(
      hashFlowDefinition({ ...FLOW, nodes: [{ id: "a", type: "http" }] })
    );
  });
});

describe("rule metadata", () => {
  it("round-trips through the skills.metadata blob", () => {
    const metadata = buildRuleMetadata({
      intent: "One subfolder per client.",
      scope: { kind: "workspace", workspaceId: "ws-1", projectId: "proj-1" },
      expiresAt: "2027-01-01T00:00:00.000Z",
      factSkillId: "skill-1",
      behaviours: [{ automationId: "auto-1", flowHash: "abc" }],
    });
    const read = readRuleMetadata({ [RULE_METADATA_KEY]: metadata });
    expect(read).toEqual(metadata);
  });

  /**
   * `trust` was removed: it looked like authorization and granted nothing
   * (`governance_rules` is the real store). Rows written before the removal
   * still carry it — reading one must not crash and must not resurrect it.
   */
  it("tolerates a legacy `trust` key on a stored blob without surfacing it", () => {
    const read = readRuleMetadata({
      [RULE_METADATA_KEY]: { intent: "x", trust: "auto" },
    });
    expect(read).not.toBeNull();
    expect(read).not.toHaveProperty("trust");
    expect(read?.intent).toBe("x");
  });

  it("absent expiresAt means NO expiry — never 'expired'", () => {
    const metadata = buildRuleMetadata({
      intent: "x",
      scope: { kind: "pod" },
      behaviours: [],
    });
    expect(metadata.expiresAt).toBeUndefined();
    expect(
      readRuleMetadata({ [RULE_METADATA_KEY]: { intent: "x" } })?.expiresAt
    ).toBeUndefined();
  });

  it("normalises expiresAt to canonical ISO-8601 UTC (the form SQL compares)", () => {
    expect(
      buildRuleMetadata({
        intent: "x",
        scope: { kind: "pod" },
        expiresAt: "2027-03-01T12:00:00+02:00",
        behaviours: [],
      }).expiresAt
    ).toBe("2027-03-01T10:00:00.000Z");
  });

  it("REFUSES a non-instant expiry at the write door rather than storing it", () => {
    expect(() =>
      buildRuleMetadata({
        intent: "x",
        scope: { kind: "pod" },
        expiresAt: "next tuesday",
        behaviours: [],
      })
    ).toThrow(/not a valid instant/);
  });

  it("an unreadable stored expiry reads as absent — a read door never throws", () => {
    expect(
      readRuleMetadata({
        [RULE_METADATA_KEY]: { intent: "x", expiresAt: "next tuesday" },
      })?.expiresAt
    ).toBeUndefined();
  });

  it("carries the cross-cutting projectId, and drops a non-string one", () => {
    expect(
      readRuleMetadata({
        [RULE_METADATA_KEY]: {
          intent: "x",
          scope: { kind: "workspace", workspaceId: "ws", projectId: "p" },
        },
      })?.scope
    ).toEqual({ kind: "workspace", workspaceId: "ws", projectId: "p" });
    expect(
      readRuleMetadata({
        [RULE_METADATA_KEY]: {
          intent: "x",
          scope: { kind: "pod", projectId: 7 },
        },
      })?.scope
    ).toEqual({ kind: "pod" });
  });

  it("returns null for a skills row that is not a rule", () => {
    expect(readRuleMetadata(null)).toBeNull();
    expect(readRuleMetadata({})).toBeNull();
    expect(
      readRuleMetadata({ [RULE_METADATA_KEY]: { nope: true } })
    ).toBeNull();
  });

  it("names a rule from its intent", () => {
    expect(ruleNameFromIntent("  One subfolder per client.\nmore ")).toBe(
      "One subfolder per client."
    );
    expect(ruleNameFromIntent("x".repeat(200))).toHaveLength(78);
  });
});

describe("divergence detection", () => {
  const metadata = buildRuleMetadata({
    intent: "One subfolder per client.",
    scope: { kind: "pod" },
    behaviours: [
      { automationId: "auto-1", flowHash: hashFlowDefinition(FLOW) },
    ],
  });

  it("reports no divergence while the automation still matches", async () => {
    const result = await detectRuleDivergence(
      ["auto-1"],
      metadata,
      fakeDb([{ id: "auto-1", flowDefinition: FLOW }])
    );
    expect(result.diverged).toBe(false);
    expect(result.behaviours[0]?.status).toBe("matches");
  });

  it("DETECTS that a directly-edited automation no longer matches its rule", async () => {
    const edited = {
      ...FLOW,
      nodes: [...FLOW.nodes, { id: "b", type: "http" }],
    };
    const result = await detectRuleDivergence(
      ["auto-1"],
      metadata,
      fakeDb([{ id: "auto-1", flowDefinition: edited }])
    );
    expect(result.diverged).toBe(true);
    expect(result.behaviours[0]?.status).toBe("diverged");
    // Detection only — the rule's recorded hash is untouched by the reader.
    expect(result.behaviours[0]?.flowHash).toBe(hashFlowDefinition(FLOW));
  });

  it("reports a deleted automation as missing, not as a match", async () => {
    const result = await detectRuleDivergence(["auto-1"], metadata, fakeDb([]));
    expect(result.diverged).toBe(true);
    expect(result.behaviours[0]?.status).toBe("missing");
  });

  it("a rule with NO ACTIVATES EDGE never reads as diverged", async () => {
    const result = await detectRuleDivergence(
      [],
      buildRuleMetadata({
        intent: "x",
        scope: { kind: "pod" },
        behaviours: [],
      }),
      fakeDb([])
    );
    expect(result).toEqual({ diverged: false, behaviours: [] });
  });

  it("MEMBERSHIP is the edge, not behaviours[] — a snapshot the edge does not name is ignored", async () => {
    // The JSONB copy still lists `auto-1`, but the edge says the rule activates
    // nothing. The edge wins: this is the whole point of R4.
    const result = await detectRuleDivergence(
      [],
      metadata,
      fakeDb([{ id: "auto-1", flowDefinition: FLOW }])
    );
    expect(result).toEqual({ diverged: false, behaviours: [] });
  });

  it("an edge with no recorded snapshot is UNSNAPSHOTTED, never a silent match", async () => {
    const result = await detectRuleDivergence(
      ["auto-2"],
      metadata,
      fakeDb([{ id: "auto-2", flowDefinition: FLOW }])
    );
    expect(result.diverged).toBe(true);
    expect(result.behaviours[0]?.status).toBe("unsnapshotted");
    expect(result.behaviours[0]?.flowHash).toBeNull();
  });
});
