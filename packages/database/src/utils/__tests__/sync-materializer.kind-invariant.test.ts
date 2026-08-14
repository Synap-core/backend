/**
 * KIND/FACET INVARIANT — pod-to-pod replication path.
 *
 * `entities.type` is the entity's KIND. A role it plays (client, partner,
 * investor…) is an `entity_facets` row, never a type. `EntityRepository.create`
 * enforces this and is covered by
 * `repositories/entity-repository.kind-invariant.test.ts`.
 *
 * `sync-materializer` is a SECOND entity-writer: replication does a raw
 * `insert … onConflictDoUpdate` that never touches EntityRepository or
 * FacetRepository. Its type came straight from `profiles.slug`, so a replicated
 * event referencing a ROLE profile would write `type:'client'` into the peer —
 * the same corruption the canonical door was fixed to prevent, arriving by the
 * back door and then propagating to every further peer.
 *
 * These tests pin the resolution rules. They matter because the two writers
 * cannot share code cheaply (replication needs upsert-by-id semantics the
 * repository does not offer), so the invariant has to be asserted twice.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let profileRow: {
  slug: string;
  profileKind: "kind" | "role";
  applicableKinds: string[] | null;
} | null = null;

vi.mock("../../client-pg.js", () => ({
  db: {
    query: {
      profiles: { findFirst: async () => profileRow },
    },
  },
}));

const { resolveMaterializedEntityType } =
  await import("../sync-materializer.js");

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  profileRow = null;
});

describe("resolveMaterializedEntityType — a KIND resolves to its slug", () => {
  it("uses the profile slug when the profile is a kind", async () => {
    profileRow = { slug: "person", profileKind: "kind", applicableKinds: null };
    await expect(
      resolveMaterializedEntityType({ profileId: PROFILE_ID })
    ).resolves.toBe("person");
  });

  it("falls back to the declared type when there is no profileId", async () => {
    await expect(resolveMaterializedEntityType({ type: "note" })).resolves.toBe(
      "note"
    );
  });
});

describe("resolveMaterializedEntityType — a ROLE never becomes a type", () => {
  it("REFUSES even when a plausible kind is declared alongside the role", async () => {
    // Repairing `type` while leaving profileId pointing at the role would land
    // an internally inconsistent row: type='person', FK -> role 'client'.
    profileRow = {
      slug: "client",
      profileKind: "role",
      applicableKinds: ["person", "company"],
    };

    await expect(
      resolveMaterializedEntityType({ profileId: PROFILE_ID, type: "person" })
    ).rejects.toThrow(/references ROLE profile "client"/);
  });

  it("REFUSES a DIFFERENT role slug offered as the declared kind", async () => {
    // The dangerous case: comparing the declared type only against THIS role's
    // slug would let `type:"partner"` (another role) through as a kind.
    profileRow = {
      slug: "client",
      profileKind: "role",
      applicableKinds: ["person", "company"],
    };

    await expect(
      resolveMaterializedEntityType({ profileId: PROFILE_ID, type: "partner" })
    ).rejects.toThrow(/references ROLE profile/);
  });

  it("REFUSES an unambiguous single-kind role too — the FK is still wrong", async () => {
    profileRow = {
      slug: "teammate",
      profileKind: "role",
      applicableKinds: ["person"],
    };

    await expect(
      resolveMaterializedEntityType({ profileId: PROFILE_ID })
    ).rejects.toThrow(/references ROLE profile "teammate"/);
  });

  it("REFUSES rather than guessing when the role spans several kinds", async () => {
    profileRow = {
      slug: "client",
      profileKind: "role",
      applicableKinds: ["person", "company"],
    };

    // No declared type to fall back on, and two candidate kinds — an honest
    // refusal. materializeEvent catches this per-event, so the rest of the
    // batch still replicates; only the corrupt row is skipped.
    await expect(
      resolveMaterializedEntityType({ profileId: PROFILE_ID })
    ).rejects.toThrow(/references ROLE profile "client"/);
  });

  it("REFUSES a role with no applicableKinds at all", async () => {
    profileRow = {
      slug: "client",
      profileKind: "role",
      applicableKinds: null,
    };

    await expect(
      resolveMaterializedEntityType({ profileId: PROFILE_ID })
    ).rejects.toThrow(/would corrupt the peer/);
  });

  it("does not treat the role slug echoed in data.type as a valid kind", async () => {
    profileRow = {
      slug: "client",
      profileKind: "role",
      applicableKinds: ["person", "company"],
    };

    // A pod that ALREADY has the corruption would send type:'client'. Accepting
    // it would replicate the bad row instead of stopping it at the border.
    await expect(
      resolveMaterializedEntityType({ profileId: PROFILE_ID, type: "client" })
    ).rejects.toThrow(/references ROLE profile/);
  });
});
