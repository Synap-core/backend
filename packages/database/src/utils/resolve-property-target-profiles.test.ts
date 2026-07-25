/**
 * resolvePropertyTargetProfiles — the "never rejects" contract.
 *
 * This pass ENRICHES property_defs that already exist and already work: it fills
 * a NULL `target_profile_id` from a declared `targetProfileSlug`. It is called
 * from BOTH provisioning doors, and in the create door it sits OUTSIDE any
 * `try`/`handleStepError` (deliberately — it must run on the resume path too).
 * So its documented invariant is load-bearing: it MUST resolve, never reject,
 * even when every repo call throws — a transient PG error must not fail an
 * install at the one step documented as unable to.
 *
 * These are PURE unit tests: the function takes both repositories by interface,
 * so no Postgres and no schema-graph load — they never self-skip (unlike the
 * DB-backed suites in ../__tests__ that gate on `SCHEMA_LOADS`).
 */

import { describe, it, expect } from "vitest";
import {
  resolvePropertyTargetProfiles,
  type ResolvePropertyTargetsOptions,
} from "./resolve-property-target-profiles.js";

// Minimal shapes matching only the fields the function reads.
type Def = {
  id: string;
  profileId: string | null;
  valueType: string;
  targetProfileId: string | null;
};

interface StubOpts {
  getBySlugForWorkspace?: (
    slug: string,
    wsId: string
  ) => Promise<{ id: string } | null>;
  getBySlug?: (
    slug: string,
    profileId: string,
    wsId: string | null
  ) => Promise<Def | null>;
  update?: (id: string, patch: { targetProfileId: string }) => Promise<void>;
  profileMap?: Record<string, string>;
  dryRun?: boolean;
}

/** Build a call targeting `audience` from a single `pillar.aud` entity_id prop. */
function buildOpts(stub: StubOpts): ResolvePropertyTargetsOptions {
  const profileRepo = {
    getBySlugForWorkspace:
      stub.getBySlugForWorkspace ??
      (async () => ({ id: "audience-profile-id" })),
  } as unknown as ResolvePropertyTargetsOptions["profileRepo"];

  const propDefRepo = {
    getBySlug:
      stub.getBySlug ??
      (async (): Promise<Def> => ({
        id: "def-1",
        profileId: "pillar-profile-id",
        valueType: "entity_id",
        targetProfileId: null,
      })),
    update: stub.update ?? (async () => undefined),
  } as unknown as ResolvePropertyTargetsOptions["propDefRepo"];

  return {
    definition: {
      profiles: [
        {
          slug: "pillar",
          properties: [{ slug: "aud", targetProfileSlug: "audience" }],
        },
      ],
    } as unknown as ResolvePropertyTargetsOptions["definition"],
    workspaceId: "ws-1",
    // pillar is resolved; audience is NOT in the map, forcing the repo lookup.
    profileMap: stub.profileMap ?? { pillar: "pillar-profile-id" },
    profileRepo,
    propDefRepo,
    dryRun: stub.dryRun,
  };
}

describe("resolvePropertyTargetProfiles — never-rejects contract", () => {
  it("resolves (never rejects) when the target-profile lookup throws → target-profile-unresolved", async () => {
    const report = await resolvePropertyTargetProfiles(
      buildOpts({
        getBySlugForWorkspace: async () => {
          throw new Error("pool timeout");
        },
      })
    );
    expect(report.set).toEqual([]);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0].reason).toBe("target-profile-unresolved");
  });

  it("resolves (never rejects) when the def READ throws → read-failed", async () => {
    const report = await resolvePropertyTargetProfiles(
      buildOpts({
        getBySlug: async () => {
          throw new Error("pool timeout");
        },
      })
    );
    expect(report.set).toEqual([]);
    expect(report.unresolved[0].reason).toBe("read-failed");
  });

  it("resolves (never rejects) when the WRITE throws → write-failed", async () => {
    const report = await resolvePropertyTargetProfiles(
      buildOpts({
        update: async () => {
          throw new Error("pool timeout");
        },
      })
    );
    expect(report.set).toEqual([]);
    expect(report.unresolved[0].reason).toBe("write-failed");
  });

  it("is idempotent — a def that already has a target_profile_id is not rewritten", async () => {
    let updateCalls = 0;
    const report = await resolvePropertyTargetProfiles(
      buildOpts({
        getBySlug: async () => ({
          id: "def-1",
          profileId: "pillar-profile-id",
          valueType: "entity_id",
          targetProfileId: "already-set",
        }),
        update: async () => {
          updateCalls += 1;
        },
      })
    );
    expect(updateCalls).toBe(0);
    expect(report.set).toEqual([]);
    expect(report.unresolved).toEqual([]);
  });

  it("rejects the GLOBAL-def fallback — a def with profileId=null is never targeted", async () => {
    let updateCalls = 0;
    const report = await resolvePropertyTargetProfiles(
      buildOpts({
        // getBySlug falls back to a global def (profile_id IS NULL); writing a
        // target onto it would constrain the slug for EVERY profile pod-wide.
        getBySlug: async () => ({
          id: "global-def",
          profileId: null,
          valueType: "entity_id",
          targetProfileId: null,
        }),
        update: async () => {
          updateCalls += 1;
        },
      })
    );
    expect(updateCalls).toBe(0);
    expect(report.unresolved[0].reason).toBe("property-def-not-found");
  });

  it("happy path — resolves the target and records the write", async () => {
    let written: { id: string; targetProfileId: string } | null = null;
    const report = await resolvePropertyTargetProfiles(
      buildOpts({
        update: async (id, patch) => {
          written = { id, targetProfileId: patch.targetProfileId };
        },
      })
    );
    expect(report.unresolved).toEqual([]);
    expect(report.set).toHaveLength(1);
    expect(written).toEqual({
      id: "def-1",
      targetProfileId: "audience-profile-id",
    });
  });

  it("dryRun computes the diff without writing", async () => {
    let updateCalls = 0;
    const report = await resolvePropertyTargetProfiles(
      buildOpts({
        update: async () => {
          updateCalls += 1;
        },
        dryRun: true,
      })
    );
    expect(updateCalls).toBe(0);
    expect(report.set).toHaveLength(1);
  });
});
