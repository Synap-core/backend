import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// DB-FREE tests for tickets #10 / #14: a PARTIAL `EntityRepository.update`
// answers only for the keys it writes. A legacy value in an untouched key
// (an enum option retired after the row was written, a required field added
// later) must not make the row un-editable — and must be stored verbatim, not
// "fixed". A key the patch DOES write is still validated, a patch that
// deletes a required field is still refused, and create still validates the
// whole bag.
//
// The DB is a minimal fake (`query.entities.findFirst` + chainable
// `update().set().where().returning()` + `insert`); `getEffectiveProperties`
// is spied on the ProfileResolutionService prototype, so the REAL
// PropertyValidationService and the REAL update/create paths run.
// ---------------------------------------------------------------------------

import { EntityRepository } from "./entity-repository.js";
import { ProfileResolutionService } from "../services/profile-resolution-service.js";
import { PropertyIndexService } from "../services/property-index-service.js";
import type { EventRepository } from "./event-repository.js";

const PROFILE_ID = "profile-task";

// `stage` gained its enum after rows were written ("legacy" is no longer an
// option); `owner` became required after rows were written.
const EFFECTIVE = [
  {
    slug: "stage",
    valueType: "string",
    required: false,
    defaultValue: null,
    constraints: { enum: ["todo", "doing", "done"] },
  },
  {
    slug: "priority",
    valueType: "string",
    required: false,
    defaultValue: null,
    constraints: { enum: ["low", "high"] },
  },
  {
    slug: "owner",
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

describe("EntityRepository.update — validates only the keys the patch writes", () => {
  let stored: Record<string, unknown>;
  let written: Record<string, unknown> | undefined;
  let repo: EntityRepository;

  beforeEach(() => {
    vi.restoreAllMocks();
    written = undefined;
    stored = {
      id: "e1",
      userId: "u1",
      workspaceId: "ws1",
      profileId: PROFILE_ID,
      type: "task",
      title: "Legacy task",
      status: null,
      // Two pre-existing violations: `stage` is a retired option and the
      // later-required `owner` is missing.
      properties: { stage: "legacy", priority: "low", note: "x" },
    };

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
            return [{ id: "new", ...vals }];
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
    vi.spyOn(PropertyIndexService.prototype, "reindexEntity").mockResolvedValue(
      undefined as any
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const eventRepo = { append: vi.fn().mockResolvedValue(undefined) };
    repo = new EntityRepository(db, eventRepo as unknown as EventRepository);
  });

  it("accepts a valid edit of one key while untouched keys hold legacy violations, storing them verbatim", async () => {
    await repo.update("e1", { properties: { priority: "high" } }, "u1");

    expect(written?.properties).toEqual({
      stage: "legacy",
      priority: "high",
      note: "x",
    });
    // Surfaced, not swallowed: the only channel is the log (no warnings
    // field exists on the update receipt).
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("pre-existing property violations")
    );
  });

  it("accepts the edit that FIXES one legacy key without resending the other bad one", async () => {
    await repo.update("e1", { properties: { stage: "done" } }, "u1");
    expect(written?.properties).toMatchObject({ stage: "done" });
    expect(written?.properties).not.toHaveProperty("owner");
  });

  it("still refuses an invalid value in a key the patch writes", async () => {
    await expect(
      repo.update("e1", { properties: { priority: "urgent" } }, "u1")
    ).rejects.toThrow(
      /Property validation failed: Property 'priority': Value 'urgent' not in enum/
    );
    expect(written).toBeUndefined();
  });

  it("does not blame the patch for an untouched violation when refusing it", async () => {
    await expect(
      repo.update("e1", { properties: { priority: "urgent" } }, "u1")
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringMatching(/legacy|owner/),
      })
    );
  });

  it("still refuses a patch that deletes a required field", async () => {
    stored.properties = { stage: "todo", owner: "ann" };
    await expect(
      repo.update("e1", { deleteProperties: ["owner"] }, "u1")
    ).rejects.toThrow(/Property 'owner' is required/);
    expect(written).toBeUndefined();
  });

  it("still refuses deleting a required field on a row that also holds legacy violations", async () => {
    // Untouched `stage` is invalid, so the whole-bag check fails and the
    // patch-scoped check decides — it must still see the deleted required key.
    stored.properties = { stage: "legacy", owner: "ann" };
    await expect(
      repo.update("e1", { deleteProperties: ["owner"] }, "u1")
    ).rejects.toThrow(
      /^Property validation failed: Property 'owner' is required$/
    );
    expect(written).toBeUndefined();
  });

  it("a whole-bag resend that leaves legacy values unchanged is not refused", async () => {
    await repo.update(
      "e1",
      { properties: { stage: "legacy", priority: "high", note: "x" } },
      "u1"
    );
    expect(written?.properties).toMatchObject({
      stage: "legacy",
      priority: "high",
    });
  });

  it("create still validates the whole bag", async () => {
    await expect(
      repo.create(
        {
          profileId: PROFILE_ID,
          title: "New",
          properties: { stage: "legacy" },
          workspaceId: "ws1",
          userId: "u1",
        },
        "u1"
      )
    ).rejects.toThrow(/Property validation failed/);
    expect(written).toBeUndefined();
  });
});
