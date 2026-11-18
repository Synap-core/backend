import { describe, it, expect } from "vitest";
import {
  CANNOT_APPLY_YET_REASONS,
  cannotApplyYet,
  cannotApplyYetLabel,
  cannotApplyYetLine,
} from "./cannot-apply.js";
import { en, fr } from "./copy.js";

const NOW = new Date("2026-11-18T12:00:00.000Z");
const AT = "2026-11-18T10:00:00.000Z";

/** A pending send as the pod stores it: `data.held` (held-sends.ts). */
const heldSend = (held: Record<string, unknown>, status = "pending") => ({
  status,
  data: { body: "Hello", held: { reason: "pod sentence", at: AT, ...held } },
});

describe("cannotApplyYet: a held message, as the pod reads it", () => {
  it("not a connection yet", () => {
    expect(
      cannotApplyYet(heldSend({ errorClass: "not_connected" }), NOW)
    ).toEqual({ reason: "not_connected", held: true, until: null });
  });

  it("no LinkedIn profile on file (missing_field) reads as no_profile", () => {
    expect(
      cannotApplyYet(heldSend({ errorClass: "missing_field" }), NOW)
    ).toEqual({ reason: "no_profile", held: true, until: null });
  });

  it("a hold written before its class was stored reads as not_connected", () => {
    expect(cannotApplyYet(heldSend({}), NOW)?.reason).toBe("not_connected");
  });

  it("a daily limit holds until `until`, and not after", () => {
    const until = "2026-11-19T00:00:00.000Z";
    expect(
      cannotApplyYet(heldSend({ errorClass: "linkedin_limit", until }), NOW)
    ).toEqual({ reason: "daily_limit", held: true, until });
    expect(
      cannotApplyYet(
        heldSend({ errorClass: "linkedin_limit", until: AT }),
        NOW
      )
    ).toBeNull();
  });

  it("only while pending: a decided or ended message is not held", () => {
    for (const status of ["approved", "rejected", "withdrawn", "expired"]) {
      expect(
        cannotApplyYet(heldSend({ errorClass: "not_connected" }, status), NOW)
      ).toBeNull();
    }
  });

  it("a malformed hold is no hold", () => {
    expect(
      cannotApplyYet({ status: "pending", data: { held: { reason: 1 } } }, NOW)
    ).toBeNull();
    expect(cannotApplyYet({ status: "pending", data: null }, NOW)).toBeNull();
  });
});

describe("cannotApplyYet: an install whose setup is missing", () => {
  it("a blocking setup cannot apply yet, and is not a hold", () => {
    expect(
      cannotApplyYet({ status: "pending", setup: { blocking: true } }, NOW)
    ).toEqual({ reason: "needs_setup", held: false, until: null });
    expect(
      cannotApplyYet(
        { status: "approval_failed", setup: { blocking: true } },
        NOW
      )?.reason
    ).toBe("needs_setup");
  });

  it("a setup with nothing missing, or a decided install, can be decided", () => {
    expect(
      cannotApplyYet({ status: "pending", setup: { blocking: false } }, NOW)
    ).toBeNull();
    expect(
      cannotApplyYet({ status: "approved", setup: { blocking: true } }, NOW)
    ).toBeNull();
  });
});

describe("one sentence per reason", () => {
  it("every reason has its line in English and French, naming a next step", () => {
    for (const reason of CANNOT_APPLY_YET_REASONS) {
      const key = `proposals.cannotApplyYet.${reason}` as const;
      expect(en[key]).toBeTruthy();
      expect(fr[key]).toBeTruthy();
      expect(cannotApplyYetLine(reason, "en")).toBe(en[key]);
      expect(cannotApplyYetLine(reason, "fr")).toBe(fr[key]);
    }
    expect(cannotApplyYetLabel("en")).toBe("Can’t apply yet");
  });
});
