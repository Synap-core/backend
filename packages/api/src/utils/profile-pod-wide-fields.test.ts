import { describe, expect, it } from "vitest";
import {
  changedPodWideProfileFields,
  profileOwnershipRequirement,
} from "./profile-pod-wide-fields.js";

/**
 * Pure-unit coverage for the `profiles.update` pod-wide field gate. No DB:
 * both functions are total over their inputs, which is why the impure half
 * (assertPodAdmin) is kept out of them.
 */

describe("changedPodWideProfileFields", () => {
  const existing = {
    scope: "system",
    entityScope: "pod",
    aiPosture: { explainWhy: true },
    defaultListRenderer: null,
    defaultDetailRenderer: { kind: "cell", cellKey: "contact-card" },
    defaultDashboardRenderer: null,
  };

  it("reports nothing for an empty update", () => {
    expect(changedPodWideProfileFields({}, existing)).toEqual([]);
  });

  it("ignores cosmetic fields entirely", () => {
    const changed = changedPodWideProfileFields(
      { displayName: "Renamed", uiHints: { icon: "x" } } as never,
      existing
    );
    expect(changed).toEqual([]);
  });

  it("does NOT fire when a client PATCHes every field back unchanged", () => {
    // The regression that would turn a full-object PATCH into a 403.
    expect(changedPodWideProfileFields({ ...existing }, existing)).toEqual([]);
  });

  it("treats a structurally equal object value as unchanged", () => {
    expect(
      changedPodWideProfileFields({ aiPosture: { explainWhy: true } }, existing)
    ).toEqual([]);
    expect(
      changedPodWideProfileFields(
        { defaultDetailRenderer: { kind: "cell", cellKey: "contact-card" } },
        existing
      )
    ).toEqual([]);
  });

  it("treats null and absent as the same stored state", () => {
    expect(
      changedPodWideProfileFields({ defaultListRenderer: null }, existing)
    ).toEqual([]);
    expect(changedPodWideProfileFields({ aiPosture: null }, {})).toEqual([]);
  });

  it("catches entityScope — the placement-affecting field", () => {
    expect(
      changedPodWideProfileFields({ entityScope: "workspace" }, existing)
    ).toEqual(["entityScope"]);
  });

  it("catches aiPosture — pod-wide agent behaviour", () => {
    expect(
      changedPodWideProfileFields(
        { aiPosture: { explainWhy: false } },
        existing
      )
    ).toEqual(["aiPosture"]);
    // clearing a set posture IS a change
    expect(changedPodWideProfileFields({ aiPosture: null }, existing)).toEqual([
      "aiPosture",
    ]);
  });

  it("catches each pod-wide default renderer", () => {
    expect(
      changedPodWideProfileFields(
        { defaultListRenderer: { kind: "cell", cellKey: "table" } },
        existing
      )
    ).toEqual(["defaultListRenderer"]);
    expect(
      changedPodWideProfileFields({ defaultDetailRenderer: null }, existing)
    ).toEqual(["defaultDetailRenderer"]);
    expect(
      changedPodWideProfileFields(
        { defaultDashboardRenderer: { kind: "cell", cellKey: "bento" } },
        existing
      )
    ).toEqual(["defaultDashboardRenderer"]);
  });

  it("still catches scope — the originally gated field", () => {
    expect(
      changedPodWideProfileFields({ scope: "workspace" }, existing)
    ).toEqual(["scope"]);
  });

  it("reports every changed field, in declaration order", () => {
    expect(
      changedPodWideProfileFields(
        { entityScope: "workspace", scope: "workspace", aiPosture: null },
        existing
      )
    ).toEqual(["scope", "entityScope", "aiPosture"]);
  });
});

describe("profileOwnershipRequirement", () => {
  it("a workspace-owned profile is owned by that workspace", () => {
    expect(
      profileOwnershipRequirement({ workspaceId: "ws-1", userId: null })
    ).toEqual({ kind: "owning-workspace", workspaceId: "ws-1" });
  });

  it("a user-scoped profile is owned by that user, NOT by a workspace", () => {
    // The case the original inline scope check got wrong: workspaceId is NULL
    // for a user-scoped profile, so comparing it to ctx.workspaceId locked the
    // owner out of their own profile.
    expect(
      profileOwnershipRequirement({ workspaceId: null, userId: "user-1" })
    ).toEqual({ kind: "owning-user", userId: "user-1" });
  });

  it("an unowned (system/shared) profile requires pod admin — not a lockout", () => {
    expect(
      profileOwnershipRequirement({ workspaceId: null, userId: null })
    ).toEqual({ kind: "pod-admin" });
    expect(profileOwnershipRequirement({})).toEqual({ kind: "pod-admin" });
  });

  it("prefers workspace ownership when both columns are somehow set", () => {
    expect(
      profileOwnershipRequirement({ workspaceId: "ws-1", userId: "user-1" })
    ).toEqual({ kind: "owning-workspace", workspaceId: "ws-1" });
  });

  it("treats a reordered-key object as UNCHANGED (jsonb returns its own key order)", () => {
    // The regression this guards: `aiPosture`/renderer refs round-trip through
    // jsonb, which stores keys in Postgres' canonical order — not the order the
    // client sent. A key-order-sensitive compare reports a no-op PATCH as a
    // change and 403s a legitimate caller. The prior test used `{...existing}`,
    // so key order always matched and could never catch this.
    const existing = { aiPosture: { mode: "assist", verbosity: "low" } };
    const input = { aiPosture: { verbosity: "low", mode: "assist" } };
    expect(changedPodWideProfileFields(input, existing)).toEqual([]);
  });

  it("still detects a real change inside an object-valued pod-wide field", () => {
    const existing = { aiPosture: { mode: "assist", verbosity: "low" } };
    const input = { aiPosture: { mode: "autonomous", verbosity: "low" } };
    expect(changedPodWideProfileFields(input, existing)).toEqual(["aiPosture"]);
  });
});
