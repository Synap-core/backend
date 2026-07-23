import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApiKeyRepository } from "../api-key-repository.js";
import type { EventRepository } from "../event-repository.js";

const OLD_KEY_ID = "00000000-0000-0000-0000-0000000000aa";
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000bb";
const PARENT_KEY_ID = "00000000-0000-0000-0000-0000000000cc";
const NEW_KEY = "synap_user_rotated-plaintext-key-material";

/**
 * A stored key row as `rotate()` reads it back. Overrides let each test pin the
 * one identity/confinement column it is about.
 */
function oldKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OLD_KEY_ID,
    userId: "user-1",
    keyName: "CI integration",
    keyPrefix: "synap_user_",
    keyHash: "$2b$12$oldbcrypthash",
    keyLookupHash: createHash("sha256")
      .update("synap_user_ORIGINAL-key-material")
      .digest("hex"),
    keyType: "service" as const,
    description: "Bound service key for CI",
    hubId: null,
    scope: ["hub-protocol.read"],
    expiresAt: null,
    workspaceId: WORKSPACE_ID,
    linkedUserId: null,
    instanceId: null,
    parentKeyId: null,
    isActive: true,
    usageCount: 41,
    ...overrides,
  };
}

function createRepository(row: ReturnType<typeof oldKeyRow>) {
  const insertedValues = vi.fn();
  const returning = vi.fn(async () => [{ id: "new-key-id" }]);
  const insert = vi.fn(() => ({
    values: (value: Record<string, unknown>) => {
      insertedValues(value);
      return { returning };
    },
  }));
  const where = vi.fn(async () => undefined);
  const update = vi.fn(() => ({ set: () => ({ where }) }));

  const database = {
    query: { apiKeys: { findFirst: vi.fn(async () => row) } },
    insert,
    update,
  } as unknown as ConstructorParameters<typeof ApiKeyRepository>[0];

  const eventRepo = { append: vi.fn(async () => undefined) };

  return {
    repository: new ApiKeyRepository(
      database,
      eventRepo as unknown as EventRepository
    ),
    insertedValues,
  };
}

async function rotate(row: ReturnType<typeof oldKeyRow>) {
  const { repository, insertedValues } = createRepository(row);
  await repository.rotate(OLD_KEY_ID, NEW_KEY, "rotating-user");
  return insertedValues.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("ApiKeyRepository.rotate — identity-preserving rotation", () => {
  it("keeps a bound service key a service key confined to the SAME workspace", async () => {
    const values = await rotate(
      oldKeyRow({ keyType: "service", workspaceId: WORKSPACE_ID })
    );

    // keyType falling back to the column default ('hub_inbound') would make
    // resolveConfinedWorkspace() short-circuit into legacy passthrough, and a
    // NULL workspaceId would let the rotated key target ANY workspace.
    expect(values.keyType).toBe("service");
    expect(values.workspaceId).toBe(WORKSPACE_ID);
  });

  it("retains linkedUserId so agent writes stay governed", async () => {
    const values = await rotate(
      oldKeyRow({ keyType: "hub_inbound", linkedUserId: "operator-9" })
    );

    // Losing linkedUserId makes the MCP handler treat the agent key as the
    // operator himself — writes stop being proposals and become direct.
    expect(values.linkedUserId).toBe("operator-9");
  });

  it("derives keyLookupHash from the NEW key material, never copying the old one", async () => {
    const row = oldKeyRow();
    const values = await rotate(row);

    expect(values.keyLookupHash).toBe(
      createHash("sha256").update(NEW_KEY).digest("hex")
    );
    expect(values.keyLookupHash).not.toBe(row.keyLookupHash);
  });

  it("carries forward instance, sub-token lineage and description, and resets usage", async () => {
    const values = await rotate(
      oldKeyRow({
        instanceId: "macbook-cli",
        parentKeyId: PARENT_KEY_ID,
        description: "Bound service key for CI",
      })
    );

    expect(values.instanceId).toBe("macbook-cli");
    expect(values.parentKeyId).toBe(PARENT_KEY_ID);
    expect(values.description).toBe("Bound service key for CI");
    // Rotation lineage + fresh counters, and the actor is recorded as creator.
    expect(values.rotatedFromId).toBe(OLD_KEY_ID);
    expect(values.createdBy).toBe("rotating-user");
    expect(values.usageCount).toBe(0);
    expect(values.isActive).toBe(true);
  });
});
