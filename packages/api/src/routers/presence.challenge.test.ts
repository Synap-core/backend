/**
 * `presence.challenge` (W3): a failed read of the person's passkeys is NOT
 * "no passkey". The call fails, before any challenge is issued, so the client
 * shows a failed read with Try again instead of silently hiding the passkey
 * option (review of the connect wave, Lane A).
 *
 * No live Postgres or Kratos: the proof service and `db` are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readPasskeys: vi.fn(),
  issue: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    db: {
      select: () => ({ from: () => ({ where: async () => [] }) }),
    },
  };
});

vi.mock("../services/presence/proof.js", () => ({
  readPasskeys: (userId: string) => h.readPasskeys(userId),
  issuePresenceChallenge: (args: unknown) => h.issue(args),
  verifyDeviceSignature: vi.fn(),
  passkeyRpId: () => "pod.example.test",
  passkeyRpIds: () => ["pod.example.test"],
  presencePodOrigin: () => "https://pod.example.test",
  PresenceError: class PresenceError extends Error {},
}));
vi.mock("../services/agent-connect.js", () => ({
  openAgentConnectProposal: vi.fn(async () => null),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));

import { presenceRouter } from "./presence.js";

const PERSON = "11111111-1111-4111-8111-111111111111";
const caller = () =>
  presenceRouter.createCaller({
    authenticated: true,
    userId: PERSON,
    session: { identity: { id: PERSON } },
  } as never);
const KEY_REQUEST = { request: { kind: "key_request" as const, id: "kr-1" } };

beforeEach(() => {
  h.readPasskeys.mockReset();
  h.issue.mockReset();
  h.issue.mockResolvedValue({
    challengeId: "22222222-2222-4222-8222-222222222222",
    nonce: "n",
    message: "m",
    webauthnChallenge: "w",
    expiresAt: new Date(Date.now() + 120_000),
  });
});

describe("presence.challenge — a failed passkey read is not 'no passkey'", () => {
  it("fails the call, and issues no challenge", async () => {
    h.readPasskeys.mockRejectedValue(new Error("kratos: 503"));
    await expect(caller().challenge(KEY_REQUEST)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.stringMatching(/passkeys/),
    });
    expect(h.issue).not.toHaveBeenCalled();
  });

  it("a person with no passkey gets a challenge with no passkey option", async () => {
    h.readPasskeys.mockResolvedValue([]);
    const res = await caller().challenge(KEY_REQUEST);
    expect(res.subject).toBe("key_request:kr-1");
    expect(res.passkey).toBeNull();
    expect(h.issue).toHaveBeenCalledTimes(1);
  });
});
