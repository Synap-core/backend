import { describe, expect, it } from "vitest";
import { appActivityLine } from "./app-activity";

const ev = (eventType: string, data: unknown = {}) => ({
  eventType,
  userId: "u",
  data,
});
const humanize = (t: string) => `H(${t})`;
const line = (eventType: string, data?: unknown) =>
  appActivityLine(ev(eventType, data), humanize);

describe("appActivityLine", () => {
  it("says what happened to a key app", () => {
    expect(line("app.request.completed")).toBe("Asked for access");
    expect(line("app.approve.completed")).toBe("Access approved");
    expect(line("app.issue_key.completed", { replacedKeys: 0 })).toBe(
      "New key issued"
    );
    expect(line("app.issue_key.completed", { replacedKeys: 2 })).toBe(
      "New key issued — 2 keys stopped working"
    );
    expect(line("app.revoke.completed", { revokedKeys: 1 })).toBe(
      "Revoked — 1 key stopped working"
    );
    expect(line("app.rename.completed", { to: "Raycast" })).toBe(
      "Renamed to “Raycast”"
    );
    expect(line("app.remove_for_good.completed")).toBe("Removed for good");
  });

  it("says what happened to its keys", () => {
    expect(line("apiKey.create.completed", { keyName: "laptop" })).toBe(
      "Key “laptop” created"
    );
    expect(line("apiKey.revoke.completed")).toBe("Key revoked");
    expect(line("apiKey.rotate.completed")).toBe("Key rotated");
  });

  it("reads a Claude/MCP client's consents and its revoke", () => {
    expect(
      line("apiKey.create.completed", {
        kind: "pod_oauth_authorization",
        approve: true,
      })
    ).toBe("Approved on the consent screen");
    expect(
      line("apiKey.create.completed", {
        kind: "pod_oauth_authorization",
        approve: false,
      })
    ).toBe("Turned down on the consent screen");
    expect(
      line("api_keys.revoke.completed", {
        oauthClientId: "dcr_1",
        revokedKeys: 3,
      })
    ).toBe("Revoked — 3 keys stopped working");
  });

  it("says what happened to a sign-in app", () => {
    expect(line("application_connection.request.completed")).toBe(
      "Asked to sign in"
    );
    expect(line("application_connection.approve.completed")).toBe("Approved");
    expect(line("application_connection.reject.completed")).toBe("Turned down");
    expect(line("application_connection.revoke.completed")).toBe(
      "Access revoked"
    );
  });

  it("says when the invite approved, and who was unlinked", () => {
    expect(
      line("application_connection.approve.completed", {
        approvedByInvite: "invite-1",
      })
    ).toBe("Approved by invite");
    expect(
      line("application_connection.unlink.completed", {
        email: "ada@example.test",
      })
    ).toBe("Unlinked ada@example.test");
    expect(line("application_connection.unlink.completed")).toBe(
      "Unlinked an account"
    );
  });

  it("falls back to the event type, humanized", () => {
    expect(line("apiKey.update.completed")).toBe("H(apiKey update)");
    expect(line("api_keys.revoke.completed", null)).toBe("H(api_keys revoke)");
  });
});
