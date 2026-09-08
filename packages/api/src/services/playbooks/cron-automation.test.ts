import { describe, it, expect } from "vitest";
import { buildPlaybookRunFlowDefinition } from "./cron-automation.js";
import { normalizePlaybookScheduleMode } from "@synap/playbooks";

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

/**
 * APPOINTMENT MODE — `schedule.mode` reaches the flow node.
 *
 * The seam that matters: the stored `schedule.mode` is what the user expressed,
 * the node's `mode` is what the executor branches on, and NOTHING between them
 * is typed (the `schedule` column is JSONB, the node `data` is a bag). A mode
 * that never lands on the node is an appointment schedule that silently runs an
 * agent — the exact "declared on the wire, populated by nobody" defect this
 * repo keeps paying for. So assert the VALUE arrives, in both flow shapes.
 */
describe("buildPlaybookRunFlowDefinition — appointment mode", () => {
  it('mode:"appointment" lands on the single playbook_run node', () => {
    const flow = buildPlaybookRunFlowDefinition("pb-3", {
      playbookName: "Weekly review",
      mode: "appointment",
    });
    expect(flow.nodes).toHaveLength(1);
    expect((flow.nodes[0].data as { mode?: string }).mode).toBe("appointment");
  });

  it('mode:"appointment" also lands on the LOOP-BODY node of a kind fan-out', () => {
    // A kind-bound appointment schedule ("a review session per client, every
    // Monday") emits query → loop → playbook_run. The mode has to reach the
    // BODY node; landing it only on the single-node shape would make every
    // per-entity appointment run an agent instead.
    const flow = buildPlaybookRunFlowDefinition("pb-4", {
      playbookName: "Client review",
      subjectProfile: { profileSlug: "client" },
      mode: "appointment",
    });
    const run = flow.nodes.find((n) => n.type === "playbook_run");
    expect(run).toBeDefined();
    expect((run!.data as { mode?: string }).mode).toBe("appointment");
    // …and the subject binding survives alongside it.
    expect(
      (run!.data as { paramsMapping?: Record<string, string> }).paramsMapping
        ?.entityId
    ).toBe("{{loop.item.id}}");
  });

  it('absent / "run" mode emits NO `mode` key at all (byte-identical to pre-feature nodes)', () => {
    // Every flow definition already stored was written without this key. A
    // default-stamped `mode:"run"` would make every reconcile see drift and
    // rewrite rows that did not change.
    const bare = buildPlaybookRunFlowDefinition("pb-5", { playbookName: "X" });
    expect(Object.keys(bare.nodes[0].data as object)).not.toContain("mode");
    const explicit = buildPlaybookRunFlowDefinition("pb-6", {
      playbookName: "X",
      mode: "run",
    });
    expect(Object.keys(explicit.nodes[0].data as object)).not.toContain("mode");
  });
});

describe("normalizePlaybookScheduleMode — the ONE decision about an unknown mode", () => {
  it('only the exact string "appointment" opts in; everything else is a run', () => {
    expect(normalizePlaybookScheduleMode("appointment")).toBe("appointment");
    // The JSONB column can hold anything a hand-edit or an older client wrote.
    // Every one of these must fall to "run" — failing OPEN here would turn a
    // typo into "stop dispatching the agent", a silent stoppage.
    for (const bad of [
      undefined,
      null,
      "",
      "run",
      "Appointment",
      "appointments",
      42,
      {},
      ["appointment"],
    ]) {
      expect(normalizePlaybookScheduleMode(bad)).toBe("run");
    }
  });
});
