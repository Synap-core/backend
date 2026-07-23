/**
 * Regression: `generateApiKey` identity carry-over on RE-MINT (rotation).
 *
 * A fresh mint legitimately leaves keyType/workspaceId/linkedUserId/instanceId
 * at their schema defaults. A ROTATION that leaves them at their defaults
 * silently ESCALATES the replacement key:
 *   - keyType defaults to 'hub_inbound', so a rotated 'service' key stops being
 *     confined by `resolveConfinedWorkspace` (confine-workspace.ts branches on
 *     `keyType !== "service"`) and can then target ANY workspace;
 *   - linkedUserId NULL means the agent→operator link is gone, so the agent's
 *     MCP writes stop routing through the governance membrane as proposals and
 *     become operator-direct (mcp/http-handler.ts derives both from it).
 *
 * These tests pin BOTH directions: identity is written when supplied, and the
 * INSERT is untouched when it is not (so ordinary mint callers are unaffected).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, insertedValues } = vi.hoisted(() => {
  const insertedValues: Record<string, unknown>[] = [];
  return {
    insertedValues,
    mockDb: {
      insert: vi.fn(() => ({
        values: vi.fn((v: Record<string, unknown>) => {
          insertedValues.push(v);
          return {
            returning: vi.fn(async () => [{ id: "new-key-id" }]),
          };
        }),
      })),
      query: { apiKeys: { findFirst: vi.fn() } },
    },
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: mockDb };
});

// bcrypt is slow and irrelevant here — the assertions are all about which
// columns reach the INSERT, not how the material is hashed.
vi.mock("bcrypt", () => ({
  default: { hash: vi.fn(async () => "hashed") },
  hash: vi.fn(async () => "hashed"),
}));

const { apiKeyService } = await import("./api-keys.js");

describe("generateApiKey — identity carry-over", () => {
  beforeEach(() => {
    insertedValues.length = 0;
    vi.clearAllMocks();
  });

  it("omits identity columns entirely when no identity is supplied", async () => {
    await apiKeyService.generateApiKey("user-1", "ordinary mint", []);

    const values = insertedValues.at(-1)!;
    // Absent — NOT null. Present-but-null would overwrite a schema default and
    // change behavior for every ordinary caller.
    expect(values).not.toHaveProperty("keyType");
    expect(values).not.toHaveProperty("workspaceId");
    expect(values).not.toHaveProperty("linkedUserId");
    expect(values).not.toHaveProperty("instanceId");
  });

  it("keeps a rotated service key a service key confined to the SAME workspace", async () => {
    await apiKeyService.generateApiKey(
      "user-1",
      "rotated cli key",
      [],
      undefined,
      undefined,
      undefined,
      { keyType: "service", workspaceId: "ws-42" }
    );

    const values = insertedValues.at(-1)!;
    expect(values.keyType).toBe("service");
    expect(values.workspaceId).toBe("ws-42");
  });

  it("retains linkedUserId so a rotated agent key's writes stay governed", async () => {
    await apiKeyService.generateApiKey(
      "agent-user-7",
      "rotated agent key",
      [],
      undefined,
      undefined,
      undefined,
      { linkedUserId: "operator-9", instanceId: "macbook-cli" }
    );

    const values = insertedValues.at(-1)!;
    expect(values.linkedUserId).toBe("operator-9");
    expect(values.instanceId).toBe("macbook-cli");
  });

  it("carries an explicit NULL through, distinguishing it from omission", async () => {
    await apiKeyService.generateApiKey(
      "user-1",
      "rotated pod-wide key",
      [],
      undefined,
      undefined,
      undefined,
      { workspaceId: null }
    );

    const values = insertedValues.at(-1)!;
    expect(values).toHaveProperty("workspaceId");
    expect(values.workspaceId).toBeNull();
  });
});
