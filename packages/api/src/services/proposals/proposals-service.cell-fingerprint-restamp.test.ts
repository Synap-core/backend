/**
 * A revised cell proposal is stamped again from its merged content (decision
 * Q9, approval per fingerprint). A revision may change the source a pending
 * cell proposal carries (the reviewer approves it bound to the revision they
 * saw); its fingerprint then follows the content, so the approve executor does
 * not refuse an honest revision. A stamp sent IN the patch is never taken: it
 * is derived, never written.
 */
import { describe, it, expect } from "vitest";
import { computeRevisedEnvelope } from "./proposals-service.js";
import {
  CELL_CONTENT_FINGERPRINT_KEY,
  withCellContentFingerprint,
} from "../cells/cell-content-fingerprint.js";

const FILED = withCellContentFingerprint({
  name: "My Cell",
  rendererSource: "export default () => null",
});
const ENVELOPE = {
  requestId: "r-1",
  targetType: "cell",
  changeType: "define",
  data: FILED,
};
const REVISED_SOURCE = "export default function Cell() { return 'v2'; }";

const stampOf = (merged: Record<string, unknown>) =>
  (merged.data as Record<string, unknown>)[CELL_CONTENT_FINGERPRINT_KEY];

describe("computeRevisedEnvelope — a cell proposal's fingerprint follows its content", () => {
  it("a revised source is stamped again", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: ENVELOPE,
      patch: { kind: "inner", fields: { rendererSource: REVISED_SOURCE } },
    });
    expect(stampOf(merged)).toBe(
      withCellContentFingerprint({ rendererSource: REVISED_SOURCE })[
        CELL_CONTENT_FINGERPRINT_KEY
      ]
    );
    expect(stampOf(merged)).not.toBe(FILED[CELL_CONTENT_FINGERPRINT_KEY]);
  });

  it("a stamp sent in the patch is replaced by the derived one", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: ENVELOPE,
      patch: {
        kind: "inner",
        fields: {
          rendererSource: REVISED_SOURCE,
          [CELL_CONTENT_FINGERPRINT_KEY]: FILED[CELL_CONTENT_FINGERPRINT_KEY],
        },
      },
    });
    expect(stampOf(merged)).not.toBe(FILED[CELL_CONTENT_FINGERPRINT_KEY]);
  });

  it("a wording-only revision keeps the stamp it had", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: ENVELOPE,
      summary: "A clearer summary",
    });
    expect(stampOf(merged)).toBe(FILED[CELL_CONTENT_FINGERPRINT_KEY]);
  });

  it("never stamps another kind of proposal", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: { ...ENVELOPE, targetType: "view", changeType: "create" },
      patch: { kind: "inner", fields: { rendererSource: REVISED_SOURCE } },
    });
    expect(
      (merged.data as Record<string, unknown>)[CELL_CONTENT_FINGERPRINT_KEY]
    ).toBe(FILED[CELL_CONTENT_FINGERPRINT_KEY]);
  });
});
