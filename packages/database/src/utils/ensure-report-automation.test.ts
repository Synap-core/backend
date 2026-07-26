/**
 * Structural validation of THE report automation's flow definition.
 *
 * This is a DEFINITION test, not a runtime test: it proves the graph the seeder
 * writes is walkable by the executor (unique ids, resolvable edges, acyclic, no
 * forward references) and that every contract the flow leans on is spelled the way
 * the engine spells it. It cannot prove the model produces good markdown — only a
 * real run can. Same spirit as `define.flow-automations.test.ts` in
 * @synap-core/workspace-templates, which asserts the authored template lands in the
 * wire shape the apply door expects.
 */

import { describe, expect, it } from "vitest";
import {
  REPORT_AUTOMATION_FLOW,
  REPORT_AUTOMATION_NAME,
} from "./ensure-report-automation.js";

const { nodes, edges } = REPORT_AUTOMATION_FLOW;

/** Kahn's algorithm — the SAME ordering the executor's `topoSort` performs. */
function topoOrder(): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adjacency.set(n.id, []);
  }
  for (const e of edges) {
    adjacency.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }
  const queue = [...inDegree].filter(([, d]) => d === 0).map(([id]) => id);
  const sorted: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    sorted.push(id);
    for (const t of adjacency.get(id) ?? []) {
      const d = (inDegree.get(t) ?? 1) - 1;
      inDegree.set(t, d);
      if (d === 0) queue.push(t);
    }
  }
  return sorted;
}

/** Every `{{steps.X...}}` reference in a node's data, as node ids. */
function referencedStepIds(node: (typeof nodes)[number]): string[] {
  const json = JSON.stringify(node.data ?? {});
  const found = new Set<string>();
  for (const m of json.matchAll(/\{\{steps\.([A-Za-z0-9_-]+)\./g)) {
    found.add(m[1]);
  }
  return [...found];
}

describe("report automation flow definition", () => {
  it("has a stable name and a manual trigger", () => {
    expect(REPORT_AUTOMATION_NAME).toBe("Generate report");
    const trigger = nodes.find((n) => n.type === "trigger");
    expect(trigger).toBeDefined();
    expect((trigger!.data as { triggerType: string }).triggerType).toBe(
      "manual"
    );
    // Exactly one trigger, and it is the only source-less node.
    expect(nodes.filter((n) => n.type === "trigger")).toHaveLength(1);
    const targets = new Set(edges.map((e) => e.target));
    expect(nodes.filter((n) => !targets.has(n.id)).map((n) => n.id)).toEqual([
      "trigger",
    ]);
  });

  it("has unique node ids and unique edge ids", () => {
    const nodeIds = nodes.map((n) => n.id);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    const edgeIds = edges.map((e) => e.id);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
  });

  it("has no edge referencing a non-existent node", () => {
    const nodeIds = new Set(nodes.map((n) => n.id));
    const dangling = edges.filter(
      (e) => !nodeIds.has(e.source) || !nodeIds.has(e.target)
    );
    expect(dangling).toEqual([]);
  });

  it("is topologically sortable — every node ordered, no cycle", () => {
    // Kahn drops nodes stuck in a cycle, so a short result IS the cycle detector
    // (the executor fails LOUD on exactly this condition).
    expect(topoOrder()).toHaveLength(nodes.length);
  });

  it("has no orphan node — every non-trigger node is reachable", () => {
    const adjacency = new Map<string, string[]>();
    for (const n of nodes) adjacency.set(n.id, []);
    for (const e of edges) adjacency.get(e.source)!.push(e.target);
    const seen = new Set<string>(["trigger"]);
    const stack = ["trigger"];
    while (stack.length) {
      for (const t of adjacency.get(stack.pop()!) ?? []) {
        if (!seen.has(t)) {
          seen.add(t);
          stack.push(t);
        }
      }
    }
    expect(nodes.filter((n) => !seen.has(n.id)).map((n) => n.id)).toEqual([]);
  });

  it("never references a step that does not strictly precede it", () => {
    const order = topoOrder();
    const rank = new Map(order.map((id, i) => [id, i]));
    const violations: string[] = [];
    for (const node of nodes) {
      for (const ref of referencedStepIds(node)) {
        if (!rank.has(ref)) {
          violations.push(`${node.id} references unknown step "${ref}"`);
        } else if (rank.get(ref)! >= rank.get(node.id)!) {
          violations.push(
            `${node.id} references "${ref}" which does not precede it`
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("runs its AI rounds on ai.generate only — no command / playbook_run nodes", () => {
    // `command` nodes are broken end-to-end (404) and `playbook_run` is
    // fire-and-forget (never returns output into steps.*). Neither can carry a round.
    expect(nodes.some((n) => n.type === "command")).toBe(false);
    expect(nodes.some((n) => n.type === "playbook_run")).toBe(false);

    const aiNodes = nodes.filter((n) => n.type === "capability");
    expect(aiNodes.map((n) => n.id)).toEqual([
      "analyze",
      "relate",
      "assemble",
      "summarize",
    ]);
    for (const n of aiNodes) {
      const data = n.data as {
        verbId?: string;
        inputMapping?: Record<string, string>;
      };
      expect(data.verbId).toBe("ai.generate");
      expect(data.inputMapping?.system).toBeTruthy();
      expect(data.inputMapping?.prompt).toBeTruthy();
      // `ai.generate`'s zod schema caps maxTokens at 2000.
      expect(Number(data.inputMapping?.maxTokens)).toBeLessThanOrEqual(2000);
      expect(Number(data.inputMapping?.maxTokens)).toBeGreaterThan(0);
    }
  });

  it("gathers deterministically — no AI in the gather stage", () => {
    const gathers = nodes.filter((n) => n.id.startsWith("gather-"));
    expect(gathers).toHaveLength(4);
    expect(gathers.every((n) => n.type === "query")).toBe(true);
    expect(
      gathers.map((n) => (n.data as { profileSlug: string }).profileSlug)
    ).toEqual(["task", "note", "person", "company"]);
  });

  it("lets interpretation rounds degrade but fails fast on the assembler", () => {
    const errorHandling = (id: string) =>
      (
        nodes.find((n) => n.id === id)!.data as {
          errorHandling?: { continueOnError?: boolean };
        }
      ).errorHandling;

    // A failed round must become a VISIBLE GAP, not an aborted run.
    expect(errorHandling("analyze")?.continueOnError).toBe(true);
    expect(errorHandling("relate")?.continueOnError).toBe(true);
    // No body → no report. Default fail-fast is intentional here.
    expect(errorHandling("assemble")?.continueOnError).toBeUndefined();
  });

  it("fails closed before writing — a guard precedes the entity_create", () => {
    const order = topoOrder();
    const guard = nodes.find((n) => n.type === "guard");
    expect(guard).toBeDefined();
    expect(order.indexOf(guard!.id)).toBeLessThan(
      order.indexOf("create-report")
    );
    const paths = (
      guard!.data as { checks: Array<{ path: string; message: string }> }
    ).checks;
    expect(paths.map((c) => c.path)).toEqual([
      "steps.assemble.output",
      "steps.assemble.output.error",
    ]);
    // Every guard check must carry an actionable message.
    expect(paths.every((c) => c.message.length > 0)).toBe(true);
  });

  it("writes a report entity whose body is the assembler output", () => {
    const out = nodes.find((n) => n.id === "create-report")!;
    const data = out.data as {
      outputType: string;
      config: {
        profileSlug: string;
        title: string;
        body: string;
        properties: Record<string, unknown>;
      };
    };
    expect(out.type).toBe("output");
    expect(data.outputType).toBe("entity_create");
    expect(data.config.profileSlug).toBe("report");
    // EXACT placeholder — `deepResolveTemplates` only preserves the native string
    // (rather than re-interpolating it as text) when the whole value is one
    // `{{...}}`. Any surrounding text here would silently mangle the markdown.
    expect(data.config.body).toBe("{{steps.assemble.output}}");
    expect(data.config.title).toContain("{{steps.now.output.result}}");
  });

  it("writes only property slugs the seeded `report` profile declares", () => {
    // Mirrors ensure-system-profiles.ts → PROFILE_PROPERTY_BINDINGS for "report".
    const REPORT_PROPERTY_SLUGS = new Set([
      "title",
      "reportPeriod",
      "generatedAt",
      "reportStatus",
      "summary",
      "reportSources",
      "tags",
    ]);
    const props = (
      nodes.find((n) => n.id === "create-report")!.data as {
        config: { properties: Record<string, unknown> };
      }
    ).config.properties;

    for (const slug of Object.keys(props)) {
      expect(REPORT_PROPERTY_SLUGS.has(slug)).toBe(true);
    }
    // `reportStatus` is an enum on the profile: generating | ready | failed.
    expect(["generating", "ready", "failed"]).toContain(props.reportStatus);
    // `reportSources` is the context-chip list the renderer reads; the renderer
    // tolerates plain labels as well as {id,kind,label} objects.
    expect(Array.isArray(props.reportSources)).toBe(true);
  });

  it("teaches the Synap markdown contract in the assembler's system prompt", () => {
    // There is ZERO prior art for this syntax anywhere in the repo, so the rules
    // MUST live in the prompt. If someone trims the prompt, this test tells them
    // exactly which rule they dropped.
    const system = (
      nodes.find((n) => n.id === "assemble")!.data as {
        inputMapping: Record<string, string>;
      }
    ).inputMapping.system;

    // 4-colon section container, opened and closed.
    expect(system).toContain("::::synap-section{");
    expect(system).toContain("[[<kind>:<id>|<label>]]");
    // 3-colon leaf embeds — all three kinds taught.
    expect(system).toContain(":::synap-cell{");
    expect(system).toContain(":::synap-view{");
    expect(system).toContain(":::synap-entity{");
    // The nesting invariant, the attribute allowlist, and the confidence format.
    expect(system).toContain("STRICTLY MORE colons");
    expect(system).toContain(
      "id, agent, round, skills,\n   confidence, stepRunId, nodeId, status"
    );
    expect(system).toContain('confidence="0.8"');
    // Reference-only attributes + no invented ids + the visible-gap rule.
    expect(system).toContain("REFERENCE-ONLY");
    expect(system).toContain("READ-ONLY prose");
    expect(system).toContain("NEVER silently produce a shorter report");
    // A worked example must be present.
    expect(system).toContain("WORKED EXAMPLE");
  });

  it("makes the trigger-time prompt override materially steer every round", () => {
    for (const id of ["analyze", "relate", "assemble"]) {
      const mapping = (
        nodes.find((n) => n.id === id)!.data as {
          inputMapping: Record<string, string>;
        }
      ).inputMapping;
      // The steer reaches the round...
      expect(mapping.prompt).toContain("{{trigger.payload.prompt}}");
      expect(mapping.prompt).toContain("{{trigger.payload.focus}}");
      expect(mapping.prompt).toContain("{{trigger.payload.projectId}}");
      // ...and the system prompt tells the model what an EMPTY steer means, which
      // is what makes the no-payload run produce a sensible general report.
      expect(mapping.system).toContain("STEER");
    }
  });
});
