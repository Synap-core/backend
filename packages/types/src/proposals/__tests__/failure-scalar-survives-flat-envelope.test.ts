import { describe, it, expect } from "vitest";
import { buildRequestFromProposal, isNestedEnvelope } from "../index.js";
import type { Proposal } from "@synap/database";

/**
 * Regression guard for a latent coupling flagged in code review of P1
 * (commit a98f9abd, "feat(p1): classify + persist failure class so a failed
 * proposal carries an action").
 *
 * P1 persists failure scalars at the TOP LEVEL of the stored `proposals.data`
 * envelope: `data.failure = { errorClass, providerRef }`. The frontend chip
 * (`DestinationChip`) reads them via `proposal.request.data.failure`.
 *
 * Those two only line up because `buildRequestFromProposal` treats
 * `provider.action` / `capability.*` / `messaging.external.send` proposals as
 * FLAT envelopes (`isNestedEnvelope(raw) === false`), so `request.data = raw`
 * — the whole envelope, `failure` included, becomes `request.data`.
 *
 * If any of these target types ever became a NESTED envelope (inner `data`
 * object present), `request.data` would become the inner payload slot and
 * `failure` — a sibling at the envelope top level, not inside the inner — would
 * silently vanish from `request.data.failure`. The chip would just disappear,
 * no error, no test failure elsewhere. This test pins the current flat
 * contract for the target types the chip depends on: if one of them flips to
 * a nested shape without updating the persistence site, this test catches it.
 */

/** Minimal Proposal row carrying a flat envelope in its `data` column. */
function makeRow(
  targetType: string,
  data: Record<string, unknown>
): Proposal {
  return {
    id: "prop-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    workspaceId: "ws-1",
    targetType,
    targetId: "target-1",
    proposalType: "create",
    data,
    status: "pending",
    createdBy: "user-1",
    agentUserId: "agent-1",
  } as unknown as Proposal;
}

const failure = { errorClass: "auth", providerRef: "google-mail" } as const;

describe("failure scalars survive buildRequestFromProposal for flat targets", () => {
  it("provider.action: request.data.failure round-trips", () => {
    const raw = {
      requestId: "req-1",
      source: "system",
      targetType: "provider.action",
      changeType: "create",
      failure,
    };
    // Sanity: this envelope is flat, not nested — the precondition the chip relies on.
    expect(isNestedEnvelope(raw)).toBe(false);

    const request = buildRequestFromProposal(
      makeRow("provider.action", raw)
    );

    expect(request.data?.failure).toBeDefined();
    expect(request.data?.failure).toEqual(failure);
  });

  it("capability.*: request.data.failure round-trips", () => {
    const raw = {
      requestId: "req-2",
      source: "system",
      targetType: "capability.run",
      changeType: "create",
      failure,
    };
    expect(isNestedEnvelope(raw)).toBe(false);

    const request = buildRequestFromProposal(
      makeRow("capability.run", raw)
    );

    expect(request.data?.failure).toBeDefined();
    expect(request.data?.failure).toEqual(failure);
  });

  it("messaging.external.send: request.data.failure round-trips", () => {
    const raw = {
      requestId: "req-3",
      source: "system",
      targetType: "messaging.external.send",
      changeType: "create",
      failure,
    };
    expect(isNestedEnvelope(raw)).toBe(false);

    const request = buildRequestFromProposal(
      makeRow("messaging.external.send", raw)
    );

    expect(request.data?.failure).toBeDefined();
    expect(request.data?.failure).toEqual(failure);
  });
});
