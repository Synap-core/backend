/**
 * The invite page's words and refusal mapping. Each row is one a looser
 * mapping would get wrong: a spent invite read as a red banner, a raw role
 * token, "workspace" instead of the user word, a 409 that is not the
 * account-exists one.
 */
import { describe, expect, it } from "vitest";
import {
  acceptInviteRefusal,
  createAccountRefusal,
  inviteLine,
  inviteTitle,
  joinedHeadline,
} from "./invite-outcome";

const SPACE = {
  type: "workspace" as const,
  inviterName: "Alice",
  role: "editor",
  workspaceName: "Studio",
};
const POD = { type: "pod" as const, inviterName: "Alice", role: "viewer" };

describe("invite words", () => {
  it("names the space with the user word and the role in words", () => {
    expect(inviteTitle(SPACE)).toBe("Join Studio");
    expect(inviteLine(SPACE)).toBe(
      "Alice invited you to the space Studio as editor."
    );
    expect(inviteLine({ ...SPACE, role: "pod_admin" })).toBe(
      "Alice invited you to the space Studio as pod admin."
    );
  });

  it("a pod invite names the pod", () => {
    expect(inviteTitle(POD)).toBe("Join this pod");
    expect(inviteLine(POD)).toBe("Alice invited you to this pod as viewer.");
  });

  it("the Done headline says what was joined, and where", () => {
    expect(joinedHeadline(SPACE, "lab.pod.synap.live")).toBe(
      "You joined Studio on lab.pod.synap.live"
    );
    expect(joinedHeadline(POD, "lab.pod.synap.live")).toBe(
      "You joined lab.pod.synap.live"
    );
    expect(joinedHeadline(POD, undefined)).toBe("You joined this pod");
  });
});

describe("acceptInvite refusals", () => {
  const trpcError = (code: string, message = "") => ({
    message,
    data: { code },
  });

  it("maps a spent, expired or misaddressed invite to its page", () => {
    expect(acceptInviteRefusal(trpcError("NOT_FOUND"))).toEqual({
      kind: "not-found",
    });
    expect(
      acceptInviteRefusal(trpcError("BAD_REQUEST", "Invite expired"))
    ).toEqual({ kind: "expired" });
    expect(acceptInviteRefusal(trpcError("FORBIDDEN"))).toEqual({
      kind: "wrong-account",
    });
  });

  it("a BAD_REQUEST that is not the expiry is retried, not called expired", () => {
    expect(
      acceptInviteRefusal(trpcError("BAD_REQUEST", "bad input")).kind
    ).toBe("retry");
  });

  it("no answer at all says the pod was not reached, never a raw message", () => {
    const r = acceptInviteRefusal(new TypeError("Failed to fetch"));
    expect(r).toMatchObject({ kind: "retry" });
    expect(JSON.stringify(r)).not.toContain("Failed to fetch");
  });
});

describe("create-account refusals", () => {
  it("only the ACCOUNT_EXISTS 409 moves to Sign in", () => {
    expect(createAccountRefusal(409, { code: "ACCOUNT_EXISTS" })).toEqual({
      kind: "account-exists",
    });
    expect(createAccountRefusal(409, { error: "x" }).kind).toBe("retry");
  });

  it("maps 404 / 410 / 403 to the invite's pages", () => {
    expect(createAccountRefusal(404, null).kind).toBe("not-found");
    expect(createAccountRefusal(410, null).kind).toBe("expired");
    expect(createAccountRefusal(403, null).kind).toBe("wrong-account");
  });

  it("keeps a 400's own sentence (the field to fix) and hides status codes", () => {
    expect(
      createAccountRefusal(400, {
        error: "Password must be at least 8 characters",
      })
    ).toEqual({
      kind: "retry",
      message: "Password must be at least 8 characters",
    });
    const r = createAccountRefusal(500, { error: "boom" });
    expect(JSON.stringify(r)).not.toMatch(/500|boom|Failed \(/);
    expect(createAccountRefusal(null, null).kind).toBe("retry");
  });
});
