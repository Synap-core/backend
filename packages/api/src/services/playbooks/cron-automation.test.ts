import { describe, it, expect } from "vitest";
import { buildPlaybookRunFlowDefinition } from "./cron-automation.js";

/**
 * W2 (radar kind-fan-out): a scheduled playbook with a `subjectProfile`
 * materializes as `query → loop → playbook_run` (scan every entity of the kind,
 * run once per entity), instead of a single run. Pure-function test of the flow
 * SHAPE — the executor's node semantics are covered separately.
 */
describe("buildPlaybookRunFlowDefinition", () => {
  it("no subjectProfile → a SINGLE playbook_run node (unchanged)", () => {
    const flow = buildPlaybookRunFlowDefinition("pb-1", {
      playbookName: "Weekly digest",
    });
    expect(flow.nodes).toHaveLength(1);
    expect(flow.nodes[0].type).toBe("playbook_run");
    expect(flow.edges).toHaveLength(0);
    // No subject binding was injected.
    const data = flow.nodes[0].data as { paramsMapping?: unknown };
    expect(data.paramsMapping).toBeUndefined();
  });

  it("with subjectProfile → query → loop → playbook_run fan-out", () => {
    const flow = buildPlaybookRunFlowDefinition("pb-2", {
      playbookName: "Competitor radar",
      subjectProfile: { profileSlug: "competitor" },
    });

    const byType = Object.fromEntries(flow.nodes.map((n) => [n.type, n]));
    expect(Object.keys(byType).sort()).toEqual([
      "loop",
      "playbook_run",
      "query",
    ]);

    // Query lists the kind, capped by the executor (limit 100).
    expect((byType.query.data as { profileSlug: string }).profileSlug).toBe(
      "competitor"
    );

    // Loop iterates the query's output via the canonical step path.
    expect(
      (byType.loop.data as { iteratorExpression: string }).iteratorExpression
    ).toBe("steps.radar-query.output.entities");

    // The run binds the iterated entity as its subject.
    expect(
      (byType.playbook_run.data as { paramsMapping: Record<string, string> })
        .paramsMapping.entityId
    ).toBe("{{loop.item.id}}");

    // Wired query → loop → run.
    const edgePairs = flow.edges.map((e) => `${e.source}->${e.target}`).sort();
    expect(edgePairs).toEqual([
      "radar-loop->playbook-run",
      "radar-query->radar-loop",
    ]);
  });

  it("carries the subjectProfile.filter through to the query node", () => {
    const flow = buildPlaybookRunFlowDefinition("pb-3", {
      subjectProfile: { profileSlug: "lead", filter: '{"status":"active"}' },
    });
    const query = flow.nodes.find((n) => n.type === "query");
    expect((query?.data as { filter: string }).filter).toBe(
      '{"status":"active"}'
    );
  });

  it("preserves caller paramsMapping and adds the subject binding", () => {
    const flow = buildPlaybookRunFlowDefinition("pb-4", {
      paramsMapping: { region: "EU" },
      subjectProfile: { profileSlug: "competitor" },
    });
    const run = flow.nodes.find((n) => n.type === "playbook_run");
    const pm = (run?.data as { paramsMapping: Record<string, string> })
      .paramsMapping;
    expect(pm.region).toBe("EU");
    expect(pm.entityId).toBe("{{loop.item.id}}");
  });

  it("empty/whitespace profileSlug is treated as no subject (single node)", () => {
    const flow = buildPlaybookRunFlowDefinition("pb-5", {
      subjectProfile: { profileSlug: "   " },
    });
    expect(flow.nodes).toHaveLength(1);
    expect(flow.nodes[0].type).toBe("playbook_run");
  });
});
