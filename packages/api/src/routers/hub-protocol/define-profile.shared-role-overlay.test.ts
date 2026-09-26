/**
 * W2b ROLE PRINCIPLE at the define door: re-declaring an EXISTING pod-wide
 * (shared/system) role from a workspace adds that workspace's fields as
 * OVERLAYS — never as base defs on the role every workspace shares. A fresh
 * role, a workspace-private role, and a kind keep the caller's own choice.
 * Drives the REAL `defineProfile` with a recording caller.
 */
import { describe, expect, it } from "vitest";
import { defineProfile } from "./define-profile.js";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

async function defineWith(profileResult: Record<string, unknown>) {
  const fieldCalls: Array<Record<string, unknown>> = [];
  const caller = {
    profiles: {
      createProfile: async () => profileResult,
      createPropertyDef: async (input: Record<string, unknown>) => {
        fieldCalls.push(input);
        return { status: "applied" };
      },
    },
  };
  const outcome = await defineProfile(
    caller as never,
    {
      userId: USER,
      workspaceId: WS,
      slug: "partner",
      displayName: "Partner",
      profileKind: "role",
      fields: [{ slug: "tier", valueType: "string" }],
    },
    { door: "synap_define_role", fieldsParam: "fields" }
  );
  expect(outcome.ok).toBe(true);
  return fieldCalls;
}

describe("defineProfile — fields on a reused shared role land as overlays (W2b)", () => {
  it("existing SHARED role → the field is a workspace overlay", async () => {
    const calls = await defineWith({
      existing: true,
      shared: true,
      profile: { id: "p1", scope: "shared", profileKind: "role" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].overlay).toBe(true);
  });

  it("existing SYSTEM role → overlay too", async () => {
    const calls = await defineWith({
      existing: true,
      profile: { id: "p1", scope: "system", profileKind: "role" },
    });
    expect(calls[0].overlay).toBe(true);
  });

  it("a freshly created role / a workspace-private role / a kind keep base defs", async () => {
    for (const profileResult of [
      { profile: { id: "p1", scope: "shared", profileKind: "role" } },
      {
        existing: true,
        profile: { id: "p1", scope: "workspace", profileKind: "role" },
      },
      {
        existing: true,
        profile: { id: "p1", scope: "shared", profileKind: "kind" },
      },
    ]) {
      const calls = await defineWith(profileResult);
      expect(calls[0].overlay, JSON.stringify(profileResult)).toBeUndefined();
    }
  });
});
