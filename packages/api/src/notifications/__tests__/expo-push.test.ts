/**
 * A dead device must not be retried forever.
 *
 * Expo answers a send with one ticket PER TOKEN, positionally. A ticket whose
 * `details.error` is `DeviceNotRegistered` means that token can never receive
 * again (app uninstalled, token rotated). If the row stayed `connected`, every
 * subsequent notification would re-send to it, and its failures would slowly
 * push the shared circuit breaker open — one uninstalled app degrading push for
 * every other device the user owns.
 *
 * These tests pin the ticket→revocation wiring and the owner floor on the read.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockFindMany, mockSetStatusForUser, mockFetch } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockSetStatusForUser: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { query: { messagingAccounts: { findMany: mockFindMany } } },
  };
});

vi.mock("../../services/messaging-account-service.js", () => ({
  MessagingAccountService: { setStatusForUser: mockSetStatusForUser },
}));

import { sendExpoPush } from "../expo-push.js";
import { MESSAGING_ACCOUNT_PROVIDER_EXPO } from "@synap/database";

const USER = "11111111-1111-4111-8111-111111111111";
const LIVE = "ExponentPushToken[live]";
const DEAD = "ExponentPushToken[dead]";

/** One Expo HTTP 200 carrying the given tickets, in request order. */
function expoResponds(tickets: unknown[]) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ data: tickets }),
  });
}

beforeEach(() => {
  mockFindMany.mockReset();
  mockSetStatusForUser.mockReset().mockResolvedValue(true);
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

describe("sendExpoPush — DeviceNotRegistered revocation", () => {
  it("flips ONLY the dead token's account to disconnected, and keeps the live one", async () => {
    mockFindMany.mockResolvedValue([
      { externalId: LIVE },
      { externalId: DEAD },
    ]);
    expoResponds([
      { status: "ok", id: "ticket-1" },
      {
        status: "error",
        message: "…",
        details: { error: "DeviceNotRegistered" },
      },
    ]);

    const outcome = await sendExpoPush({
      userId: USER,
      title: "Review: entity.create",
      body: "Create ACME Corp",
    });

    expect(outcome).toEqual({ sent: 1, revoked: 1, failed: 1 });

    // Revocation goes through the OWNER-FLOORED door, not the webhook-shaped
    // `updateStatus` that matches on (externalId, provider) alone — a push
    // token is guessable, so the write must pin `user_id`.
    expect(mockSetStatusForUser).toHaveBeenCalledTimes(1);
    expect(mockSetStatusForUser).toHaveBeenCalledWith({
      userId: USER,
      provider: MESSAGING_ACCOUNT_PROVIDER_EXPO,
      externalId: DEAD,
      status: "disconnected",
    });
  });

  it("a NON-DeviceNotRegistered ticket error does NOT revoke the device", async () => {
    // `MessageRateExceeded` is transient. Revoking on any error would let one
    // throttled send permanently unsubscribe a perfectly good phone.
    mockFindMany.mockResolvedValue([{ externalId: LIVE }]);
    expoResponds([
      { status: "error", details: { error: "MessageRateExceeded" } },
    ]);

    const outcome = await sendExpoPush({ userId: USER, title: "t", body: "b" });

    expect(outcome).toEqual({ sent: 0, revoked: 0, failed: 1 });
    expect(mockSetStatusForUser).not.toHaveBeenCalled();
  });

  it("no connected devices → no HTTP call at all", async () => {
    mockFindMany.mockResolvedValue([]);

    const outcome = await sendExpoPush({ userId: USER, title: "t", body: "b" });

    expect(outcome).toEqual({ sent: 0, revoked: 0, failed: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reads only the caller's OWN connected expo rows", async () => {
    mockFindMany.mockResolvedValue([{ externalId: LIVE }]);
    expoResponds([{ status: "ok", id: "ticket-1" }]);

    await sendExpoPush({ userId: USER, title: "t", body: "b" });

    // The predicate is a drizzle expression, so assert on the fact that a
    // filtered read happened and that the send carried the token it returned.
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany.mock.calls[0]![0]).toHaveProperty("where");

    const body = JSON.parse(
      (mockFetch.mock.calls[0]![1] as { body: string }).body
    ) as Array<{ to: string }>;
    expect(body.map((m) => m.to)).toEqual([LIVE]);
  });
});
