import { describe, it, expect } from "vitest";
import { validateFlowDefinition } from "./validate-flow.js";
import {
  REPORT_AUTOMATION_FLOW,
  REPORT_AUTOMATION_NAME,
} from "@synap/database";

/**
 * Author-time gate for flows seeded FROM CODE.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `config-automation-seeds.validate.test.ts`:
 * that one reads the CP repo's capability-template JSON. This one covers flows
 * that live as TypeScript constants and are written straight to the DB by an
 * `ensure*` reconcile — which means they NEVER pass through
 * `routers/automations.ts`'s create/update door, and therefore never meet
 * `validateFlowDefinition` in production. A direct `db.insert` bypasses every
 * door-level check by construction, so the only place these can be gated is
 * CI. This is that place.
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
describe("code-seeded flow definitions are author-valid", () => {
  it(`"${REPORT_AUTOMATION_NAME}" passes the same validator the persist doors run`, () => {
    const result = validateFlowDefinition(REPORT_AUTOMATION_FLOW);
    // Assert on `errors` rather than the boolean: a failure should PRINT what
    // is wrong, not just say `false !== true`.
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("every node the report flow references in an edge actually exists", () => {
    // Belt-and-braces on the highest-value structural invariant, asserted here
    // too so a regression names the specific broken edge.
    const nodeIds = new Set(REPORT_AUTOMATION_FLOW.nodes.map((n) => n.id));
    const dangling = REPORT_AUTOMATION_FLOW.edges.flatMap((e) =>
      [e.source, e.target].filter((id) => !nodeIds.has(id))
    );
    expect(dangling).toEqual([]);
  });
});
