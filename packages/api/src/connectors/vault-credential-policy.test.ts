import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE vault-credential policy, now shared by the vault:// tool handler and an
 * MCP server's auth header (`resolveDirectVaultCredential`).
 *
 * It was extracted from `vaultHandler` without changing its behaviour, and that
 * handler had no direct test of the rule itself. These cases pin the rule, so a
 * second consumer cannot drift from it and a refactor cannot quietly loosen it.
 * Each case names the principal whose access it decides:
 *
 *   human owner, no agent        → ungated
 *   agent under owner's identity → GATED (SEC#1: the owner bypass keys off the
 *                                  effective actor; an agent never inherits it)
 *   pod-wide shared secret       → ungated (0211; the RUN is gated elsewhere)
 *   anyone else                  → gated, redeemed by the effective actor
 *
 * Asserted on the OPTIONS passed to resolveVaultSecret — that argument is the
 * decision. Checking only the returned secret would pass whether or not the
 * grant was demanded, because the mock resolves either way.
 */

const { mockResolveVaultSecret, mockFindFirst } = vi.hoisted(() => ({
  mockResolveVaultSecret: vi.fn(),
  mockFindFirst: vi.fn(),
}));

vi.mock("../utils/vault-resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/vault-resolver.js")>();
  return { ...actual, resolveVaultSecret: mockResolveVaultSecret };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { query: { secrets: { findFirst: mockFindFirst } } },
  };
});

import {
  resolveDirectVaultCredential,
  resolveMcpServerAuthHeader,
} from "./external-dispatch.js";

const OWNER = "owner-1";
const AGENT = "agent-1";

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveVaultSecret.mockResolvedValue("s3cret");
});

/** The 4th argument resolveVaultSecret received: undefined = ungated. */
function optsPassed() {
  expect(mockResolveVaultSecret).toHaveBeenCalledTimes(1);
  return mockResolveVaultSecret.mock.calls[0]![3];
}

describe("resolveDirectVaultCredential — who must hold a grant", () => {
  it("a human owner with no agent is ungated", async () => {
    const r = await resolveDirectVaultCredential({
      vaultId: "v1",
      secretRow: { userId: OWNER, isPodWide: false },
      userId: OWNER,
    });
    expect(r).toEqual({ ok: true, secret: "s3cret" });
    expect(optsPassed()).toBeUndefined();
  });

  it("an AGENT under the owner's identity is grant-gated as itself (SEC#1)", async () => {
    // The discriminating case: userId IS the owner, so a rule keyed on raw
    // userId would wave the agent through on the owner's authority.
    await resolveDirectVaultCredential({
      vaultId: "v1",
      secretRow: { userId: OWNER, isPodWide: false },
      userId: OWNER,
      agentUserId: AGENT,
      workspaceId: "ws-1",
    });
    expect(optsPassed()).toEqual({
      requireGrant: true,
      redeemer: { agentUserId: AGENT, workspaceId: "ws-1" },
    });
  });

  it("a POD-WIDE shared secret is ungated even for an agent", async () => {
    await resolveDirectVaultCredential({
      vaultId: "v1",
      secretRow: { userId: OWNER, isPodWide: true },
      userId: OWNER,
      agentUserId: AGENT,
    });
    expect(optsPassed()).toBeUndefined();
  });

  it("a non-owner human is gated, redeemed as themselves", async () => {
    await resolveDirectVaultCredential({
      vaultId: "v1",
      secretRow: { userId: OWNER, isPodWide: false },
      userId: "someone-else",
    });
    expect(optsPassed()).toEqual({
      requireGrant: true,
      redeemer: { agentUserId: "someone-else", workspaceId: null },
    });
  });

  it("a refused grant is a 403 with the reason, never a silent empty secret", async () => {
    mockResolveVaultSecret.mockRejectedValueOnce(new Error("no active grant"));
    const r = await resolveDirectVaultCredential({
      vaultId: "v1",
      secretRow: { userId: OWNER, isPodWide: false },
      userId: OWNER,
      agentUserId: AGENT,
    });
    expect(r).toMatchObject({ ok: false, result: { status: 403 } });
    expect(JSON.stringify(r)).toContain("no active grant");
  });

  it("an unresolvable secret is a 404", async () => {
    mockResolveVaultSecret.mockResolvedValueOnce(null);
    const r = await resolveDirectVaultCredential({
      vaultId: "v1",
      secretRow: { userId: OWNER, isPodWide: false },
      userId: OWNER,
    });
    expect(r).toMatchObject({ ok: false, result: { status: 404 } });
  });
});

describe("resolveMcpServerAuthHeader", () => {
  const AUTH = {
    credentialRef: "vault://v1",
    header: "Authorization",
    prefix: "Bearer ",
  };

  it("builds the header from a pod-wide key for an agent", async () => {
    mockFindFirst.mockResolvedValueOnce({
      userId: OWNER,
      isPodWide: true,
      providerIntegrationId: null,
    });
    const r = await resolveMcpServerAuthHeader(AUTH, {
      userId: OWNER,
      agentUserId: AGENT,
    });
    expect(r).toEqual({
      ok: true,
      headers: { Authorization: "Bearer s3cret" },
    });
  });

  it("refuses a provider-integration credential without decrypting anything", async () => {
    mockFindFirst.mockResolvedValueOnce({
      userId: OWNER,
      isPodWide: true,
      providerIntegrationId: "nango-1",
    });
    const r = await resolveMcpServerAuthHeader(AUTH, { userId: OWNER });
    expect(r.ok).toBe(false);
    expect(mockResolveVaultSecret).not.toHaveBeenCalled();
  });

  it("reports a missing secret instead of returning no header", async () => {
    mockFindFirst.mockResolvedValueOnce(undefined);
    const r = await resolveMcpServerAuthHeader(AUTH, { userId: OWNER });
    expect(r).toMatchObject({ ok: false });
  });
});
