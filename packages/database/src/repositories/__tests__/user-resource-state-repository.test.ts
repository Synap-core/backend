import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { UserResourceStateRepository } from "../user-resource-state-repository.js";

const state = {
  userId: "user-1",
  resourceId: "00000000-0000-0000-0000-000000000001",
  resourceType: "entity" as const,
  starred: false,
  pinned: true,
  semanticSize: "large" as const,
  lastOpenedAt: null,
  openCount: 0,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function createInsertDatabase() {
  const returning = vi.fn(async () => [state]);
  const onConflictDoUpdate = vi.fn((_config: unknown) => ({ returning }));
  const values = vi.fn((_value: unknown) => ({ onConflictDoUpdate }));
  const insert = vi.fn((_table: unknown) => ({ values }));
  const database = { insert } as unknown as ConstructorParameters<
    typeof UserResourceStateRepository
  >[0];

  return { database, values, onConflictDoUpdate };
}

describe("UserResourceStateRepository", () => {
  it("upserts pin and semantic size without touching open telemetry", async () => {
    const { database, values, onConflictDoUpdate } = createInsertDatabase();
    const repository = new UserResourceStateRepository(database);

    await repository.update("user-1", state.resourceId, "entity", {
      pinned: true,
      semanticSize: "large",
    });

    expect(values).toHaveBeenCalledWith({
      userId: "user-1",
      resourceId: state.resourceId,
      resourceType: "entity",
      pinned: true,
      semanticSize: "large",
    });
    const conflict = onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(conflict.set).toMatchObject({ pinned: true, semanticSize: "large" });
    expect(conflict.set).not.toHaveProperty("openCount");
    expect(conflict.set).not.toHaveProperty("lastOpenedAt");
  });

  it("increments telemetry only through recordOpen", async () => {
    const { database, values, onConflictDoUpdate } = createInsertDatabase();
    const repository = new UserResourceStateRepository(database);

    await repository.recordOpen("user-1", state.resourceId, "entity");

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        resourceId: state.resourceId,
        resourceType: "entity",
        openCount: 1,
        lastOpenedAt: expect.any(Date),
      })
    );
    const conflict = onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(conflict.set).toEqual(
      expect.objectContaining({ lastOpenedAt: expect.any(Date) })
    );
    expect(conflict.set).toHaveProperty("openCount");
  });
});

describe("0186 user resource state migration", () => {
  const migration = readFileSync(
    new URL(
      "../../../migrations/0186_user_resource_state.sql",
      import.meta.url
    ),
    "utf8"
  );

  it("keeps the legacy physical contract valid during canary rollout", () => {
    expect(migration).toContain('ALTER TABLE "user_entity_state"');
    expect(migration).not.toContain(
      'ALTER TABLE "user_entity_state" RENAME TO "user_resource_state"'
    );
    expect(migration).not.toContain(
      'RENAME COLUMN "view_count" TO "open_count"'
    );
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
  });

  it("constrains semantic sizes to the supported vocabulary", () => {
    expect(migration).toContain(
      "CHECK (\"semantic_size\" IS NULL OR \"semantic_size\" IN ('small', 'medium', 'large'))"
    );
  });
});
