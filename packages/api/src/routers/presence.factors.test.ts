/**
 * `presence.factors`: the caller's passkeys and Relay device keys, counted,
 * for pod admin to say "No passkey yet · Add one" before the person relies on
 * approvals in person. A failed passkey read fails the call: it is never read
 * as "no passkey".
 *
 * No live Postgres or Kratos: the proof service and `db` are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readPasskeys: vi.fn(),
  deviceRows: [] as Array<{ n: number }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    db: {
      select: () => ({ from: () => ({ where: async () => h.deviceRows }) }),
    },
  };
});

vi.mock("../services/presence/proof.js", () => ({
  readPasskeys: (userId: string) => h.readPasskeys(userId),
  issuePresenceChallenge: vi.fn(),
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

beforeEach(() => {
  h.readPasskeys.mockReset();
  h.deviceRows = [];
});

describe("presence.factors", () => {
  it("counts the caller's passkeys and device keys", async () => {
    h.readPasskeys.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    h.deviceRows = [{ n: 1 }];
    await expect(caller().factors()).resolves.toEqual({
      passkeys: 2,
      deviceKeys: 1,
    });
    expect(h.readPasskeys).toHaveBeenCalledWith(PERSON);
  });

  it("a new owner with neither reads zero and zero", async () => {
    h.readPasskeys.mockResolvedValue([]);
    h.deviceRows = [{ n: 0 }];
    await expect(caller().factors()).resolves.toEqual({
      passkeys: 0,
      deviceKeys: 0,
    });
  });

  it("a failed passkey read fails the call, never 'no passkey'", async () => {
    h.readPasskeys.mockRejectedValue(new Error("kratos: 503"));
    await expect(caller().factors()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.stringMatching(/passkeys/),
    });
  });
});
