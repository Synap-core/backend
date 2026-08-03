import { describe, it, expect } from "vitest";
import {
  mapMailgunInboundToMessage,
  extractEmailAddress,
  type MailgunInboundFields,
} from "./map-inbound-to-message.js";

describe("extractEmailAddress", () => {
  it("extracts the address out of a display-name header", () => {
    expect(extractEmailAddress('"Sam Antoine" <sam@etik.com>')).toBe(
      "sam@etik.com"
    );
  });
  it("accepts a bare address", () => {
    expect(extractEmailAddress("sam@etik.com")).toBe("sam@etik.com");
  });
  it("lowercases the address", () => {
    expect(extractEmailAddress("Sam@Etik.COM")).toBe("sam@etik.com");
  });
  it("returns '' for a display name with no embedded address", () => {
    expect(extractEmailAddress('"No Address Here"')).toBe("");
  });
  it("returns '' for null/undefined/empty", () => {
    expect(extractEmailAddress(null)).toBe("");
    expect(extractEmailAddress(undefined)).toBe("");
    expect(extractEmailAddress("")).toBe("");
  });
});

describe("mapMailgunInboundToMessage", () => {
  const base: MailgunInboundFields = {
    sender: "envelope-sender@mailgun-relay.example",
    recipient: "client-abc@inbound.synap.live",
    subject: "Re: proposal",
    "body-plain": "Full body with a signature block.\n--\nSam",
    "stripped-text": "Full body without the signature block.",
    "Message-Id": "<abc123@mail.gmail.com>",
    From: '"Sam Antoine" <sam@etik.com>',
    "Reply-To": null,
  };

  it("threads Message-Id, subject and prefers stripped-text over body-plain", () => {
    const m = mapMailgunInboundToMessage(base, "fallback-id");
    expect(m.messageId).toBe("<abc123@mail.gmail.com>");
    expect(m.subject).toBe("Re: proposal");
    expect(m.text).toBe(
      "Subject: Re: proposal\n\nFull body without the signature block."
    );
  });

  it("falls back to body-plain when stripped-text is empty", () => {
    const m = mapMailgunInboundToMessage(
      { ...base, "stripped-text": "" },
      "fallback-id"
    );
    expect(m.text).toBe(
      "Subject: Re: proposal\n\nFull body with a signature block.\n--\nSam"
    );
  });

  it("falls back to a subject-only text when both body fields are empty", () => {
    const m = mapMailgunInboundToMessage(
      { ...base, "stripped-text": "", "body-plain": "" },
      "fallback-id"
    );
    expect(m.text).toBe("Subject: Re: proposal");
  });

  it("falls back to the fallbackMessageId when Message-Id is missing", () => {
    const m = mapMailgunInboundToMessage(
      { ...base, "Message-Id": null },
      "fallback-id"
    );
    expect(m.messageId).toBe("fallback-id");
  });

  it("defaults an empty subject to '(no subject)'", () => {
    const m = mapMailgunInboundToMessage({ ...base, subject: "" }, "fid");
    expect(m.subject).toBe("(no subject)");
  });

  it("prefers the From header over the envelope sender (forwarding nuance)", () => {
    const m = mapMailgunInboundToMessage(base, "fid");
    expect(m.senderEmail).toBe("sam@etik.com");
    expect(m.envelopeSender).toBe("envelope-sender@mailgun-relay.example");
  });

  it("falls back to Reply-To when From has no address, then to the envelope sender", () => {
    const noFrom: MailgunInboundFields = {
      ...base,
      From: '"Forwarder Inc"',
      "Reply-To": "original@proton.example",
    };
    expect(mapMailgunInboundToMessage(noFrom, "fid").senderEmail).toBe(
      "original@proton.example"
    );

    const noFromNoReply: MailgunInboundFields = {
      ...base,
      From: null,
      "Reply-To": null,
    };
    expect(mapMailgunInboundToMessage(noFromNoReply, "fid").senderEmail).toBe(
      "envelope-sender@mailgun-relay.example"
    );
  });

  it("returns the raw recipient string when it doesn't parse as an address", () => {
    const m = mapMailgunInboundToMessage(
      { ...base, recipient: "route-abc" },
      "fid"
    );
    expect(m.recipient).toBe("route-abc");
  });
});
