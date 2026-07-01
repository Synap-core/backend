import { describe, it, expect } from "vitest";
import {
  senderMatches,
  passesSenderFilters,
  emailTimestampMs,
  isNewerThanWatermark,
  suggestMuteCategory,
  buildMailMessage,
  type EmailHit,
} from "./run-mail-feed.js";

describe("senderMatches", () => {
  it("matches case-insensitively as a substring/domain", () => {
    expect(senderMatches("Jane Doe <jane@acme.com>", "acme.com")).toBe(true);
    expect(senderMatches("Jane Doe <jane@ACME.com>", "acme")).toBe(true);
    expect(senderMatches("jane@other.com", "acme.com")).toBe(false);
  });

  it("ignores empty needles", () => {
    expect(senderMatches("jane@acme.com", "  ")).toBe(false);
  });
});

describe("passesSenderFilters", () => {
  it("drops senders matching a deny entry", () => {
    expect(passesSenderFilters("spam@junk.io", [], ["junk.io"])).toBe(false);
  });

  it("keeps only allow matches when allow is non-empty", () => {
    expect(passesSenderFilters("vip@client.com", ["client.com"], [])).toBe(
      true
    );
    expect(passesSenderFilters("random@nope.com", ["client.com"], [])).toBe(
      false
    );
  });

  it("lets deny win over allow", () => {
    expect(
      passesSenderFilters("bad@client.com", ["client.com"], ["bad@"])
    ).toBe(false);
  });

  it("passes through with empty lists", () => {
    expect(passesSenderFilters("anyone@anywhere.com", [], [])).toBe(true);
  });
});

describe("watermark", () => {
  it("parses RFC email date headers to ms", () => {
    expect(emailTimestampMs("Wed, 01 Jul 2026 10:00:00 +0000")).toBe(
      Date.parse("Wed, 01 Jul 2026 10:00:00 +0000")
    );
    expect(emailTimestampMs("not a date")).toBeNull();
    expect(emailTimestampMs(undefined)).toBeNull();
  });

  it("processes only emails newer than the mark", () => {
    const mark = Date.parse("Wed, 01 Jul 2026 10:00:00 +0000");
    expect(isNewerThanWatermark("Wed, 01 Jul 2026 11:00:00 +0000", mark)).toBe(
      true
    );
    expect(isNewerThanWatermark("Wed, 01 Jul 2026 09:00:00 +0000", mark)).toBe(
      false
    );
    // equal → not newer → skip
    expect(isNewerThanWatermark("Wed, 01 Jul 2026 10:00:00 +0000", mark)).toBe(
      false
    );
  });

  it("fails open with no watermark or unparseable date", () => {
    expect(isNewerThanWatermark("whatever", undefined)).toBe(true);
    expect(isNewerThanWatermark("not a date", 123)).toBe(true);
  });
});

describe("suggestMuteCategory", () => {
  it("suggests a dominant category (>=5 and >=60%)", () => {
    const cats = [
      "newsletter",
      "newsletter",
      "newsletter",
      "newsletter",
      "newsletter",
      "lead",
    ];
    expect(suggestMuteCategory(cats)).toBe("newsletter");
  });

  it("returns null below the count threshold", () => {
    expect(suggestMuteCategory(["newsletter", "newsletter"])).toBeNull();
  });

  it("returns null when no single category dominates", () => {
    const cats = ["a", "a", "a", "b", "b", "c"]; // a is 3/6 = 50%
    expect(suggestMuteCategory(cats)).toBeNull();
  });
});

describe("buildMailMessage", () => {
  it("includes subject, sender, summary, action, and a Gmail link", () => {
    const email: EmailHit = {
      id: "abc123",
      subject: "Grant deadline reminder",
      from: "grants@foundation.org",
    };
    const msg = buildMailMessage(email, {
      id: "abc123",
      relevant: true,
      category: "grant",
      summary: "Deadline is Friday",
      suggestedAction: "prepare submission",
    });
    expect(msg).toContain("Grant deadline reminder");
    expect(msg).toContain("grants@foundation.org");
    expect(msg).toContain("Deadline is Friday");
    expect(msg).toContain("prepare submission");
    expect(msg).toContain("https://mail.google.com/mail/u/0/#all/abc123");
  });
});
