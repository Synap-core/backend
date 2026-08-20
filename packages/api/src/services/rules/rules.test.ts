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
      scope: { kind: "workspace", workspaceId: "ws-1" },
      trust: "auto",
      factSkillId: "skill-1",
      behaviours: [{ automationId: "auto-1", flowHash: "abc" }],
    });
    const read = readRuleMetadata({ [RULE_METADATA_KEY]: metadata });
    expect(read).toEqual(metadata);
  });

  it("defaults trust to propose — a rule never widens by omission", () => {
    const metadata = buildRuleMetadata({
      intent: "x",
      scope: { kind: "pod" },
      behaviours: [],
    });
    expect(metadata.trust).toBe("propose");
    expect(
      readRuleMetadata({ [RULE_METADATA_KEY]: { intent: "x", trust: "yes" } })
        ?.trust
    ).toBe("propose");
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
      metadata,
      fakeDb([{ id: "auto-1", flowDefinition: edited }])
    );
    expect(result.diverged).toBe(true);
    expect(result.behaviours[0]?.status).toBe("diverged");
    // Detection only — the rule's recorded hash is untouched by the reader.
    expect(result.behaviours[0]?.flowHash).toBe(hashFlowDefinition(FLOW));
  });

  it("reports a deleted automation as missing, not as a match", async () => {
    const result = await detectRuleDivergence(metadata, fakeDb([]));
    expect(result.diverged).toBe(true);
    expect(result.behaviours[0]?.status).toBe("missing");
  });

  it("a rule with no behaviours never reads as diverged", async () => {
    const result = await detectRuleDivergence(
      buildRuleMetadata({
        intent: "x",
        scope: { kind: "pod" },
        behaviours: [],
      }),
      fakeDb([])
    );
    expect(result).toEqual({ diverged: false, behaviours: [] });
  });
});
