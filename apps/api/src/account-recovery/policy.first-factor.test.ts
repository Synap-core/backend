/**
 * `signedInAtPodWithin`: what a FIRST proof factor (new recovery codes with
 * none held, like presence.totp.begin) rests on. A device answers with its
 * step-up clock; a Kratos session with its pod credential time, which a
 * federated (Synap Cloud) sign-in never sets.
 */
import { describe, expect, it } from "vitest";
import { signedInAtPodWithin } from "./policy.js";

const NOW = new Date("2026-11-06T12:00:00Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
/** A stand-in for kratosCredentialTime: the pod credential time it reads. */
const at = (d: Date | null) => () => d;

describe("signedInAtPodWithin", () => {
  it("a password or email code at the pod 5 minutes ago counts", () => {
    expect(signedInAtPodWithin({}, at(ago(300)), NOW, 600)).toBe(true);
  });

  it("GUARDRAIL: a federated sign-in (no pod credential time) never counts, however recent", () => {
    expect(
      signedInAtPodWithin(
        { authenticated_at: NOW.toISOString() } as never,
        at(null),
        NOW,
        600
      )
    ).toBe(false);
  });

  it("a pod sign-in older than the window does not count", () => {
    expect(signedInAtPodWithin({}, at(ago(601)), NOW, 600)).toBe(false);
  });

  it("a device answers with its step-up clock, never the Kratos reading", () => {
    const fresh = { device: { authTime: ago(60).toISOString() } };
    const stale = { device: { authTime: ago(3600).toISOString() } };
    const none = { device: { authTime: null } };
    expect(signedInAtPodWithin(fresh, at(null), NOW, 600)).toBe(true);
    expect(signedInAtPodWithin(stale, at(NOW), NOW, 600)).toBe(false);
    expect(signedInAtPodWithin(none, at(NOW), NOW, 600)).toBe(false);
  });
});
