import { describe, expect, it } from "vitest";
import {
  isVaultCredentialRef,
  partitionProvidersByCredential,
  providerIdForTool,
} from "./capability-registry.js";

/**
 * The credential-ref DERIVATION, tested without a database.
 *
 * Both defects this file guards lived here rather than in the query around it:
 * a remapped `vault://<uuid>` was echoed to the user as the provider id, and
 * treating a vault secret like a brokered account made every pasted-key
 * provider read "not connected" while its key sat in the vault (Stripe,
 * measured 2026-10-07). The query reads this predicate, so proving the
 * predicate is proving the query's branch.
 */
describe("isVaultCredentialRef — vault secret vs broker account", () => {
  it("reads a remapped vault ref as a stored secret", () => {
    expect(isVaultCredentialRef("vault://54823334-672f-48b7-9fd2-fbacc2962c70")).toBe(true);
    // The template's own spelling, before the apply-time rewrite.
    expect(isVaultCredentialRef("vault://stripe")).toBe(true);
    expect(isVaultCredentialRef("VAULT://Stripe")).toBe(true);
    expect(isVaultCredentialRef("  vault://x  ")).toBe(true);
  });

  it("does not read a broker ref — or anything else — as a vault secret", () => {
    expect(isVaultCredentialRef("nango://google-mail")).toBe(false);
    // A bare ref is the template's pre-remap form for a broker connection.
    expect(isVaultCredentialRef("stripe")).toBe(false);
    expect(isVaultCredentialRef(null)).toBe(false);
    expect(isVaultCredentialRef(undefined)).toBe(false);
    expect(isVaultCredentialRef("")).toBe(false);
    // Not a scheme match: the prefix must END at `://`, so a service that merely
    // starts with the letters is not swallowed.
    expect(isVaultCredentialRef("vaultx://y")).toBe(false);
  });
});

describe("providerIdForTool — the id a connector could match", () => {
  it("names a vault-backed tool by its OWN name, never the opaque id", () => {
    // The shipped defect: the Connected page printed
    // "Vault://54823334-672f-48b7-9fd2-fbacc2962c70" at the user.
    expect(
      providerIdForTool({
        credentialRef: "vault://54823334-672f-48b7-9fd2-fbacc2962c70",
        name: "stripe",
      }),
    ).toBe("stripe");
  });

  it("strips the broker scheme so the remainder is the provider", () => {
    expect(
      providerIdForTool({ credentialRef: "nango://google-mail", name: "Nango — Google Workspace" }),
    ).toBe("google-mail");
  });

  it("falls back to the tool's name when there is no ref at all", () => {
    expect(providerIdForTool({ credentialRef: null, name: "custom-thing" })).toBe("custom-thing");
    expect(providerIdForTool({ credentialRef: "", name: "custom-thing" })).toBe("custom-thing");
  });

  it("never returns an empty provider", () => {
    expect(providerIdForTool({ credentialRef: "nango://", name: "fallback" })).toBe("fallback");
  });
});

describe("partitionProvidersByCredential — which proof of 'connected' applies", () => {
  it("routes each provider to the query that can actually prove it", () => {
    // The shipped defect in one assertion: the vault-backed Stripe was sent
    // through the broker query, which demands an `accountHint` it will never
    // have, so it read "not connected" with its key in the vault.
    const { brokered, vault } = partitionProvidersByCredential([
      { id: "t-stripe", kind: "provider", credentialRef: "vault://54823334-x" },
      { id: "t-gmail", kind: "provider", credentialRef: "nango://google-mail" },
      { id: "t-canva", kind: "provider", credentialRef: null },
    ]);
    expect(vault).toEqual(["t-stripe"]);
    expect(brokered).toEqual(["t-gmail", "t-canva"]);
  });

  it("partitions only provider rows — a skill or command has no connection", () => {
    const { brokered, vault } = partitionProvidersByCredential([
      { id: "s-1", kind: "skill", credentialRef: "vault://x" },
      { id: "c-1", kind: "instruction", credentialRef: null },
    ]);
    expect(brokered).toEqual([]);
    expect(vault).toEqual([]);
  });

  it("keeps every id, so no provider is silently dropped from both queries", () => {
    const rows = [
      { id: "a", kind: "provider", credentialRef: "vault://x" },
      { id: "b", kind: "provider", credentialRef: "nango://y" },
      { id: "c", kind: "provider", credentialRef: null },
    ];
    const { brokered, vault } = partitionProvidersByCredential(rows);
    expect([...brokered, ...vault].sort()).toEqual(["a", "b", "c"]);
  });
});
