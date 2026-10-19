import { describe, expect, it } from "vitest";
import {
  PROVIDE_SECRET_GRANT_MINUTES,
  provideNeedsAccountConfirm,
  provideSecretAccessLine,
  summarizeAnswer,
  type Ask,
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

  it.each(["agent_unknown", "not_grantable", "key_not_allowed"] as const)(
    "a refused grant (%s) says no agent can read it",
    (reason) => {
      expect(provideSecretAccessLine({ status: "refused", reason }, NOW)).toBe(
        "No agent can read it yet"
      );
    }
  );

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

describe("provideNeedsAccountConfirm — P4", () => {
  it("one account is one tap; several ask which", () => {
    expect(provideNeedsAccountConfirm([])).toBe(false);
    expect(provideNeedsAccountConfirm([{ id: "a", accountHint: "x" }])).toBe(
      false
    );
    expect(
      provideNeedsAccountConfirm([
        { id: "a", accountHint: "x" },
        { id: "b", accountHint: "y" },
      ])
    ).toBe(true);
  });
});
