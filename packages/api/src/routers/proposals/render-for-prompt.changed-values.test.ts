/**
 * The agent sees WHAT a person changed before approving, only when the caller
 * opts in, and never a credential-like argument.
 *
 * NEGATIVE CONTROL: dropping `changedValues` from the `rendered` array turns
 * the opt-in test red; dropping the `isSecretName` filter turns the secret
 * test red.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { query: { proposals: { findFirst: async () => h.row } } },
  };
});

const { renderProposalForPrompt } = await import("./render-for-prompt.js");

const proposed = { text: "Hello world", apiKey: "sk-secret-1", accountId: "a" };

beforeEach(() => {
  h.row = {
    id: "p-1",
    status: "pending",
    rejectionReason: null,
    governanceReason: null,
    data: { summary: "LinkedIn publish post" },
    revisionHistory: [
      {
        at: "2026-11-17T10:00:00.000Z",
        by: "user-1",
        before: { parameters: proposed },
        patch: {
          parameters: { ...proposed, text: "Hello, LinkedIn", apiKey: "sk-secret-2" },
        },
      },
    ],
  };
});

describe("changed values in the prompt", () => {
  it("names the changed key but no value by default", async () => {
    const out = await renderProposalForPrompt("p-1");
    expect(out?.rendered).toContain("changed: parameters");
    expect(out?.rendered).not.toContain("Hello, LinkedIn");
  });

  it("shows proposed and approved text when asked", async () => {
    const out = await renderProposalForPrompt("p-1", {
      includeChangedValues: true,
    });
    expect(out?.rendered).toContain(
      'text: proposed "Hello world" → approved "Hello, LinkedIn"'
    );
  });

  it("never shows a credential-like argument, even when asked", async () => {
    const out = await renderProposalForPrompt("p-1", {
      includeChangedValues: true,
    });
    expect(out?.rendered).not.toMatch(/sk-secret/);
    expect(out?.rendered).not.toContain("apiKey");
  });
});
