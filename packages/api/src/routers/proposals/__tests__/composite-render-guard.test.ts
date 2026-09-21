/**
 * The composite REFUSAL GUARD — a composite proposal whose ops the review
 * pipeline cannot fully render is refused, never silently half-rendered.
 *
 * An unrendered op would reach the reviewer INVISIBLY and —
 * `applyGraphDispositions` keeps every op it does not recognise — apply
 * UNDENIABLY on approval.
 *
 * 2026-09-21: `create_skill` / `create_automation` / `create_rule` are now
 * RENDERED (`buildConfigReviewItems`), so the guard no longer fires on them.
 * It used to, and that was correct WHILE nothing produced them. Once
 * `synap_capture` gained `skills[]` / `automations[]` / `rules[]` a real
 * producer existed, and the refusal stopped protecting anyone: the proposal
 * was filed, counted against the agent's cap, and then threw for the WHOLE
 * `proposals.list` page — unreadable and unapprovable. These tests therefore
 * pin BOTH halves: the three arms render with their VALUES, and the guard
 * still refuses a genuinely unrendered arm (the last test, which fabricates
 * one — do not delete it, it is the only remaining proof the guard bites).
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

  it("RENDERS a create_skill op, body excerpt included", () => {
    const graph = buildProposalGraph(
      composite([
        entityOp("a", "Ada"),
        {
          op: "create_skill",
          ref: "f1",
          name: "Nudge policy",
          body: "Always mention the renewal date.",
          scope: "pod",
        },
      ] as CompositeProposalOperation[])
    );
    // Reachability, not shape: the reviewer must SEE the fact they consent to.
    expect(graph.skills).toHaveLength(1);
    expect(graph.skills![0]!.name).toBe("Nudge policy");
    expect(graph.skills![0]!.bodyExcerpt).toBe(
      "Always mention the renewal date."
    );
    expect(graph.skills![0]!.bodyTruncated).toBe(false);
    expect(graph.entityCount).toBe(1);
  });

  it("truncates a long skill body and SAYS so", () => {
    const long = "x".repeat(400);
    const graph = buildProposalGraph(
      composite([
        { op: "create_skill", ref: "f1", name: "F", body: long, scope: "pod" },
      ] as CompositeProposalOperation[])
    );
    expect(graph.skills![0]!.bodyTruncated).toBe(true);
    expect(graph.skills![0]!.bodyExcerpt.length).toBeLessThan(long.length);
  });

  it("RENDERS a create_automation op as born-inert", () => {
    const graph = buildProposalGraph(
      composite([
        {
          op: "create_automation",
          ref: "b1",
          name: "Daily nudge",
          triggerType: "cron",
          flowDefinition: {},
          // A producer may STATE enabled:true; materialization forces false.
          enabled: true,
        },
      ] as CompositeProposalOperation[])
    );
    expect(graph.automations).toHaveLength(1);
    expect(graph.automations![0]!.name).toBe("Daily nudge");
    expect(graph.automations![0]!.triggerType).toBe("cron");
    // The surface must be able to tell the reviewer it does NOT start firing.
    expect(graph.automations![0]!.bornEnabled).toBe(false);
  });

  it("RENDERS a create_rule op with its intent and both halves", () => {
    const graph = buildProposalGraph(
      composite([
        { op: "create_skill", ref: "f1", name: "F", body: "b", scope: "pod" },
        {
          op: "create_automation",
          ref: "b1",
          name: "B",
          triggerType: "event",
          flowDefinition: {},
        },
        {
          op: "create_rule",
          ref: "r1",
          intent: "Always nudge before a renewal",
          scope: { kind: "pod" },
          factRef: "f1",
          behaviourRefs: ["b1"],
        },
      ] as CompositeProposalOperation[])
    );
    expect(graph.rules).toHaveLength(1);
    expect(graph.rules![0]!.intent).toBe("Always nudge before a renewal");
    expect(graph.rules![0]!.factRef).toBe("f1");
    expect(graph.rules![0]!.behaviourRefs).toEqual(["b1"]);
  });

  it("renders config ops with NO plan op present (isPlan stays absent)", () => {
    // The regression this guards: `buildPlanReviewGraph` early-returns for a
    // non-plan batch, so config had to render OUTSIDE that guard or a
    // config-only composite would still throw.
    const graph = buildProposalGraph(
      composite([
        { op: "create_skill", ref: "f1", name: "F", body: "b", scope: "pod" },
      ] as CompositeProposalOperation[])
    );
    expect(graph.skills).toHaveLength(1);
    expect(graph.isPlan).toBeUndefined();
  });

  it("STILL refuses a genuinely unrendered op arm", () => {
    // Every real arm renders today, so the only way to exercise the guard is a
    // fabricated future arm. If someone adds an arm to the union and forgets
    // `buildProposalGraph`, THIS is the shape of the failure they will get —
    // and the compile-time floors in `@synap-core/types/proposals` plus the
    // `gate-pair-derived-from-operations` tripwire are what make them notice.
    const future = {
      op: "create_dashboard",
      ref: "d1",
    } as unknown as CompositeProposalOperation;
    const call = () =>
      buildProposalGraph(composite([entityOp("a", "Ada"), future]));
    expect(call).toThrow(/create_dashboard/);
    expect(call).toThrow(/operation #1/);
    expect(call).toThrow(/buildProposalGraph/);
    expect(call).toThrow(/ProposalReviewGraph/);
  });
});
