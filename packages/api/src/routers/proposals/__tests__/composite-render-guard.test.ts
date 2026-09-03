/**
 * The composite REFUSAL GUARD — a composite proposal whose ops the review
 * pipeline cannot fully render is refused, never silently half-rendered.
 *
 * `CompositeProposalOperation` has five arms; `buildProposalGraph` renders two
 * and `ProposalReviewGraph` can carry only those two. An unrendered op would
 * reach the reviewer INVISIBLY and — `applyGraphDispositions` keeps every op it
 * does not recognise — apply UNDENIABLY on approval. `create_skill` /
 * `create_automation` / `create_rule` are BEHAVIOUR: once approved they persist
 * and act on their own.
 *
 * These tests drive the REAL renderer (`buildProposalGraph`), not the guard
 * helper in isolation, so they also pin that the guard's evidence set is
 * populated by the render passes themselves.
 */

import { describe, it, expect } from "vitest";
import { buildProposalGraph } from "../display.js";
import type {
  CompositeProposalData,
  CompositeProposalOperation,
} from "@synap-core/types/proposals";

const entityOp = (ref: string, title: string): CompositeProposalOperation => ({
  op: "create_entity",
  ref,
  profileSlug: "person",
  title,
});

const composite = (
  operations: CompositeProposalOperation[]
): CompositeProposalData => ({ operations });

describe("buildProposalGraph — refusal guard", () => {
  it("is a NO-OP for the only op kinds real traffic carries (entity + relation)", () => {
    const graph = buildProposalGraph(
      composite([
        entityOp("a", "Ada"),
        entityOp("b", "Acme"),
        {
          op: "create_relation",
          sourceRef: "a",
          targetRef: "b",
          type: "works_at",
        },
      ])
    );
    expect(graph.entityCount).toBe(2);
    expect(graph.relationCount).toBe(1);
  });

  it("is a NO-OP for an empty composite and for an entity-only composite", () => {
    expect(buildProposalGraph(composite([])).entityCount).toBe(0);
    expect(
      buildProposalGraph(composite([entityOp("a", "Ada")])).entityCount
    ).toBe(1);
  });

  for (const risky of [
    { op: "create_skill", ref: "f1", name: "Fact", body: "x", scope: "pod" },
    {
      op: "create_automation",
      ref: "b1",
      name: "Behaviour",
      triggerType: "event",
      flowDefinition: {},
    },
    { op: "create_rule", ref: "r1", intent: "always", scope: { kind: "pod" } },
  ] as CompositeProposalOperation[]) {
    it(`REFUSES a composite hiding a ${risky.op} op inside benign members`, () => {
      const call = () =>
        buildProposalGraph(
          composite([
            entityOp("a", "Ada"),
            risky,
            {
              op: "create_relation",
              sourceRef: "a",
              targetRef: "a",
              type: "knows",
            },
          ])
        );
      expect(call).toThrow(risky.op);
      // Legible to the operator: what was unrenderable, WHERE it sat, and what
      // to extend. Never a bare error.
      expect(call).toThrow(/operation #1/);
      expect(call).toThrow(/buildProposalGraph/);
      expect(call).toThrow(/ProposalReviewGraph/);
    });
  }

  it("names EVERY unrendered op, not just the first", () => {
    const call = () =>
      buildProposalGraph(
        composite([
          entityOp("a", "Ada"),
          { op: "create_skill", ref: "f1", name: "F", body: "x", scope: "pod" },
          {
            op: "create_automation",
            ref: "b1",
            name: "B",
            triggerType: "event",
            flowDefinition: {},
          },
        ] as CompositeProposalOperation[])
      );
    expect(call).toThrow(/create_skill/);
    expect(call).toThrow(/create_automation/);
  });
});
