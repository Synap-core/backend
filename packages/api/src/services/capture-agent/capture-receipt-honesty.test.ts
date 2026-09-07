/**
 * A capture whose relations failed must be IMPOSSIBLE to read as a clean success.
 *
 * Reproduced live 2026-09-07: 9 entities + 11 relations captured under a project
 * focus (so the entities were placed pod-wide, `workspaceId: null`). Relation
 * defs are workspace-scoped, so every edge failed to resolve its type — and the
 * receipt came back `status: "applied"` with `relationCount: 0`, the eleven
 * failures buried in `relationsFailed[]`. A caller that did not read that array
 * believed the graph landed.
 *
 * Same class as `status ?? "installed"` and `changeType ?? "update"`: the good
 * news is the default and the bad news is opt-in.
 *
 * These are the two pure seams the fix runs through, tested without a database.
 * `partial` is the EXISTING Hub Protocol receipt word (`CreateWriteReceipt` in
 * routers/hub-protocol/write-receipt.ts), reused — not a new enum.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  materializedReceiptState,
  captureStatusForReceiptState,
} from "./capture-receipt-state.js";

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The doors that turn a `submitCaptureGraph` result into a caller-facing
 * `status` word. Both had the SAME defect — the second was found only by
 * grepping for it after fixing the first — so both are pinned here.
 */
const STATUS_DOORS = [
  "routers/mcp/handlers/capture.ts",
  "services/capabilities/builtin-verbs.ts",
];

describe("capture receipt honesty", () => {
  it("reports a fully-landed graph as applied", () => {
    expect(materializedReceiptState(0)).toBe("applied");
  });

  it("reports a graph with ANY failed relation as partial", () => {
    expect(materializedReceiptState(1)).toBe("partial");
    // The reproduced case: entities landed, all 11 edges failed.
    expect(materializedReceiptState(11)).toBe("partial");
  });

  it("never lets a partial graph reach a caller as a clean success", () => {
    // The whole point: the top-level `status` an MCP caller reads is derived
    // from the receipt state, so it cannot say "applied" while edges failed.
    const state = materializedReceiptState(11);
    expect(captureStatusForReceiptState(state)).not.toBe("applied");
    expect(captureStatusForReceiptState(state)).toBe("partial");
  });

  it("keeps `pending` reading as the caller-facing `proposed`", () => {
    // Unchanged behavior, pinned: `proposed` is SUCCESS in this door's contract
    // (a queued write with a review link), and renaming it would break the
    // instruction every agent is given.
    expect(captureStatusForReceiptState("pending")).toBe("proposed");
    expect(captureStatusForReceiptState("applied")).toBe("applied");
  });

  describe.each(STATUS_DOORS)("%s", (relPath) => {
    const source = readFileSync(join(API_SRC, relPath), "utf8");

    it("derives its capture status through the shared helper", () => {
      // NON-VACUITY for the assertion below: a file that stopped calling the
      // helper would trivially satisfy "does not use `.applied ?`" while having
      // reverted to something worse. This half fails first if that happens.
      expect(source).toContain("captureStatusForReceiptState(");
    });

    it("never derives its capture status from the `applied` routing flag", () => {
      // `applied` answers "did this terminal materialize?" — it stays TRUE for a
      // graph whose every edge failed. Using it as the outcome word is the
      // reported defect, and it existed independently in both of these files.
      const offenders = source
        .split("\n")
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => /status:\s*\w*\.?applied\s*\?/.test(line))
        .map(([n, line]) => `${relPath}:${n}: ${line.trim()}`);
      expect(
        offenders,
        "Derive the caller-facing status from `writeReceipt.state` via " +
          "captureStatusForReceiptState — not from the `applied` boolean."
      ).toEqual([]);
    });
  });
});
