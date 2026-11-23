/**
 * The contract version moves with the op tables: changing what an op carries
 * without bumping `CELL_BRIDGE_CONTRACT_VERSION` turns this red, so a bundle
 * that needs the change can say so (and an older pod holds it).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CELL_BRIDGE_CONTRACT_VERSION,
  CELL_BRIDGE_READ_OPS,
  CELL_BRIDGE_WRITE_OPS,
} from "./index.js";

/** sha256 of the op tables at each version (only the current one is checked). */
const RECORDED_SHAPES: Record<number, string> = {
  2: "8e24b5185ac8d9d03739fc7af589ec8801e6f9da758a4125a7fd1c2dcb87b70b",
};

describe("the frame contract's version", () => {
  it("is the version whose op tables these are: bump it and record the shape when an op changes", () => {
    const shape = createHash("sha256")
      .update(
        JSON.stringify({
          read: CELL_BRIDGE_READ_OPS,
          write: CELL_BRIDGE_WRITE_OPS,
        })
      )
      .digest("hex");
    expect(
      shape,
      `the op tables changed: bump CELL_BRIDGE_CONTRACT_VERSION and record ${shape}`
    ).toBe(RECORDED_SHAPES[CELL_BRIDGE_CONTRACT_VERSION]);
  });
});
