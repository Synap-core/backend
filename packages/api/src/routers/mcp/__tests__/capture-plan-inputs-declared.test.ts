/**
 * `synap_capture` DECLARES every plan input its handler forwards.
 *
 * The door's input check (`parseToolArgs`, define-tool.ts) refuses a key
 * the tool does not declare. The handler forwards every
 * `CAPTURE_PLAN_KEYS` array, but `edits` (the re-plan ops, from-intent §2d)
 * was forwarded and never declared: an agent that followed the skill was told
 * its re-plan was ignored, and would be refused.
 *
 * The same for the link item: a plan step waiting on a decision, a goal, or
 * one ARM of a decision (`toEntityRef`/`toEntityId`, `toTrackRef`/`toTrackId`,
 * `option`) was named only in the description, never in the item.
 *
 * ASSERT REACHABILITY: the check runs on the REAL tool list, and an arm link
 * in the advertised shape is driven through the REAL op mapping
 * (`buildCaptureGraphOperations`) to the `create_link` op the materializer
 * reads (`planCrossKindEdges` → the dependency door).
 *
 * WHAT THIS DOES NOT COVER: the committed manifest being in step with
 * `tools.list()` (`manifest-freshness.test.ts`); the link item's property set
 * matching `CompositeCreateLinkOp` is a compile-time floor in the tool
 * definition (`satisfies Record<…>`), not this test.
 */
import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";
import { declaredArgNames, undeclaredArgs } from "../define-tool.js";
import { CAPTURE_PLAN_KEYS } from "../../../services/capture-agent/capture-plan.js";
import { buildCaptureGraphOperations } from "../../../services/capture-agent/submit-capture-graph.js";

type Schema = Record<string, any>;

async function captureSchema(): Promise<Schema> {
  const list = (await tools.list()) as Array<{
    name: string;
    inputSchema: Schema;
  }>;
  const capture = list.find((t) => t.name === "synap_capture");
  expect(capture, "synap_capture is missing from tools.list()").toBeDefined();
  return capture!.inputSchema;
}

describe("synap_capture declares every plan input it forwards", () => {
  it("every CAPTURE_PLAN_KEYS array, `edits` included, is reported by nothing", async () => {
    // Non-vacuous: the derived set is the real list, and it holds `edits`.
    expect(CAPTURE_PLAN_KEYS.length).toBeGreaterThan(10);
    expect(CAPTURE_PLAN_KEYS).toContain("edits");
    const args = Object.fromEntries(CAPTURE_PLAN_KEYS.map((k) => [k, []]));
    const declared = declaredArgNames("synap_capture")!;
    expect(undeclaredArgs(args, declared)).toEqual([]);
    // Self-check: the same call still sees a key synap_capture does not take.
    expect(undeclaredArgs({ ...args, bogusPlan: [] }, declared)).toEqual([
      "bogusPlan",
    ]);
  });

  it("declares `edits` as the re-plan ops array, pointing at from-intent §2d", async () => {
    const edits = (await captureSchema()).properties.edits;
    expect(edits?.type).toBe("array");
    expect(edits.description).toMatch(/update_session/);
    expect(edits.description).toMatch(/remove_link/);
    expect(edits.description).toMatch(/from-intent §2d/);
  });

  it("the links[] item declares the cross-kind targets and the arm option", async () => {
    const item = (await captureSchema()).properties.links.items;
    // Non-vacuous: the item is the plan link, not some other object.
    expect(item.required).toEqual(["type"]);
    expect(Object.keys(item.properties)).toEqual(
      expect.arrayContaining([
        "toEntityRef",
        "toEntityId",
        "toTrackRef",
        "toTrackId",
        "option",
      ])
    );
  });

  it("THE SEAM: an arm link in the advertised shape reaches its create_link op with its option", async () => {
    const ops = await buildCaptureGraphOperations(null as never, {
      entities: [],
      relations: [],
      projectId: null,
      // No workspace: the scope-aware home stamping (a DB read) is skipped.
      workspaceId: null,
      plan: {
        sessions: [{ ref: "s1", goal: "Close the round" }],
        links: [
          {
            type: "blocked_by",
            fromRef: "s1",
            toEntityId: "6fbc2b5c-e7dd-482f-b243-cd1dacabe020",
            option: "raise",
          },
        ],
      },
    });
    expect(ops.find((o) => o.op === "create_link")).toMatchObject({
      op: "create_link",
      type: "blocked_by",
      fromRef: "s1",
      toEntityId: "6fbc2b5c-e7dd-482f-b243-cd1dacabe020",
      option: "raise",
    });
  });
});
