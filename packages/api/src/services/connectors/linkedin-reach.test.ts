/**
 * THE rule of a person's LinkedIn reach (CRM wave 2, S4a): what a profile
 * answer says, and the 21-day rule. The writes are proven on PGlite
 * (`connectors/channel-send.pglite.test.ts`, "LinkedIn reach").
 *
 * Rows rule out: a request pending 21 days or less read as ignored; one
 * pending longer kept pending; a profile that says nothing written as
 * "none"; a request THEY sent read as the owner's pending one; a pending read
 * with no date erasing the stored date (which would also stop the 21-day rule).
 */
import { describe, it, expect, vi } from "vitest";

// The writer's database handle is not used by these pure rows.
vi.mock("@synap/database", () => ({
  db: {},
  and: () => null,
  eq: () => null,
  isNull: () => null,
  drizzleSql: () => null,
  LINKEDIN_CONNECTION_VALUES: ["none", "pending", "connected", "ignored"],
}));
vi.mock("@synap/database/schema", () => ({ entities: {} }));

import {
  INVITATION_IGNORED_AFTER_DAYS,
  linkedinReachFromProfile,
  nextLinkedinReach,
  settleLinkedinReach,
  storedLinkedinReach,
} from "./linkedin-reach.js";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const daysAgo = (d: number) =>
  new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

describe("the 21-day rule", () => {
  it("is 21 days", () => {
    expect(INVITATION_IGNORED_AFTER_DAYS).toBe(21);
  });

  it("pending for 20 days stays pending; for 22 days it is ignored", () => {
    expect(
      settleLinkedinReach(
        { connection: "pending", invitedAt: daysAgo(20) },
        NOW
      ).connection
    ).toBe("pending");
    expect(
      settleLinkedinReach(
        { connection: "pending", invitedAt: daysAgo(22) },
        NOW
      )
    ).toEqual({ connection: "ignored", invitedAt: daysAgo(22) });
  });

  it("a pending request with no date stays pending; other states are left as they are", () => {
    expect(
      settleLinkedinReach({ connection: "pending", invitedAt: null }, NOW)
        .connection
    ).toBe("pending");
    expect(
      settleLinkedinReach(
        { connection: "connected", invitedAt: daysAgo(60) },
        NOW
      ).connection
    ).toBe("connected");
  });
});

describe("what a profile answer says", () => {
  it("connected / pending with its date / none / ignored; nothing said = null", () => {
    expect(
      linkedinReachFromProfile({
        connection: "connected",
        relationRequest: null,
      })
    ).toEqual({ connection: "connected", invitedAt: null });
    expect(
      linkedinReachFromProfile({
        connection: "pending",
        relationRequest: {
          direction: "sent",
          status: "pending",
          sentAt: "2026-11-01T08:00:00.000Z",
        },
      })
    ).toEqual({ connection: "pending", invitedAt: "2026-11-01T08:00:00.000Z" });
    expect(
      linkedinReachFromProfile({
        connection: "not_connected",
        relationRequest: null,
      })
    ).toEqual({ connection: "none", invitedAt: null });
    expect(
      linkedinReachFromProfile({
        connection: "not_connected",
        relationRequest: { direction: "sent", status: "ignored", sentAt: null },
      })
    ).toEqual({ connection: "ignored", invitedAt: null });
    // A request THEY sent and the owner ignored is not the owner's.
    expect(
      linkedinReachFromProfile({
        connection: "not_connected",
        relationRequest: {
          direction: "received",
          status: "ignored",
          sentAt: null,
        },
      })
    ).toEqual({ connection: "none", invitedAt: null });
    expect(
      linkedinReachFromProfile({ connection: null, relationRequest: null })
    ).toBeNull();
    expect(linkedinReachFromProfile({})).toBeNull();
  });
});

describe("the fact to store", () => {
  it("a pending read with no date keeps the stored date, so the 21-day rule still applies", () => {
    const stored = { connection: "pending" as const, invitedAt: daysAgo(30) };
    expect(
      nextLinkedinReach(stored, { connection: "pending", invitedAt: null }, NOW)
    ).toEqual({ connection: "ignored", invitedAt: daysAgo(30) });
  });

  it("connected wins over a stored ignored", () => {
    expect(
      nextLinkedinReach(
        { connection: "ignored", invitedAt: daysAgo(30) },
        { connection: "connected", invitedAt: null },
        NOW
      )
    ).toEqual({ connection: "connected", invitedAt: daysAgo(30) });
  });

  it("reads only a known value off the properties", () => {
    expect(
      storedLinkedinReach({
        linkedinConnection: "pending",
        linkedinInvitedAt: "2026-11-01",
      })
    ).toEqual({
      connection: "pending",
      invitedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(storedLinkedinReach({ linkedinConnection: "maybe" })).toBeNull();
    expect(storedLinkedinReach({})).toBeNull();
    expect(storedLinkedinReach(null)).toBeNull();
  });
});
