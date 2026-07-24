/**
 * apiKeys.beginMcpConnect — CP-MCP consent-code mint (pod side, §2-3).
 *
 * (a) inserts a HASHED code (never the plaintext) and returns the raw code once;
 *     the stored code_hash equals sha256(returnedCode) and is not the plaintext.
 *     Also asserts the human-only guard rejects a non-human caller.
 *
 * No live Postgres: `@synap/database` (db.query.users.findFirst + db.insert),
 * the read-only guard, and the audit logger are mocked. `@synap/database/schema`
 * stays real (table objects are inert here).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const findFirstUser = vi.fn();
const insertValues = vi.fn((_v: unknown) => Promise.resolve());

// Partial mock: keep every real export (operators like isNull are used across the
// import graph, e.g. @synap/jobs) and override ONLY `db` with an inert stub.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    db: {
      query: { users: { findFirst: (...a: unknown[]) => findFirstUser(...a) } },
      insert: () => ({ values: (v: unknown) => insertValues(v) }),
    },
  };
});

// Read-only guard runs on every mutation — keep the pod writable.
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));

vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));

// Import AFTER mocks.
import { apiKeysRouter } from "./api-keys.js";

function caller(userId: string) {
  return apiKeysRouter.createCaller({
    authenticated: true,
    userId,
  } as never);
}

beforeEach(() => {
  findFirstUser.mockReset();
  insertValues.mockClear();
});

describe("apiKeys.beginMcpConnect", () => {
  it("stores sha256(code) and returns the raw code once", async () => {
    findFirstUser.mockResolvedValue({ id: "human-1", userType: "human" });

    const result = await caller("human-1").beginMcpConnect({
      agentType: "claude-web",
      scopes: ["mcp:read", "mcp:write"],
    });

    // Raw code returned once.
    expect(typeof result.code).toBe("string");
    expect(result.code.length).toBeGreaterThan(20);

    // Exactly one row inserted.
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0][0] as Record<string, unknown>;

    // Only the HASH is persisted — never the plaintext.
    expect(row.codeHash).toBe(
      createHash("sha256").update(result.code).digest("hex")
    );
    expect(row.codeHash).not.toBe(result.code);

    // Bound to the acting human + agentType + CP-grammar scopes, with a future TTL.
    expect(row.podUserId).toBe("human-1");
    expect(row.agentType).toBe("claude-web");
    expect(row.scopes).toEqual(["mcp:read", "mcp:write"]);
    expect(row.expiresAt).toBeInstanceOf(Date);
    expect((row.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a non-human caller (agent cannot author consent)", async () => {
    findFirstUser.mockResolvedValue({ id: "agent-1", userType: "agent" });
    await expect(
      caller("agent-1").beginMcpConnect({ agentType: "claude-web" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(insertValues).not.toHaveBeenCalled();
  });
});
