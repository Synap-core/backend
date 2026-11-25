/**
 * `presence.deviceLink.*` and the session binding of
 * `presence.authorizePasskeyChange` ("Add this device", founder decision of
 * 9 Nov 2026, session 84c74a23): the router hands every service the CALLER's
 * own session key (`kratos:<Kratos session id>` for a browser,
 * `device:<person_devices id>` for a Synap app's device token), refuses a
 * caller with no session to bind before anything is proved, and maps each
 * device-link refusal to its tRPC code with its reasonCode.
 *
 * No live Postgres or Kratos: the device-link service, the gate and the
 * grant stamp are mocked; the session-key derivation is the real one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  request: vi.fn(),
  status: vi.fn(),
  pending: vi.fn(),
  approve: vi.fn(),
  decline: vi.fn(),
  gate: vi.fn(),
  stamp: vi.fn(),
}));

vi.mock("../services/presence/device-link.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestDeviceLink: (a: unknown) => h.request(a),
  deviceLinkStatus: (a: unknown) => h.status(a),
  pendingDeviceLinks: (a: unknown) => h.pending(a),
  approveDeviceLink: (a: unknown) => h.approve(a),
  declineDeviceLink: (a: unknown) => h.decline(a),
}));
vi.mock("../services/presence/gate.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertPresenceForRequest: (a: unknown) => h.gate(a),
}));
vi.mock("../services/presence/passkey-change.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stampPasskeyChangeGrant: (a: unknown) => h.stamp(a),
}));
vi.mock("../services/agent-connect.js", () => ({
  openAgentConnectProposal: vi.fn(async () => null),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));

import { presenceRouter } from "./presence.js";
import { PresenceError } from "../services/presence/proof.js";

const PERSON = "11111111-1111-4111-8111-111111111111";
const LINK = "22222222-2222-4222-8222-222222222222";
const browser = (id: string | null = "kratos-session-here") =>
  presenceRouter.createCaller({
    authenticated: true,
    userId: PERSON,
    sessionKind: "kratos",
    session: { ...(id ? { id } : {}), identity: { id: PERSON } },
  } as never);
const device = (id = "device-row") =>
  presenceRouter.createCaller({
    authenticated: true,
    userId: PERSON,
    sessionKind: "person_device",
    session: {
      identity: { id: PERSON },
      device: { id, clientId: "relay", authTime: new Date() },
    },
  } as never);

/** A refusal's tRPC code and reasonCode (`cause.reasonCode` on the wire). */
async function refusalOf(
  p: Promise<unknown>
): Promise<{ code: unknown; reasonCode: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: unknown; cause?: { reasonCode?: unknown } };
    return { code: e.code, reasonCode: e.cause?.reasonCode };
  }
  throw new Error("expected a refusal");
}

const proof = {
  kind: "device_key" as const,
  challengeId: "33333333-3333-4333-8333-333333333333",
  keyId: "44444444-4444-4444-8444-444444444444",
  signature: "c2lnbmF0dXJl",
};

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
});

describe("presence.deviceLink", () => {
  it("asks with the caller's own session key: a browser's Kratos session, or a device's row", async () => {
    const expiresAt = new Date("2026-11-09T12:05:00Z");
    h.request.mockResolvedValue({
      needed: true,
      id: LINK,
      number: "42",
      expiresAt,
    });
    await expect(
      browser().deviceLink.request({ kind: "passkey", label: " iPhone " })
    ).resolves.toEqual({
      needed: true,
      id: LINK,
      number: "42",
      expiresAt: expiresAt.toISOString(),
    });
    expect(h.request).toHaveBeenLastCalledWith({
      userId: PERSON,
      sessionKey: "kratos:kratos-session-here",
      kind: "passkey",
      label: "iPhone",
      keyFingerprint: null,
    });
    await device().deviceLink.request({
      kind: "device_key",
      label: "Relay",
      keyFingerprint: "a".repeat(64),
    });
    expect(h.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionKey: "device:device-row",
        keyFingerprint: "a".repeat(64),
      })
    );
  });

  it("GUARDRAIL: a caller with no session to bind is refused before anything is asked or approved", async () => {
    for (const call of [
      () => browser(null).deviceLink.request({ kind: "passkey", label: "x" }),
      () => browser(null).deviceLink.status({ id: LINK }),
      () => browser(null).deviceLink.pending(),
      () =>
        browser(null).deviceLink.approve({
          id: LINK,
          number: "42",
          presence: proof,
        }),
    ]) {
      expect(await refusalOf(call())).toEqual({
        code: "FORBIDDEN",
        reasonCode: "PRESENCE_DEVICE_LINK_NO_SESSION",
      });
    }
    expect(h.request).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("approves from the caller's session, with the number and the proof", async () => {
    h.approve.mockResolvedValue({ approved: true });
    await expect(
      device("relay-row").deviceLink.approve({
        id: LINK,
        number: "07",
        presence: proof,
      })
    ).resolves.toEqual({ approved: true });
    expect(h.approve).toHaveBeenCalledWith({
      userId: PERSON,
      sessionKey: "device:relay-row",
      id: LINK,
      number: "07",
      proof,
    });
    await expect(
      device().deviceLink.approve({ id: LINK, number: "7" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps each refusal to its tRPC code, with its reasonCode", async () => {
    const cases = [
      ["PRESENCE_DEVICE_LINK_MISMATCH", "BAD_REQUEST"],
      ["PRESENCE_DEVICE_LINK_GONE", "NOT_FOUND"],
      ["PRESENCE_DEVICE_LINK_SELF", "FORBIDDEN"],
      ["PRESENCE_DEVICE_LINK_RATE", "TOO_MANY_REQUESTS"],
    ] as const;
    for (const [reasonCode, code] of cases) {
      h.approve.mockRejectedValueOnce(new PresenceError(reasonCode, "words"));
      expect(
        await refusalOf(device().deviceLink.approve({ id: LINK, number: "42" }))
      ).toEqual({ code, reasonCode });
    }
  });

  it("declines from any session of the person, even one with no key to bind", async () => {
    h.decline.mockResolvedValue({ status: "declined" });
    await expect(
      browser(null).deviceLink.decline({ id: LINK })
    ).resolves.toEqual({ status: "declined" });
    expect(h.decline).toHaveBeenCalledWith({ userId: PERSON, id: LINK });
  });

  it("the pending list never carries a match number, and is the caller's view", async () => {
    const at = new Date("2026-11-09T12:00:00Z");
    h.pending.mockResolvedValue([
      {
        id: LINK,
        kind: "passkey",
        label: "iPhone",
        createdAt: at,
        expiresAt: at,
        choices: ["12", "42", "77"],
      },
    ]);
    const rows = await device("relay-row").deviceLink.pending();
    expect(h.pending).toHaveBeenCalledWith({
      userId: PERSON,
      sessionKey: "device:relay-row",
    });
    expect(rows[0]).not.toHaveProperty("number");
    expect(rows[0]).not.toHaveProperty("matchNumber");
  });
});

describe("presence.authorizePasskeyChange is bound to the session that proved it", () => {
  it("stamps the consumed challenge with the caller's session key", async () => {
    h.gate.mockResolvedValue({
      method: "device_key",
      deviceKeyId: null,
      deviceLabel: null,
      challengeId: proof.challengeId,
    });
    h.stamp.mockResolvedValue(true);
    await expect(
      browser().authorizePasskeyChange({ presence: proof })
    ).resolves.toMatchObject({ authorized: true });
    expect(h.stamp).toHaveBeenCalledWith({
      userId: PERSON,
      challengeId: proof.challengeId,
      sessionKey: "kratos:kratos-session-here",
    });
  });

  it("GUARDRAIL: with no session to bind, the proof is never used", async () => {
    expect(
      await refusalOf(browser(null).authorizePasskeyChange({ presence: proof }))
    ).toEqual({
      code: "FORBIDDEN",
      reasonCode: "PRESENCE_DEVICE_LINK_NO_SESSION",
    });
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.stamp).not.toHaveBeenCalled();
  });
});
