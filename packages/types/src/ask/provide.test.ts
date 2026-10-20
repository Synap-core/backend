import { describe, expect, it } from "vitest";
import {
  ASK_COPY,
  PROVIDE_SECRET_GRANT_MINUTES,
  provideAcceptAttribute,
  provideAccountChoices,
  provideExpectedGranteeId,
  provideFileAccepts,
  provideGrantNote,
  providePrePickedAccount,
  provideSecretAccessLine,
  summarizeAnswer,
  type Ask,
  type ProvideConnectionRowLite,
} from "./index.js";

const NOW = Date.parse("2026-10-19T09:00:00.000Z");
const inMinutes = (m: number) => new Date(NOW + m * 60_000).toISOString();
const SECRET_ASK: Ask = {
  mode: "provide",
  provide: { kind: "secret", name: "Stripe key" },
};
const VAULT_REF = "vault://0b9f3c1e-6c55-4a43-9a43-2f8a2b7f1c11";

describe("provideSecretAccessLine — the receipt says who can read it", () => {
  it("a fresh grant reads as the hour the pod writes", () => {
    expect(
      provideSecretAccessLine(
        {
          status: "granted",
          agentUserId: "a",
          agentName: "Researcher",
          expiresAt: inMinutes(PROVIDE_SECRET_GRANT_MINUTES),
        },
        NOW
      )
    ).toBe("Researcher can read it for 60 minutes, in this session");
  });

  it("a reused grant says what is actually left, never a flat hour", () => {
    expect(
      provideSecretAccessLine(
        {
          status: "granted",
          agentUserId: "a",
          agentName: "Researcher",
          expiresAt: inMinutes(12),
        },
        NOW
      )
    ).toBe("Researcher can read it for 12 minutes, in this session");
    expect(
      provideSecretAccessLine(
        {
          status: "granted",
          agentUserId: "a",
          agentName: "Researcher",
          expiresAt: null,
        },
        NOW
      )
    ).toBe("Researcher can read it");
  });

  it.each([
    "agent_unknown",
    "not_grantable",
    "key_not_allowed",
    "agent_changed",
  ] as const)("a refused grant (%s) says no agent can read it", (reason) => {
    expect(provideSecretAccessLine({ status: "refused", reason }, NOW)).toBe(
      "No agent can read it yet"
    );
  });

  it("summarizeAnswer appends it to a secret answer, and only to one", () => {
    const value = {
      type: "provide" as const,
      ref: { kind: "secret" as const, vaultRef: VAULT_REF },
    };
    const grant = {
      status: "granted" as const,
      agentUserId: "a",
      agentName: "Researcher",
      expiresAt: inMinutes(60),
    };
    expect(
      summarizeAnswer(SECRET_ASK, value, "for the export", {
        secretAccess: { grant, now: NOW },
      })
    ).toBe(
      'Stored the secret "Stripe key" in the vault · Researcher can read it for 60 minutes, in this session — for the export'
    );
    // Without it, today's receipt exactly.
    expect(summarizeAnswer(SECRET_ASK, value)).toBe(
      'Stored the secret "Stripe key" in the vault'
    );
    // A file answer never carries a secret line.
    expect(
      summarizeAnswer(
        { mode: "provide", provide: { kind: "file" } },
        {
          type: "provide",
          ref: {
            kind: "file",
            fileId: "0b9f3c1e-6c55-4a43-9a43-2f8a2b7f1c11",
          },
        },
        undefined,
        { secretAccess: { grant, now: NOW } }
      )
    ).toBe("Attached a file");
  });
});

describe("provideGrantNote: what a secret hand-over will let the agent do", () => {
  it("names the agent and the minutes when the pod will grant a read", () => {
    const grant = {
      status: "will_grant" as const,
      agentUserId: "agent-1",
      agentName: "Researcher",
      minutes: 60,
    };
    expect(provideGrantNote(grant)).toBe(
      "Researcher will be able to read it for 60 minutes, in this session only."
    );
    expect(provideExpectedGranteeId(grant)).toBe("agent-1");
  });

  it("says no agent can read it, and sends no grantee, when none will be granted", () => {
    const grant = {
      status: "no_grant" as const,
      reason: "agent_unknown" as const,
    };
    expect(provideGrantNote(grant)).toBe(ASK_COPY.provideNoGrantNote);
    expect(provideExpectedGranteeId(grant)).toBeNull();
  });
});

describe("ASK_COPY.provideConnectUnavailable", () => {
  it("says why a new connection can't start, per reason", () => {
    expect(ASK_COPY.provideConnectUnavailable("not_offered", "Notion")).toBe(
      "This pod does not offer a Notion connection yet. A pod admin can add it."
    );
    expect(ASK_COPY.provideConnectUnavailable("no_broker", "Notion")).toMatch(
      /can't connect accounts yet/
    );
    expect(ASK_COPY.provideConnectUnavailable("unreadable", "Notion")).toMatch(
      /Couldn't check/
    );
  });
});

describe("provideAccountChoices / providePrePickedAccount", () => {
  const row = (over: Partial<ProvideConnectionRowLite> = {}) => ({
    id: "c1",
    label: "Gmail",
    accountHint: "ada@example.com",
    podWide: false,
    needsReauth: false,
    ...over,
  });

  it("labels an account by its hint, with the name, shared and sign-in state as detail", () => {
    expect(
      provideAccountChoices([row({ podWide: true, needsReauth: true })])
    ).toEqual([
      {
        id: "c1",
        label: "ada@example.com",
        detail: "Gmail · Shared with the pod · Needs signing in again",
        podWide: true,
        usable: false,
      },
    ]);
    expect(
      provideAccountChoices([row({ accountHint: "  " })])[0]
    ).toMatchObject({ label: "Gmail", detail: null, usable: true });
  });

  it("pre-picks the only account when it is usable", () => {
    const choices = provideAccountChoices([row()]);
    expect(providePrePickedAccount(choices, false)?.id).toBe("c1");
  });

  it("never pre-picks a signed-out account", () => {
    const choices = provideAccountChoices([row({ needsReauth: true })]);
    expect(providePrePickedAccount(choices, false)).toBeNull();
  });

  it("never pre-picks when the person must confirm which account", () => {
    const choices = provideAccountChoices([row(), row({ id: "c2" })]);
    expect(providePrePickedAccount(choices, true)).toBeNull();
    expect(providePrePickedAccount([], false)).toBeNull();
  });
});

describe("provideFileAccepts / provideAcceptAttribute", () => {
  const pdf = { name: "Report.PDF", type: "application/pdf" };
  const png = { name: "shot.png", type: "image/png" };

  it("treats a bare token as an extension", () => {
    expect(provideFileAccepts(pdf, ["pdf"])).toBe(true);
    expect(provideFileAccepts(png, ["pdf"])).toBe(false);
    expect(provideAcceptAttribute(["pdf", " image/* "])).toBe(".pdf,image/*");
  });

  it("matches an extension, a media type and a family", () => {
    expect(provideFileAccepts(pdf, [".pdf"])).toBe(true);
    expect(provideFileAccepts(pdf, ["application/pdf"])).toBe(true);
    expect(provideFileAccepts(png, ["image/*"])).toBe(true);
    expect(provideFileAccepts(pdf, ["image/*"])).toBe(false);
    expect(provideFileAccepts({ name: "a.png", type: null }, ["image/*"])).toBe(
      false
    );
  });

  it("lets any file through when nothing usable was asked", () => {
    expect(provideFileAccepts(pdf, null)).toBe(true);
    expect(provideFileAccepts(pdf, [])).toBe(true);
    expect(provideFileAccepts(pdf, ["  "])).toBe(true);
    expect(provideAcceptAttribute(undefined)).toBeUndefined();
    expect(provideAcceptAttribute([" "])).toBeUndefined();
  });
});
