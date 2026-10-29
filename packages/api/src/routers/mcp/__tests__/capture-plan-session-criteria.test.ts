/**
 * Ticket 091f412e (3) — a connected plan's sessions CAN carry their acceptance
 * criteria, and `synap_capture` now says so.
 *
 * The core already carried them (`capture-plan.ts` shape-checks
 * `sessions[].criteria`, `materialize-composite.ts` passes `op.criteria` to the
 * session door, `materialize-composite-plan.test.ts` holds that hop). The tool
 * did not: its `sessions[]` item declared no `criteria`, and its
 * `expectedOutputs` text said criteria "are NOT carried by a plan step — set
 * them on the session afterwards". Agents follow the text, so every plan
 * session cost a second `synap_update_session` after approval.
 *
 * ASSERT REACHABILITY, NOT SHAPE: the advertised criterion is run through the
 * pod's own parse (`sessionCriteriaSchema`, what the session door applies), and
 * the `sessions[]` item the tool describes is driven through the REAL op
 * mapping (`buildCaptureGraphOperations`) to the `create_session` op the
 * materializer reads.
 *
 * WHAT THIS DOES NOT COVER: the committed manifest being in step with
 * `tools.list()` (`manifest-freshness.test.ts`), and the op → session-door hop
 * (`materialize-composite-plan.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";
import { buildCaptureGraphOperations } from "../../../services/capture-agent/submit-capture-graph.js";
import { sessionCriteriaSchema } from "../../../schemas/session-criteria.js";

type Schema = Record<string, any>;

async function captureSessionItem(): Promise<Schema> {
  const list = (await tools.list()) as Array<{
    name: string;
    inputSchema: Schema;
  }>;
  const capture = list.find((t) => t.name === "synap_capture");
  expect(capture, "synap_capture is missing from tools.list()").toBeDefined();
  return capture!.inputSchema.properties.sessions.items;
}

const ADVERTISED_CRITERION = {
  key: "spec-approved",
  statement: "The spec document is approved by the person",
  check: { kind: "human" },
};

describe("synap_capture sessions[] — criteria ride the plan (091f412e)", () => {
  it("declares `criteria` on the session step, in the start_session shape", async () => {
    const item = await captureSessionItem();
    // Non-vacuous: the item is the plan step, not some other object.
    expect(item.required).toEqual(["ref", "goal"]);
    const criteria = item.properties.criteria;
    expect(criteria, "sessions[].criteria is not declared").toBeDefined();
    expect(criteria.type).toBe("array");
    expect(criteria.items.required).toEqual(["key", "statement", "check"]);
    expect(criteria.items.properties.check.properties.kind.enum).toEqual(
      expect.arrayContaining(["evidence", "capability", "judge", "human"])
    );
  });

  it("no longer tells the agent criteria are not carried", async () => {
    const item = await captureSessionItem();
    const text = JSON.stringify(item);
    expect(text).not.toMatch(/NOT carried by a plan step/);
    expect(text).not.toMatch(/set them on the session afterwards/);
  });

  it("a criterion in the advertised shape is one the session door accepts", () => {
    expect(
      sessionCriteriaSchema.safeParse([ADVERTISED_CRITERION]).success
    ).toBe(true);
  });

  it("THE SEAM: a plan session's criteria reach its create_session op", async () => {
    const ops = await buildCaptureGraphOperations(null as never, {
      entities: [],
      relations: [],
      projectId: null,
      // No workspace: the scope-aware home stamping (a DB read) is skipped.
      workspaceId: null,
      plan: {
        sessions: [
          {
            ref: "s1",
            goal: "Spec signed off",
            expectedOutputs: [{ kind: "document", label: "Spec" }],
            criteria: [ADVERTISED_CRITERION],
          },
        ],
      },
    });
    const session = ops.find((o) => o.op === "create_session") as
      { criteria?: unknown } | undefined;
    expect(session, "no create_session op was built").toBeDefined();
    expect(session!.criteria).toEqual([ADVERTISED_CRITERION]);
  });
});
