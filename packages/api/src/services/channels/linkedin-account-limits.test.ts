/**
 * The pure half of the per-LinkedIn-account limits
 * (`linkedin-account-limits.ts`): which provider calls are LinkedIn actions,
 * which LinkedIn answers pause the account, when a send is held and until
 * when, and that a daily-limit hold ends with its day (`readHeld`). The
 * counting and the doors run on PGlite in
 * `connectors/channel-send.linkedin-limits.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  linkedinBlockOf,
  linkedinProviderAction,
  linkedinThrottleOf,
  nextUtcDay,
  readLinkedinPause,
} from "./linkedin-account-limits.js";
import { readHeld } from "./held-sends.js";

const NOW = new Date("2026-11-16T21:30:00.000Z");
const TOMORROW = "2026-11-17T00:00:00.000Z";
const LIMITS = { invitations: 20, actions: 50 };

describe("which provider calls are LinkedIn actions", () => {
  it("a connection request and the three message paths, with the account they act as", () => {
    expect(
      linkedinProviderAction("POST", "/acc%201/users/me/relation-requests")
    ).toEqual({ kind: "invitation", accountExternalId: "acc 1" });
    for (const path of [
      "/acc1/chats/chat9/messages/send",
      "/acc1/chats/send",
      "/acc1/inboxes/CLASSIC_PRIMARY/chats/send?x=1",
    ]) {
      expect(linkedinProviderAction("post", path)).toEqual({
        kind: "message",
        accountExternalId: "acc1",
      });
    }
  });

  it("a read, or any other path, is not an action", () => {
    expect(
      linkedinProviderAction("GET", "/acc1/users/me/relation-requests")
    ).toBeNull();
    expect(
      linkedinProviderAction(
        "GET",
        "/acc1/users/marie?variant=linkedin_classic"
      )
    ).toBeNull();
    expect(linkedinProviderAction("POST", "/accounts")).toBeNull();
    expect(linkedinProviderAction("POST", "/v1/messages")).toBeNull();
  });
});

describe("which LinkedIn answers pause the account", () => {
  it("a 429, a checkpoint or a restriction", () => {
    expect(linkedinThrottleOf(429, "Unipile sendMessage failed: 429")).toBe(
      "rate_limited"
    );
    expect(linkedinThrottleOf(403, "errors/checkpoint_error")).toBe(
      "restricted"
    );
    expect(linkedinThrottleOf(422, "account restricted")).toBe("restricted");
  });

  it("a 422 cannot_resend_yet is about one person, not the account: no pause", () => {
    expect(
      linkedinThrottleOf(
        422,
        'failed: 422 — {"type":"errors/cannot_resend_yet"}'
      )
    ).toBeNull();
  });

  it("anything else is not a pause: another 4xx, a 5xx, a timeout", () => {
    expect(linkedinThrottleOf(400, "bad request")).toBeNull();
    expect(linkedinThrottleOf(422, "errors/invalid_recipient")).toBeNull();
    expect(linkedinThrottleOf(503, "too_many_requests")).toBeNull();
    expect(linkedinThrottleOf(0, "timeout")).toBeNull();
  });
});

describe("when a send is held, and until when", () => {
  const today = (actions: number, invitations: number) => ({
    linkedinDaily: { day: "2026-11-16", actions, invitations },
  });

  it("under both limits: not held", () => {
    expect(
      linkedinBlockOf({
        metadata: today(49, 19),
        kind: "invitation",
        limits: LIMITS,
        now: NOW,
      })
    ).toBeNull();
  });

  it("today's connection requests used: an invitation is held until the next UTC midnight, a message is not", () => {
    expect(
      linkedinBlockOf({
        metadata: today(20, 20),
        kind: "invitation",
        limits: LIMITS,
        now: NOW,
      })
    ).toMatchObject({ errorClass: "linkedin_limit", until: TOMORROW });
    expect(
      linkedinBlockOf({
        metadata: today(20, 20),
        kind: "message",
        limits: LIMITS,
        now: NOW,
      })
    ).toBeNull();
  });

  it("today's actions used: both kinds are held", () => {
    for (const kind of ["invitation", "message"] as const) {
      expect(
        linkedinBlockOf({
          metadata: today(50, 3),
          kind,
          limits: LIMITS,
          now: NOW,
        })
      ).toMatchObject({ errorClass: "linkedin_limit", until: TOMORROW });
    }
  });

  it("yesterday's counts do not hold today", () => {
    expect(
      linkedinBlockOf({
        metadata: {
          linkedinDaily: { day: "2026-11-15", actions: 50, invitations: 20 },
        },
        kind: "invitation",
        limits: LIMITS,
        now: NOW,
      })
    ).toBeNull();
  });

  it("paused: held until the pause ends; a pause that ended holds nothing", () => {
    const pause = { until: TOMORROW, reason: "rate_limited", at: NOW };
    expect(
      linkedinBlockOf({
        metadata: { linkedinPause: pause },
        kind: "message",
        limits: LIMITS,
        now: NOW,
      })
    ).toMatchObject({ errorClass: "linkedin_limit", until: TOMORROW });
    expect(
      readLinkedinPause({ linkedinPause: pause }, new Date(TOMORROW))
    ).toBeNull();
  });

  it("the next day starts at UTC midnight", () => {
    expect(nextUtcDay(NOW).toISOString()).toBe(TOMORROW);
    expect(nextUtcDay(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });
});

describe("a daily-limit hold ends with its day (readHeld)", () => {
  const data = {
    held: {
      errorClass: "linkedin_limit",
      reason: "limit",
      at: NOW.toISOString(),
      until: TOMORROW,
    },
  };

  it("holds before `until`, not from it", () => {
    expect(readHeld(data, NOW)).toMatchObject({
      errorClass: "linkedin_limit",
      until: TOMORROW,
    });
    expect(readHeld(data, new Date(TOMORROW))).toBeNull();
  });

  it("a not-connected hold has no end date and still holds", () => {
    expect(
      readHeld(
        {
          held: { errorClass: "not_connected", reason: "x", at: "2020-01-01" },
        },
        NOW
      )
    ).toMatchObject({ errorClass: "not_connected" });
  });
});
