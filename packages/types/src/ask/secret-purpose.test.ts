/**
 * AN HONEST SECRET (plan d717d6ac §4, finding ebc40493): the provide-secret
 * ask may declare what the secret is for and how many reads it needs, an ask
 * posed before either keeps parsing (and keeps its fingerprint), a purpose
 * never carries a credential, and the words the sheet and the receipt show
 * say the truth about the grant that applies — a reused permanent grant
 * included.
 */
import { describe, expect, it } from "vitest";
import {
  AskSchema,
  ASK_COPY,
  askFingerprint,
  looksLikeCredential,
  provideGrantNote,
  provideSecretAccessLine,
  type Ask,
} from "./index.js";

const OLD_ASK = {
  mode: "provide",
  provide: { kind: "secret", name: "STRIPE_KEY" },
} as const;

const PURPOSE = {
  for: "Merging the delivery PR",
  tool: "GitHub tool",
  action: "merge",
  on: "Synap-core/backend",
};

describe("the provide-secret ask: purpose and uses", () => {
  it("an ask with neither still parses, unchanged, with the same fingerprint", () => {
    const parsed = AskSchema.parse(OLD_ASK);
    expect(parsed).toEqual(OLD_ASK);
    expect(askFingerprint(parsed)).toBe(askFingerprint(OLD_ASK as Ask));
  });

  it("carries a declared purpose and the reads it asks for", () => {
    const parsed = AskSchema.parse({
      ...OLD_ASK,
      provide: { ...OLD_ASK.provide, purpose: PURPOSE, uses: "once" },
    });
    expect(parsed.mode === "provide" && parsed.provide).toEqual({
      kind: "secret",
      name: "STRIPE_KEY",
      purpose: PURPOSE,
      uses: "once",
    });
  });

  it("a purpose needs what it is for and the tool; action and on are optional", () => {
    expect(
      AskSchema.safeParse({
        ...OLD_ASK,
        provide: { ...OLD_ASK.provide, purpose: { for: "Merging" } },
      }).success
    ).toBe(false);
    expect(
      AskSchema.safeParse({
        ...OLD_ASK,
        provide: {
          ...OLD_ASK.provide,
          purpose: { for: "Merging", tool: "GitHub" },
        },
      }).success
    ).toBe(true);
  });

  it("is bounded, and refuses an unknown uses", () => {
    const tooLong = { ...PURPOSE, for: "x".repeat(201) };
    expect(
      AskSchema.safeParse({
        ...OLD_ASK,
        provide: { ...OLD_ASK.provide, purpose: tooLong },
      }).success
    ).toBe(false);
    expect(
      AskSchema.safeParse({
        ...OLD_ASK,
        provide: { ...OLD_ASK.provide, uses: "permanent" },
      }).success
    ).toBe(false);
  });

  // Built at run time: a literal token shape in the source trips the forge's
  // push protection, and these are made up.
  it.each([
    ["ghp", "Q2w3E4r5T6y7U8i9O0p1A2s3D4f5G6h7J8k9"].join("_"),
    ["sk", "live", "Z9y8X7w6V5u4T3s2R1q0P9o8"].join("_"),
    "use eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 here",
  ])("refuses a purpose part that looks like a credential: %s", (value) => {
    expect(looksLikeCredential(value)).toBe(true);
    const r = AskSchema.safeParse({
      ...OLD_ASK,
      provide: { ...OLD_ASK.provide, purpose: { ...PURPOSE, on: value } },
    });
    expect(r.success).toBe(false);
  });

  it.each([
    "Synap-core/backend",
    "https://github.com/Synap-core/backend/pull/1066",
    "synap-backend/packages/api/src/services",
    "Merging the delivery PR for release 2026-11-16",
    // What an agent names the work by in this pod: a session or entity id,
    // a hyphenated or underscored slug (review a089b624 S4).
    "session 23a8e85b-1a9a-4560-8418-d16faa7dd8c3",
    "427c440c-1928-438a-85ca-a7ae262b1d74",
    "synap-intelligence-service-v2",
    "merge_pull_request_2026_11_16",
  ])("lets ordinary words, paths and links through: %s", (value) => {
    expect(looksLikeCredential(value)).toBe(false);
    expect(
      AskSchema.safeParse({
        ...OLD_ASK,
        provide: { ...OLD_ASK.provide, purpose: { ...PURPOSE, on: value } },
      }).success
    ).toBe(true);
  });
});

describe("the words say the grant that applies", () => {
  const offer = {
    status: "will_grant" as const,
    agentUserId: "agent-1",
    agentName: "Researcher",
    minutes: 60,
    uses: "session" as const,
  };

  it("a standing permanent grant on the picked secret is said, never an hour", () => {
    expect(
      provideGrantNote(offer, { standingGrant: { grantId: "g", useCount: 3 } })
    ).toBe(ASK_COPY.provideStandingGrantNote("Researcher"));
    expect(ASK_COPY.provideStandingGrantNote("Researcher")).toBe(
      "Researcher can already read this secret, until you take it back. Nothing new is granted."
    );
  });

  it("one read, asked by the ask or picked by the person, says once and its window", () => {
    expect(provideGrantNote({ ...offer, uses: "once", minutes: 15 })).toBe(
      "Researcher can read it once, within 15 minutes, in this job only."
    );
    expect(provideGrantNote(offer, { uses: "once" })).toBe(
      "Researcher can read it once, within 15 minutes, in this job only."
    );
    expect(
      provideGrantNote(
        { ...offer, uses: "once", minutes: 15 },
        { uses: "session" }
      )
    ).toBe("Researcher can read it for up to 60 minutes, in this job only.");
  });

  it("the receipt says a standing grant lasts until taken back, and once is once", () => {
    const now = Date.parse("2026-11-16T14:00:00.000Z");
    const granted = {
      status: "granted" as const,
      agentUserId: "agent-1",
      agentName: "Researcher",
    };
    expect(
      provideSecretAccessLine(
        { ...granted, expiresAt: null, uses: "standing", grantId: "g" },
        now
      )
    ).toBe("Researcher can read it until you take it back");
    expect(
      provideSecretAccessLine(
        {
          ...granted,
          expiresAt: "2026-11-16T14:15:00.000Z",
          uses: "once",
          grantId: "g",
        },
        now
      )
    ).toBe("Researcher can read it once");
  });

  it("the card's words for no declared purpose", () => {
    expect(ASK_COPY.provideNoPurpose).toBe(
      "The agent did not say what it is for."
    );
  });
});
