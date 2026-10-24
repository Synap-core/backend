import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// ONE TITLE (dogfood 68b9b7c2, 2026-10-23). A rename through `update_entity`
// answered with a write receipt whose `properties.title` still held the OLD
// name: create merges the title into the property bag (for the modeled
// `title` def, required on task and event) and stores it there, and update
// moved only the column.
//
// DB-FREE: a minimal fake db; the REAL create and update paths and the REAL
// PropertyValidationService run. The row update renames comes from the real
// create (no hand-built mirror), so deleting the projection in update fails
// the first case.
//
// Rows that rule out a wrong rule:
//  - create → rename: the bag's title follows the column (the defect);
//  - a bag with NO title key gains none (rules out "always write title");
//  - a patch sending a different `properties.title` beside `title`: the
//    column wins (one value, never two);
//  - a patch with no `title` leaves the bag's title alone;
//  - a patch sending ONLY `properties.title` renames the column too (rules
//    out "the bag follows the column, never the other way").
// ---------------------------------------------------------------------------

import { EntityRepository } from "./entity-repository.js";
import { ProfileResolutionService } from "../services/profile-resolution-service.js";
import { PropertyIndexService } from "../services/property-index-service.js";
import type { EventRepository } from "./event-repository.js";

const PROFILE_ID = "profile-task";

// The system `task` profile models `title` (required) — ensure-system-profiles.
const EFFECTIVE = [
  {
    slug: "title",
    valueType: "string",
    required: true,
    defaultValue: null,
    constraints: {},
  },
  {
    slug: "note",
    valueType: "string",
    required: false,
    defaultValue: null,
    constraints: {},
  },
];

describe("EntityRepository — the title is one value", () => {
  let stored: Record<string, unknown>;
  let written: Record<string, unknown> | undefined;
  let repo: EntityRepository;

  beforeEach(() => {
    vi.restoreAllMocks();
    written = undefined;
    stored = {};

    const db: any = {
      query: {
        entities: { findFirst: async () => stored },
      },
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              written = vals;
              return [{ ...stored, ...vals }];
            },
          }),
        }),
      }),
      insert: () => ({
        values: (vals: Record<string, unknown>) => ({
          returning: async () => {
            written = vals;
            return [{ id: "e1", ...vals }];
          },
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    };

    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEffectiveProperties"
    ).mockResolvedValue(EFFECTIVE as any);
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEffectiveLifecycle"
    ).mockResolvedValue(null as any);
    vi.spyOn(
      ProfileResolutionService.prototype,
      "resolveProfile"
    ).mockResolvedValue({
      id: PROFILE_ID,
      slug: "task",
      profileKind: "kind",
      applicableKinds: [],
    } as any);
    vi.spyOn(
      PropertyIndexService.prototype,
      "indexEntityProperties"
    ).mockResolvedValue(undefined as any);
    vi.spyOn(PropertyIndexService.prototype, "reindexEntity").mockResolvedValue(
      undefined as any
    );

    const eventRepo = { append: vi.fn().mockResolvedValue(undefined) };
    repo = new EntityRepository(db, eventRepo as unknown as EventRepository);
  });

  /** Create through the real door; the stored row is what it inserted. */
  async function created(title: string) {
    const row = await repo.create(
      { profileSlug: "task", title, properties: { note: "x" }, userId: "u1" },
      "u1"
    );
    stored = { ...row, id: "e1", userId: "u1", workspaceId: null };
    return stored;
  }

  it("a rename moves the bag's title with the column", async () => {
    const row = await created("Old name");
    // The create stores the mirror (what the receipt showed).
    expect(row.properties).toMatchObject({ title: "Old name" });

    await repo.update("e1", { title: "New name" }, "u1");

    expect(written?.title).toBe("New name");
    expect(written?.properties).toEqual({ title: "New name", note: "x" });
  });

  it("a bag with no title key gains none", async () => {
    stored = {
      id: "e1",
      userId: "u1",
      workspaceId: null,
      profileId: PROFILE_ID,
      type: "task",
      title: "Old name",
      properties: { note: "x" },
    };
    await repo.update("e1", { title: "New name" }, "u1");
    expect(written?.title).toBe("New name");
    expect(written?.properties).toEqual({ note: "x" });
  });

  it("the column wins over a different properties.title in the same patch", async () => {
    await created("Old name");
    await repo.update(
      "e1",
      { title: "New name", properties: { title: "Other" } },
      "u1"
    );
    expect(written?.title).toBe("New name");
    expect(written?.properties).toMatchObject({ title: "New name" });
  });

  it("a patch with no title leaves the bag's title alone", async () => {
    await created("Old name");
    await repo.update("e1", { properties: { note: "y" } }, "u1");
    expect(written).not.toHaveProperty("title");
    expect(written?.properties).toEqual({ title: "Old name", note: "y" });
  });

  it("a rename sent only as properties.title moves the column too", async () => {
    await created("Old name");
    await repo.update("e1", { properties: { title: "New name" } }, "u1");
    expect(written?.title).toBe("New name");
    expect(written?.properties).toEqual({ title: "New name", note: "x" });
  });
});
