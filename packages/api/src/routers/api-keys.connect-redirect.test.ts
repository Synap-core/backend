/**
 * apiKeys.connectIntegration refuses a delivery target outside the default
 * allowlist BEFORE it reads or mints anything (pre-launch audit 2026-10-28,
 * F3: `http://localhost:@attacker.example/` passed a string-prefix test on the
 * page and the browser carried the minted key to attacker.example).
 *
 * No live Postgres: `db` is a stub whose workspace-membership read is the
 * first thing the mutation touches after the redirect check. An admitted
 * redirect reaches it (and is refused there: no membership); a refused one
 * never does.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findMembership = vi.fn(async (..._a: unknown[]) => null);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    db: {
      query: {
        workspaceMembers: {
          findFirst: (...a: unknown[]) => findMembership(...a),
        },
      },
    },
  };
});

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));

// Import AFTER mocks.
import { apiKeysRouter } from "./api-keys.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function connect(redirectUri: string) {
  return apiKeysRouter
    .createCaller({ authenticated: true, userId: "human-1" } as never)
    .connectIntegration({
      integration: "cli",
      workspaceId: WORKSPACE_ID,
      redirectUri,
    });
}

beforeEach(() => {
  findMembership.mockClear();
});

describe("apiKeys.connectIntegration redirectUri", () => {
  it.each([
    "http://localhost:@attacker.example/cb",
    "http://127.0.0.1:80@attacker.example/",
    "https://attacker.example/cb",
  ])("refuses %s before reading or minting anything", async (uri) => {
    await expect(connect(uri)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(findMembership).not.toHaveBeenCalled();
  });

  it("admits the CLI loopback callback (reaches the membership check)", async () => {
    await expect(
      connect("http://127.0.0.1:53123/callback")
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(findMembership).toHaveBeenCalledTimes(1);
  });
});
