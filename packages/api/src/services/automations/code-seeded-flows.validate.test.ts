import { describe, it, expect } from "vitest";
import { validateFlowDefinition } from "./validate-flow.js";
import { toPackageDefinition } from "@synap-core/workspace-templates";

/**
 * Author-time gate for flows applied to workspaces WITHOUT passing the door.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `config-automation-seeds.validate.test.ts`:
 * that one reads the CP repo's capability-template JSON. This one covers the
 * `base` workspace template's report automation ("Generate report"), which the
 * base-template reconcile (`reconcileWorkspaceFromDefinition` §7) writes straight
 * to the DB with `db.insert` — it NEVER passes through `routers/automations.ts`'s
 * create/update door, and therefore never meets `validateFlowDefinition` in
 * production. A direct insert bypasses every door-level check by construction, so
 * the only place this flow's shape can be gated is CI. This is that place.
 *
 * (History: this flow used to be a TypeScript const, `REPORT_AUTOMATION_FLOW`,
 * seeded by `ensureReportAutomation`. That hardcoded copy was retired — base.yaml
 * is now the single source — but the reconcile door still `db.insert`s the flow
 * unvalidated, so the gate is still needed; it now reads the compiled base flow.)
 *
 * ── A DELIBERATE LIMITATION, STATED ──────────────────────────────────────────
 * Passing this test means the flow is STRUCTURALLY sound: node ids unique and
 * present, `type` in the known union, per-type required fields present, no
 * dangling edges, no cycles.
 *
 * It does NOT mean the flow is CORRECT. `validateFlowDefinition` returned
 * `{ valid: true, errors: [] }` for this exact flow while it contained three
 * separate data-destroying bugs (all live, all found 2026-07-27 by reading a
 * wrong report rather than by any check):
 *   1. `{{item.id}} · {{item.title}}` in a `map:` projection resolved to
 *      `[null, null, …]` — the reference grammar's whole-string matcher was
 *      ambiguous. Structurally a perfectly valid `transform` node.
 *   2. `orderBy: "updatedAt"` addressed the `properties` jsonb rather than the
 *      real column, so ordering silently did nothing. A valid string.
 *   3. A guard reading `exists: true` where it meant "has content", so an
 *      empty body passed the check whose message said it would not. A valid
 *      check object.
 *
 * Every one was structurally valid and semantically wrong — which is the whole
 * category this repo keeps paying for. So treat a green result here as
 * "the shape is right", never as "the flow works", and put semantic rules
 * (reference resolution, orderBy targets, guard intent) where they can actually
 * see meaning rather than shape.
 */

/** The compiled `base` report automation's flow — the SSOT the reconcile applies. */
const reportFlow = (() => {
  const pkg = toPackageDefinition("base");
  const automation = (pkg.automations ?? [])[0];
  if (!automation?.flowDefinition) {
    throw new Error(
      "base template does not carry a 'Generate report' automation flow"
    );
  }
  return {
    name: automation.name,
    flow: automation.flowDefinition as { nodes: unknown[]; edges: unknown[] },
  };
})();

describe("code-applied flow definitions are author-valid", () => {
  it(`"${reportFlow.name}" passes the same validator the persist doors run`, () => {
    const result = validateFlowDefinition(reportFlow.flow);
    // Assert on `errors` rather than the boolean: a failure should PRINT what
    // is wrong, not just say `false !== true`.
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("every node the report flow references in an edge actually exists", () => {
    // Belt-and-braces on the highest-value structural invariant, asserted here
    // too so a regression names the specific broken edge.
    const nodes = reportFlow.flow.nodes as Array<{ id: string }>;
    const edges = reportFlow.flow.edges as Array<{
      source: string;
      target: string;
    }>;
    const nodeIds = new Set(nodes.map((n) => n.id));
    const dangling = edges.flatMap((e) =>
      [e.source, e.target].filter((id) => !nodeIds.has(id))
    );
    expect(dangling).toEqual([]);
  });
});
