import { describe, it, expect } from "vitest";
import {
  isConnectionAuthError,
  capErrorMessage,
} from "./notify-connector-unhealthy.js";

// These are the EXACT error envelopes observed live on the team pod when the
// Google OAuth connection's refresh token was dead (dogfood, Jul 2026) — the
// detection must fire on them or the reconnect nudge never happens.
const LIVE_REFRESH_FAILED = {
  kind: "run",
  result: {
    success: false,
    status: 424,
    errorCode: "bad_request",
    error:
      "Failed to get connection credentials: 'The external API returned an error when trying to refresh the access token. Please try again later.'",
    body: { error: { code: "server_error" } },
  },
};
const LIVE_REFRESH_BACKOFF = {
  kind: "run",
  result: {
    success: false,
    status: 400,
    errorCode: "bad_request",
    error: "A recent refresh attempt failed. Backing off before retrying.",
    body: { error: { code: "connection_refresh_backoff" } },
  },
};

describe("capErrorMessage — extracts the error from a kind:'run' envelope", () => {
  it("surfaces the provider error message on a dead connection", () => {
    expect(capErrorMessage(LIVE_REFRESH_FAILED)).toContain(
      "refresh the access token"
    );
    expect(capErrorMessage(LIVE_REFRESH_BACKOFF)).toContain(
      "refresh attempt failed"
    );
  });

  it("returns undefined for a genuinely successful run", () => {
    expect(
      capErrorMessage({ kind: "run", result: { events: [{ id: "a" }] } })
    ).toBeUndefined();
    expect(
      capErrorMessage({ kind: "run", result: { results: [], count: 0 } })
    ).toBeUndefined();
  });

  it("carries deny/not_found reasons; ignores dry-run/proposed", () => {
    expect(capErrorMessage({ kind: "deny", reason: "no access" })).toBe(
      "no access"
    );
    expect(capErrorMessage({ kind: "not_found", message: "no verb" })).toBe(
      "no verb"
    );
    expect(capErrorMessage({ kind: "dry-run" })).toBeUndefined();
    expect(capErrorMessage({ kind: "proposed" })).toBeUndefined();
  });
});

describe("isConnectionAuthError — fires the reconnect nudge only for auth failures", () => {
  it("matches the real dead-connection messages", () => {
    expect(isConnectionAuthError(capErrorMessage(LIVE_REFRESH_FAILED))).toBe(
      true
    );
    expect(isConnectionAuthError(capErrorMessage(LIVE_REFRESH_BACKOFF))).toBe(
      true
    );
  });

  it("matches other known auth/expiry signals", () => {
    expect(isConnectionAuthError("invalid_grant")).toBe(true);
    expect(isConnectionAuthError("401 Unauthorized")).toBe(true);
    expect(isConnectionAuthError("token expired")).toBe(true);
  });

  it("matches the 'enabled but never connected' state (observed live after the key swap)", () => {
    expect(
      isConnectionAuthError(
        'No connection found for provider "google". Connect it via Settings → Connectors first.'
      )
    ).toBe(true);
  });

  it("does NOT fire for transient/unrelated failures (no false reconnect nudge)", () => {
    expect(isConnectionAuthError("500 internal server error")).toBe(false);
    expect(isConnectionAuthError("rate limit exceeded")).toBe(false);
    expect(isConnectionAuthError(undefined)).toBe(false);
    expect(isConnectionAuthError("")).toBe(false);
  });
});
