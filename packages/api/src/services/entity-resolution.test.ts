/**
 * Entity Resolution — unit tests for the pure exact-name partitioner.
 *
 * The DB query (`resolveEntityByName`) is the I/O shell; the partition RULE —
 * "same profile + same name = duplicate hint, different profile + same name =
 * facet to auto-connect" — is the load-bearing logic and is tested here without
 * a live Postgres.
 */

import { describe, it, expect } from "vitest";
import {
  partitionResolutionMatches,
  type ResolutionCandidateRow,
} from "./entity-resolution.js";

const row = (
  id: string,
  title: string,
  type: string,
  workspaceId: string | null = null
): ResolutionCandidateRow => ({ id, title, type, workspaceId });

describe("partitionResolutionMatches", () => {
  it("classifies a SAME-profile exact-name match as sameProfile", () => {
    const result = partitionResolutionMatches(
      [row("e1", "Acme", "company")],
      "company"
    );
    expect(result.sameProfile).toEqual({
      id: "e1",
      name: "Acme",
      profileSlug: "company",
      workspaceId: null,
    });
    expect(result.otherProfiles).toEqual([]);
  });

  it("classifies a DIFFERENT-profile exact-name match as otherProfiles", () => {
    const result = partitionResolutionMatches(
      [row("e2", "Acme", "person")],
      "company"
    );
    expect(result.sameProfile).toBeNull();
    expect(result.otherProfiles).toEqual([
      { id: "e2", name: "Acme", profileSlug: "person", workspaceId: null },
    ]);
  });

  it("splits a mixed set into sameProfile (one) + otherProfiles (rest)", () => {
    const result = partitionResolutionMatches(
      [
        row("dup", "Acme", "company"),
        row("facetA", "Acme", "person"),
        row("facetB", "Acme", "deal"),
      ],
      "company"
    );
    expect(result.sameProfile?.id).toBe("dup");
    expect(result.otherProfiles.map((e) => e.id).sort()).toEqual([
      "facetA",
      "facetB",
    ]);
  });

  it("keeps only the FIRST same-profile match (single duplicate hint)", () => {
    const result = partitionResolutionMatches(
      [row("first", "Acme", "company"), row("second", "Acme", "company")],
      "company"
    );
    expect(result.sameProfile?.id).toBe("first");
    expect(result.otherProfiles).toEqual([]);
  });

  it("excludes the just-created entity itself via excludeId", () => {
    const result = partitionResolutionMatches(
      [row("self", "Acme", "company"), row("other", "Acme", "person")],
      "company",
      "self"
    );
    expect(result.sameProfile).toBeNull();
    expect(result.otherProfiles.map((e) => e.id)).toEqual(["other"]);
  });

  it("returns empty resolution for no matches", () => {
    const result = partitionResolutionMatches([], "company");
    expect(result.sameProfile).toBeNull();
    expect(result.otherProfiles).toEqual([]);
  });
});
