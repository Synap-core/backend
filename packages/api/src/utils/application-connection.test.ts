import { describe, expect, it } from "vitest";
import {
  markLinkedByInvite,
  buildApplicationConnectionReturnUrl,
  normalizeApplicationCallbackUrl,
  normalizeApplicationOrigin,
} from "./application-connection.js";

describe("application connection URL registration", () => {
  it("requires an exact HTTPS origin and a callback on that origin", () => {
    const origin = normalizeApplicationOrigin("https://crm.example.test");
    expect(origin).toBe("https://crm.example.test");
    expect(
      normalizeApplicationCallbackUrl(
        "https://crm.example.test/auth/pod-return?source=crm",
        origin!
      )
    ).toBe("https://crm.example.test/auth/pod-return?source=crm");
    expect(
      normalizeApplicationCallbackUrl(
        "https://attacker.example.test/auth/pod-return",
        origin!
      )
    ).toBeNull();
  });

  it("accepts only explicit loopback development ports", () => {
    expect(normalizeApplicationOrigin("http://localhost:3030")).toBe(
      "http://localhost:3030"
    );
    expect(normalizeApplicationOrigin("http://localhost")).toBeNull();
    expect(
      normalizeApplicationOrigin("http://crm.example.test:3030")
    ).toBeNull();
  });

  it("adds only a public request correlation to an owner return URL", () => {
    expect(
      buildApplicationConnectionReturnUrl({
        callbackUrl: "https://crm.example.test/auth/pod-return?source=crm",
        requestId: "11111111-1111-4111-8111-111111111111",
      })
    ).toBe(
      "https://crm.example.test/auth/pod-return?source=crm&connection_request=11111111-1111-4111-8111-111111111111"
    );
  });
});

describe("markLinkedByInvite", () => {
  const approval = {
    approvedByInvite: {
      inviteId: "invite-1",
      inviteAcceptedAt: "2026-10-19T20:00:00.000Z",
      approvedAt: "2026-10-19T20:05:00.000Z",
    },
  };

  it("marks only the person whose own ask the invite approved", () => {
    const people = [
      { userId: "ada", email: "ada@pod.test" },
      { userId: "bob", email: "bob@pod.test" },
    ];
    expect(
      markLinkedByInvite(people, [
        { requestedByUserId: "ada", requestMetadata: approval },
        // Bob's ask was approved by an owner.
        { requestedByUserId: "bob", requestMetadata: {} },
        // An invite approval with no requester marks nobody.
        { requestedByUserId: null, requestMetadata: approval },
      ])
    ).toEqual([
      { userId: "ada", email: "ada@pod.test", linkedByInvite: true },
      { userId: "bob", email: "bob@pod.test", linkedByInvite: false },
    ]);
  });

  it("ignores a malformed approval record", () => {
    expect(
      markLinkedByInvite(
        [{ userId: "ada" }],
        [
          {
            requestedByUserId: "ada",
            requestMetadata: { approvedByInvite: { inviteId: "invite-1" } },
          },
        ]
      )
    ).toEqual([{ userId: "ada", linkedByInvite: false }]);
  });
});
