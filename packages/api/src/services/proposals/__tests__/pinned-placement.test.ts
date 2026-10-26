/**
 * A revise cannot move or SHARE a pending write (security review F3, PR #103).
 *
 * `entities.create` persists where it placed the row (`resolvedWorkspaceId`)
 * and the space a pod-wide row is filed for (`resolvedHomeWorkspaceId`, 0355);
 * approval replays both verbatim. Through the ONE revise core
 * (`computeRevisedEnvelope`, shared by tRPC `revise`, MCP
 * `synap_revise_proposal` and Hub `updateProposal`):
 *  - changing either, at either level, is refused;
 *  - the Studio's "Save & Approve" — which resends the WHOLE inner payload —
 *    still works when it echoes the stored values;
 *  - a wholesale `data` replacement that drops them gets them back.
 */
import { describe, it, expect } from "vitest";
import { computeRevisedEnvelope } from "../proposals-service.js";

const X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const inner = {
  id: "e-1",
  profileSlug: "decision",
  title: "Ship it",
  resolvedWorkspaceId: null,
  resolvedHomeWorkspaceId: null,
};
const envelope = {
  targetType: "entity",
  changeType: "create",
  data: inner,
} as Record<string, unknown>;
const revise = (patch: {
  kind: "inner" | "envelope";
  fields: Record<string, unknown>;
}) => computeRevisedEnvelope({ envelope, actorId: "u1", patch });

describe("a revise cannot change where a pending write lands or who it is shared with", () => {
  it("refuses an INNER patch that plants a home space", () => {
    expect(() =>
      revise({ kind: "inner", fields: { resolvedHomeWorkspaceId: X } })
    ).toThrow(/resolvedHomeWorkspaceId/);
  });

  it("refuses the Studio's wholesale `data` with a CHANGED home or lens", () => {
    expect(() =>
      revise({
        kind: "envelope",
        fields: { data: { ...inner, resolvedHomeWorkspaceId: X } },
      })
    ).toThrow(/resolvedHomeWorkspaceId/);
    expect(() =>
      revise({
        kind: "envelope",
        fields: { data: { ...inner, resolvedWorkspaceId: X } },
      })
    ).toThrow(/resolvedWorkspaceId/);
  });

  it("refuses a top-level patch on a flat envelope", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: { targetType: "entity", changeType: "create", ...inner },
        actorId: "u1",
        patch: { kind: "envelope", fields: { resolvedWorkspaceId: X } },
      })
    ).toThrow(/resolvedWorkspaceId/);
  });

  it("refuses planting a key a pre-0355 proposal never had — even null", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: {
          targetType: "entity",
          changeType: "create",
          data: { id: "e-1", title: "Old" },
        },
        actorId: "u1",
        patch: { kind: "inner", fields: { resolvedWorkspaceId: null } },
      })
    ).toThrow(/resolvedWorkspaceId/);
  });

  it("still saves the Studio's edit when it ECHOES the stored placement", () => {
    const { merged } = revise({
      kind: "envelope",
      fields: { data: { ...inner, title: "Ship it now" } },
    });
    expect(merged.data).toMatchObject({
      title: "Ship it now",
      resolvedWorkspaceId: null,
      resolvedHomeWorkspaceId: null,
    });
  });

  it("a wholesale `data` that DROPS the placement gets it back", () => {
    const homed = {
      ...envelope,
      data: { ...inner, resolvedHomeWorkspaceId: X },
    };
    const { merged } = computeRevisedEnvelope({
      envelope: homed,
      actorId: "u1",
      patch: { kind: "envelope", fields: { data: { id: "e-1", title: "x" } } },
    });
    expect(merged.data).toMatchObject({
      title: "x",
      resolvedWorkspaceId: null,
      resolvedHomeWorkspaceId: X,
    });
  });
});
