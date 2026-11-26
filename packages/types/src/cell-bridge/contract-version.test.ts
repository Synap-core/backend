/**
 * The contract version moves with the op tables and the frame's context:
 * changing what an op carries, or what `context()` answers, without bumping
 * `CELL_BRIDGE_CONTRACT_VERSION` turns this red, so a bundle that needs the
 * change can say so (and an older pod holds it).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CELL_BRIDGE_CONTRACT_VERSION,
  CELL_BRIDGE_READ_OPS,
  CELL_BRIDGE_WRITE_OPS,
  FRAME_CONTEXT_RESULT_TYPE,
  FRAME_CONTEXT_TYPE,
  SURFACE_CONTEXT_FIELDS,
} from "./index.js";

/**
 * sha256 of the contract's shape at each version (only the current one is
 * checked). Up to 2 the shape was the op tables alone; from 3 it is the op
 * tables, the context's fields and the context messages.
 */
const RECORDED_SHAPES: Record<number, string> = {
  2: "8e24b5185ac8d9d03739fc7af589ec8801e6f9da758a4125a7fd1c2dcb87b70b",
  3: "bb0cb24f896deb40614855a370d227a32114bfd2b2690a0a90ba4af2ea6f75c4",
  4: "b8670c8df5a85e7e03437e995b314af9346bbd25a1d2675bab86b19d367e9fdf",
};

describe("the frame contract's version", () => {
  it("is the version whose op tables and context these are: bump it and record the shape when either changes", () => {
    const shape = createHash("sha256")
      .update(
        JSON.stringify({
          read: CELL_BRIDGE_READ_OPS,
          write: CELL_BRIDGE_WRITE_OPS,
          context: SURFACE_CONTEXT_FIELDS,
          messages: [FRAME_CONTEXT_TYPE, FRAME_CONTEXT_RESULT_TYPE],
        })
      )
      .digest("hex");
    expect(
      shape,
      `the contract changed: bump CELL_BRIDGE_CONTRACT_VERSION and record ${shape}`
    ).toBe(RECORDED_SHAPES[CELL_BRIDGE_CONTRACT_VERSION]);
  });

  it("is at least 3 from the frame's context on (v2 had no context call)", () => {
    expect(CELL_BRIDGE_CONTRACT_VERSION).toBeGreaterThanOrEqual(3);
    expect(SURFACE_CONTEXT_FIELDS).toEqual([
      "anchor",
      "workspaceId",
      "projectId",
      "goalId",
      "filters",
      "brand",
      "locale",
      "theme",
    ]);
  });
});
