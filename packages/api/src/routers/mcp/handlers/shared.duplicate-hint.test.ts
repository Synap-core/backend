/**
 * The duplicate hint names the real reason (30 Oct live test, item 3).
 *
 * `ok()` turns a deduped proposed write into `status: "duplicate"` with a
 * stop-re-proposing hint. That hint said "An identical proposal is already
 * pending" also when the capture door's own-twin path (D3, #491) returned a
 * DIFFERENT proposal whose entities already wait in the caller's queue: the
 * agent then believed it had re-sent the same payload. The twin case now has
 * its own sentence, with the link; the identical case is unchanged.
 */
import { describe, it, expect } from "vitest";
import { ok } from "./shared.js";

const PROPOSAL = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";

function payload(result: ReturnType<typeof ok>) {
  const block = result.content[0];
  if (!block || block.type !== "text") {
    throw new Error("ok() did not return a text content block");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe("ok() duplicate hint", () => {
  it("an identical re-send keeps the identical-proposal sentence", () => {
    const out = payload(
      ok({ status: "proposed", proposalId: PROPOSAL, deduped: true })
    );
    expect(out.status).toBe("duplicate");
    expect(String(out.hint)).toMatch(
      /^An identical proposal is already pending/
    );
  });

  it("an own pending twin says the caller's proposal already holds it, with its link", () => {
    const out = payload(
      ok({
        status: "proposed",
        proposalId: PROPOSAL,
        deduped: true,
        dedupedAs: "own_pending_twin",
      })
    );
    expect(out.status).toBe("duplicate");
    expect(out.hint).toBe(
      `Your pending proposal ${String(out.link)} already holds this; it was returned instead of filing a second one.`
    );
    expect(String(out.hint)).toContain(`/open/${PROPOSAL}`);
    expect(String(out.hint)).not.toMatch(/identical/i);
  });
});
