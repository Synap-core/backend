import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// DB-FREE unit tests for the kind-vs-facet write guard in
// `EntityRepository.create`: a create aimed at a role profile (a "hat") must
// be adapted to write the entity on the role's underlying KIND, with the role
// attached as a facet — never created directly under the role's own slug —
// and a role with more than one applicable kind must be rejected outright
// (it can't guess which entity to attach to).
//
// Postgres is down in this environment, so the DB boundary is faked with a
// minimal chainable `insert().values().returning()` + `transaction()` stand-
// in (same pattern as entity-body-service.test.ts), and the two service
// boundaries the create path calls out to — `ProfileResolutionService` and
// `FacetRepository` — are spied on their prototypes so the real
// `EntityRepository.create` code path runs untouched.
// ---------------------------------------------------------------------------

import {
  EntityRepository,
  EntityCreateRejectedError,
} from "./entity-repository.js";
import { ProfileResolutionService } from "../services/profile-resolution-service.js";
import { FacetRepository } from "./facet-repository.js";
import type { EventRepository } from "./event-repository.js";

describe("EntityRepository.create — kind vs facet write guard", () => {
  let insertedRows: Record<string, unknown>[];
  let db: any;
  let eventRepo: { append: ReturnType<typeof vi.fn> };
  let attachSpy: ReturnType<typeof vi.spyOn>;
  let emitAttachSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    insertedRows = [];

    db = {
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown>) => ({
          returning: async () => {
            const row = {
              id: (vals.id as string) ?? `generated-${insertedRows.length}`,
              ...vals,
            };
            insertedRows.push(row);
            return [row];
          },
        }),
      }),
      // The role-adapter write path runs the insert + facet attach inside a
      // transaction — the fake just replays the callback against the same
      // fake db (no real tx isolation needed for this assertion).
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    };

    eventRepo = { append: vi.fn().mockResolvedValue(undefined) };

    // Profile resolution: a single-kind role ("client" -> person), a plain
    // kind ("person"), and a multi-kind role ("deal" -> person|company).
    vi.spyOn(
      ProfileResolutionService.prototype,
      "resolveProfile"
    ).mockImplementation(async (ref: string) => {
      if (ref === "client")
        return {
          id: "role-client-id",
          slug: "client",
          profileKind: "role",
          applicableKinds: ["person"],
        } as any;
      if (ref === "person")
        return {
          id: "kind-person-id",
          slug: "person",
          profileKind: "kind",
          applicableKinds: [],
        } as any;
      if (ref === "deal")
        return {
          id: "role-deal-id",
          slug: "deal",
          profileKind: "role",
          applicableKinds: ["person", "company"],
        } as any;
      return null;
    });

    attachSpy = vi
      .spyOn(FacetRepository.prototype, "attach")
      .mockResolvedValue({
        id: "facet-1",
        entityId: "generated-0",
        profileId: "role-client-id",
      } as any);
    emitAttachSpy = vi
      .spyOn(FacetRepository.prototype, "emitAttachCompletedEvent")
      .mockResolvedValue(undefined as any);
  });

  it("Case A: a single-kind role create lands on the KIND, with the role attached as a facet", async () => {
    const repo = new EntityRepository(
      db,
      eventRepo as unknown as EventRepository
    );

    const result = await repo.create(
      {
        profileSlug: "client", // role
        userId: "user-1",
        properties: { phone: "555-0100" },
        skipValidation: true,
      },
      "user-1"
    );

    // The inserted row's type is the KIND slug ('person'), never the role
    // slug ('client') — this is the invariant #2 exists to protect.
    expect(result.type).toBe("person");
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]?.type).toBe("person");
    expect(insertedRows[0]?.profileId).toBe("kind-person-id");

    // The role attaches as a facet on the newly-created kind entity, carrying
    // the properties the caller supplied for the role.
    expect(attachSpy).toHaveBeenCalledTimes(1);
    const attachArg = attachSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(attachArg.profileId).toBe("role-client-id");
    expect(attachArg.entityId).toBe(result.id);
    expect(attachArg.properties).toEqual({ phone: "555-0100" });
    expect(emitAttachSpy).toHaveBeenCalledTimes(1);
  });

  it("Case B: a role with more than one applicable kind is rejected, not silently created", async () => {
    const repo = new EntityRepository(
      db,
      eventRepo as unknown as EventRepository
    );

    await expect(
      repo.create(
        {
          profileSlug: "deal", // role with 2 applicable kinds
          userId: "user-1",
          skipValidation: true,
        },
        "user-1"
      )
    ).rejects.toBeInstanceOf(EntityCreateRejectedError);

    // Rejected before any write — no entity row, no facet attach.
    expect(insertedRows).toHaveLength(0);
    expect(attachSpy).not.toHaveBeenCalled();
  });
});
