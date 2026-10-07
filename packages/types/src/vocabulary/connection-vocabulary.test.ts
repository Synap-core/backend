/**
 * Connection verbs + state words (Connected North Star, W1). Each verb row is
 * pinned in BOTH moods and its in-flight form: `humanizeToken` has no tense, so
 * a missing row spells the button right by coincidence and the receipt wrong.
 */
import { describe, expect, it } from "vitest";
import {
  buildObjectActionTitle,
  resolveActionLabel,
  resolveActionProgressive,
  resolveConnectionStateLabel,
} from "./index.js";

const VERBS: Array<[string, string, string, string]> = [
  ["revoke", "Revoke", "Revoked", "Revoking"],
  ["rotate", "Replace", "Replaced", "Replacing"],
  ["expire", "Expire", "Expired", "Expiring"],
  ["reconnect", "Reconnect", "Reconnected", "Reconnecting"],
  ["sync", "Sync", "Synced", "Syncing"],
  ["approve", "Approve", "Approved", "Approving"],
  ["issue", "Issue", "Issued", "Issuing"],
  ["decline", "Decline", "Declined", "Declining"],
  ["disconnect", "Disconnect", "Disconnected", "Disconnecting"],
];

describe("connection verbs — three moods", () => {
  for (const [token, imperative, past, progressive] of VERBS) {
    it(`${token}: ${imperative} / ${past} / ${progressive}`, () => {
      expect(resolveActionLabel(token, "imperative")).toBe(imperative);
      expect(resolveActionLabel(token, "past")).toBe(past);
      expect(resolveActionProgressive(token)).toBe(progressive);
    });
  }

  it("a key revoke / rotate event reads as what happened, never 'Deleted' / 'Updated'", () => {
    expect(
      buildObjectActionTitle({
        action: "apiKey.revoke",
        objectKind: "apiKey",
        objectName: "Vercel production",
        mood: "past",
      })
    ).toBe('Revoked API key "Vercel production"');
    expect(
      buildObjectActionTitle({
        action: "apiKey.rotate",
        objectKind: "apiKey",
        objectName: "Vercel production",
        mood: "past",
      })
    ).toBe('Replaced API key "Vercel production"');
  });
});

describe("resolveConnectionStateLabel", () => {
  it("does not borrow the colliding STATUS_LABELS words", () => {
    // STATUS_LABELS.failing = "Not yet met" (a session verdict); revoked = "Revoked".
    expect(resolveConnectionStateLabel("failing")).toBe("Failing");
    expect(resolveConnectionStateLabel("revoked")).toBe("Access removed");
    expect(resolveConnectionStateLabel("ready")).toBe("Connected");
  });

  it("a kind override applies only to its kind", () => {
    expect(resolveConnectionStateLabel("needs_signin", "app")).toBe(
      "Key expired"
    );
    expect(resolveConnectionStateLabel("needs_signin", "account")).toBe(
      "Sign-in expired"
    );
    expect(resolveConnectionStateLabel("needs_signin")).toBe("Sign-in expired");
  });

  it("unknown states humanize, never leak", () => {
    expect(resolveConnectionStateLabel("half_open")).toBe("Half open");
  });
});
