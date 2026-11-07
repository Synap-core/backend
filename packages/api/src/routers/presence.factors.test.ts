/**
 * `presence.factors`: the caller's passkeys, device keys, 2FA app and
 * recovery codes, counted, the ways in they make (`presenceWaysIn`), and
 * whether the pod is in `enforce`, for
 * pod admin to say "No passkey yet" or "keep two ways in" before the person
 * relies on approvals in person. A failed read fails the call: it is never
 * read as "no factor".
 *
 * No live Postgres or Kratos: the proof service and `db` are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readPasskeys: vi.fn(),
  counts: vi.fn(),
  mode: vi.fn(),
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
  presenceFactorCounts: (userId: string) => h.counts(userId),
  issuePresenceChallenge: vi.fn(),
  verifyDeviceSignature: vi.fn(),
  passkeyRpId: () => "pod.example.test",
  passkeyRpIds: () => ["pod.example.test"],
  presencePodOrigin: () => "https://pod.example.test",
  PresenceError: class PresenceError extends Error {},
}));
vi.mock("../services/presence/mode.js", () => ({
  readPresenceMode: () => h.mode(),
  readPresenceSensitivity: vi.fn(),
  missingSince: vi.fn(),
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
  h.counts.mockReset();
  h.mode.mockReset();
  h.mode.mockResolvedValue({ mode: "enforce", source: "default" });
});

describe("presence.factors", () => {
  it("counts the caller's factors, and how many ways in they make", async () => {
    h.counts.mockResolvedValue({
      passkeys: 2,
      deviceKeys: 1,
      totp: true,
      recoveryCodes: 0,
    });
    await expect(caller().factors()).resolves.toEqual({
      enforce: true,
      passkeys: 2,
      deviceKeys: 1,
      totp: true,
      recoveryCodes: 0,
      // Every passkey is one way (they are lost together), each device key
      // one, the 2FA app one.
      waysIn: 3,
    });
    expect(h.counts).toHaveBeenCalledWith(PERSON);
  });

  it("a new owner with nothing reads zero ways in", async () => {
    h.counts.mockResolvedValue({
      passkeys: 0,
      deviceKeys: 0,
      totp: false,
      recoveryCodes: 0,
    });
    await expect(caller().factors()).resolves.toMatchObject({
      passkeys: 0,
      deviceKeys: 0,
      waysIn: 0,
    });
  });

  it("says whether approvals need the person in person, for every member", async () => {
    h.counts.mockResolvedValue({
      passkeys: 1,
      deviceKeys: 0,
      totp: false,
      recoveryCodes: 0,
    });
    h.mode.mockResolvedValue({ mode: "report", source: "setting" });
    await expect(caller().factors()).resolves.toMatchObject({
      enforce: false,
      waysIn: 1,
    });
  });

  it("a failed mode read fails the call, never 'report'", async () => {
    h.counts.mockResolvedValue({
      passkeys: 1,
      deviceKeys: 0,
      totp: false,
      recoveryCodes: 0,
    });
    h.mode.mockRejectedValue(new Error("db down"));
    await expect(caller().factors()).rejects.toThrow();
  });

  it("a failed read fails the call, never 'no factor'", async () => {
    h.counts.mockRejectedValue(new Error("kratos: 503"));
    await expect(caller().factors()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.stringMatching(/passkeys/),
    });
  });
});
