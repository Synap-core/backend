/**
 * ApiKeyService.generateApiKey — optional identity carry-over.
 *
 * `generateApiKey` is a SHARED mint door. It is used both to create brand-new
 * credentials (which must keep taking the schema defaults for keyType /
 * workspaceId / linkedUserId / instanceId / description) and, since the
 * rotate-cli fix, to RE-MINT an existing credential, which must carry those
 * columns over verbatim.
 *
 * These tests pin BOTH halves of that contract:
 *   1. identity supplied  → the columns land in the INSERT.
 *   2. identity omitted   → the columns are ABSENT from the INSERT, i.e. the
 *      row is written exactly as it was before the parameter existed. This is
 *      the backward-compatibility guarantee for every pre-existing caller.
 *
 * No live DB: the `@synap/database` module is stubbed down to the single
 * insert chain this method uses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Captures the object handed to `.values()` on the last insert. */
let lastInsertValues: Record<string, unknown> | undefined;

vi.mock("@synap/database", () => {
  const insert = vi.fn(() => ({
    values: (v: Record<string, unknown>) => {
      lastInsertValues = v;
      return { returning: async () => [{ id: "minted-key-id" }] };
    },
  }));

  return {
    db: { insert, select: vi.fn(), update: vi.fn() },
    sql: vi.fn(),
    drizzleSql: Object.assign(vi.fn(), { raw: vi.fn() }),
    apiKeys: { id: "id", usageCount: "usage_count", createdAt: "created_at" },
    KEY_PREFIXES: {
      HUB_LIVE: "synap_hub_live_",
      HUB_TEST: "synap_hub_test_",
      USER: "synap_user_",
    },
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    isNull: vi.fn(),
    gt: vi.fn(),
  };
});

// bcrypt at cost 12 is ~200ms per hash and contributes nothing here.
vi.mock("bcrypt", () => ({
  default: { hash: async () => "$2b$12$stub", compare: async () => false },
}));

import { apiKeyService } from "./api-keys.js";

const IDENTITY_COLUMNS = [
  "keyType",
  "workspaceId",
  "linkedUserId",
  "instanceId",
  "description",
] as const;

describe("ApiKeyService.generateApiKey — identity carry-over", () => {
  beforeEach(() => {
    lastInsertValues = undefined;
  });

  it("writes the identity columns when a rotation caller supplies them", async () => {
    await apiKeyService.generateApiKey(
      "user-1",
      "claude-code CLI",
      ["hub-protocol.read"],
      undefined,
      undefined,
      undefined,
      {
        keyType: "service",
        workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        linkedUserId: "operator-42",
        instanceId: "laptop-1",
        description: "CLI key for the laptop",
      }
    );

    expect(lastInsertValues).toMatchObject({
      keyType: "service",
      workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      linkedUserId: "operator-42",
      instanceId: "laptop-1",
      description: "CLI key for the laptop",
    });
  });

  it("writes explicit NULLs rather than dropping cleared identity fields", async () => {
    await apiKeyService.generateApiKey(
      "user-1",
      "plain key",
      ["hub-protocol.read"],
      undefined,
      undefined,
      undefined,
      {
        keyType: "user_pat",
        workspaceId: null,
        linkedUserId: null,
        instanceId: null,
        description: null,
      }
    );

    expect(lastInsertValues).toMatchObject({
      keyType: "user_pat",
      workspaceId: null,
      linkedUserId: null,
      instanceId: null,
      description: null,
    });
  });

  it("BACKWARD COMPAT: omits every identity column when no identity is passed", async () => {
    await apiKeyService.generateApiKey("user-1", "fresh key", [
      "hub-protocol.read",
    ]);

    for (const column of IDENTITY_COLUMNS) {
      expect(lastInsertValues).not.toHaveProperty(column);
    }
    // The rest of the row is untouched by the new parameter.
    expect(lastInsertValues).toMatchObject({
      userId: "user-1",
      keyName: "fresh key",
      keyPrefix: "synap_user_",
      isActive: true,
      parentKeyId: null,
      hubId: null,
    });
  });

  it("BACKWARD COMPAT: omits identity columns for the existing 4-arg hub-key call shape", async () => {
    await apiKeyService.generateApiKey(
      "user-1",
      "hub key",
      ["hub-protocol.read"],
      "synap-hub-prod"
    );

    for (const column of IDENTITY_COLUMNS) {
      expect(lastInsertValues).not.toHaveProperty(column);
    }
    expect(lastInsertValues).toMatchObject({
      hubId: "synap-hub-prod",
      keyPrefix: "synap_hub_live_",
    });
  });
});
