/**
 * Identity/facet resolution helpers — pure unit tests (no DB).
 *
 * These `@synap/database` helpers gate the resolve-then-merge dedup path that
 * the entities.create door relies on. They are pure logic (one takes a mockable
 * db handle), so they're exercised here from the api package — its vitest config
 * self-gates (no forced Postgres setup), unlike the database package's suite —
 * without ever issuing a query.
 *
 *   - signalsFromExplicit: maps the EXPLICIT pre-check request shape to typed
 *     identity atoms; a bare `url` is linkedin-vs-website classified by the same
 *     domain-anchored check a real write uses.
 *   - resolveRolePayload: the "is this create-payload slug a ROLE?" guard —
 *     role → payload, kind → null, unknown → null.
 */

import { describe, it, expect } from "vitest";
import { signalsFromExplicit, resolveRolePayload } from "@synap/database";

describe("signalsFromExplicit", () => {
  it("returns [] for undefined", () => {
    expect(signalsFromExplicit(undefined)).toEqual([]);
  });

  it("returns [] for an empty object (no fields set)", () => {
    expect(signalsFromExplicit({})).toEqual([]);
  });

  it("maps each explicit field 1:1 to its typed atom", () => {
    expect(
      signalsFromExplicit({
        email: "alice@example.com",
        phone: "+15551234567",
        twitter: "@alice",
        github: "alice-dev",
        externalId: "discord:123",
      })
    ).toEqual([
      { type: "email", value: "alice@example.com" },
      { type: "phone", value: "+15551234567" },
      { type: "twitter_handle", value: "@alice" },
      { type: "github_username", value: "alice-dev" },
      { type: "external_id", value: "discord:123" },
    ]);
  });

  it("classifies a bare LinkedIn url as linkedin_url (host must be linkedin.com)", () => {
    expect(
      signalsFromExplicit({ url: "https://www.linkedin.com/in/alice/" })
    ).toEqual([
      { type: "linkedin_url", value: "https://www.linkedin.com/in/alice/" },
    ]);
  });

  it("classifies a non-LinkedIn url as website — including a lookalike host", () => {
    expect(signalsFromExplicit({ url: "https://alice.dev" })).toEqual([
      { type: "website", value: "https://alice.dev" },
    ]);
    // Lookalike domain must NOT be mistaken for LinkedIn (substring guard).
    expect(
      signalsFromExplicit({ url: "https://not-linkedin.com/in/x" })
    ).toEqual([{ type: "website", value: "https://not-linkedin.com/in/x" }]);
  });
});

describe("resolveRolePayload", () => {
  /** Minimal db stub: only `query.profiles.findFirst` is exercised. */
  const dbReturning = (row: unknown) =>
    ({
      query: { profiles: { findFirst: async () => row } },
    }) as unknown as Parameters<typeof resolveRolePayload>[0];

  it("returns the role payload when the slug resolves to a role profile", async () => {
    const db = dbReturning({
      id: "prof-role-1",
      slug: "client",
      profileKind: "role",
      applicableKinds: ["person", "company"],
    });
    expect(await resolveRolePayload(db, "client")).toEqual({
      profileId: "prof-role-1",
      slug: "client",
      applicableKinds: ["person", "company"],
    });
  });

  it("returns null for a primary kind profile (not a role)", async () => {
    const db = dbReturning({
      id: "prof-kind-1",
      slug: "person",
      profileKind: "kind",
      applicableKinds: [],
    });
    expect(await resolveRolePayload(db, "person")).toBeNull();
  });

  it("returns null for an unknown slug (no matching profile)", async () => {
    const db = dbReturning(undefined);
    expect(await resolveRolePayload(db, "does-not-exist")).toBeNull();
  });

  it("defaults applicableKinds to [] when the role row has none", async () => {
    const db = dbReturning({
      id: "prof-role-2",
      slug: "investor",
      profileKind: "role",
      applicableKinds: null,
    });
    expect(await resolveRolePayload(db, "investor")).toEqual({
      profileId: "prof-role-2",
      slug: "investor",
      applicableKinds: [],
    });
  });
});
