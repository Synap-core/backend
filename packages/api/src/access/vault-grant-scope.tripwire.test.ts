/**
 * VAULT-GRANT-SCOPE TRIPWIRE
 *
 * At redemption (`findRedeemableGrant`), a NULL `granted_to` and a NULL
 * `workspace_id` each act as a WILDCARD — a `vault_grants` row with BOTH null is
 * redeemable by ANY principal reaching `/vault/redeem` (via the skill's
 * `secrets.get(ref)` bridge). That is a latent cross-user secret-read footgun.
 *
 * `assertGrantScoped` is the canonical issuance-time guard that forbids minting
 * such a grant. This tripwire asserts:
 *   1. a fully-wildcard grant (both binding columns null/undefined) THROWS;
 *   2. a normally-scoped grant (user-only, workspace-only, or both) still
 *      succeeds.
 *
 * It also asserts that the single live `vault_grants` insert site routes through
 * the guard — so a future second issuance path can't silently skip the firewall.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { assertGrantScoped, UnscopedVaultGrantError } from "@synap/database";

describe("assertGrantScoped (vault grant firewall)", () => {
  it("THROWS on a fully-wildcard grant (both null)", () => {
    expect(() =>
      assertGrantScoped({ grantedTo: null, workspaceId: null })
    ).toThrow(UnscopedVaultGrantError);
  });

  it("THROWS on a fully-wildcard grant (both undefined)", () => {
    expect(() =>
      assertGrantScoped({ grantedTo: undefined, workspaceId: undefined })
    ).toThrow(UnscopedVaultGrantError);
  });

  it("allows a grant scoped to a user", () => {
    expect(() =>
      assertGrantScoped({ grantedTo: "user-123", workspaceId: null })
    ).not.toThrow();
  });

  it("allows a grant scoped to a workspace", () => {
    expect(() =>
      assertGrantScoped({ grantedTo: null, workspaceId: "ws-456" })
    ).not.toThrow();
  });

  it("allows a grant scoped to both a user and a workspace", () => {
    expect(() =>
      assertGrantScoped({ grantedTo: "user-123", workspaceId: "ws-456" })
    ).not.toThrow();
  });
});

describe("vault_grants insert sites route through the firewall", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const issuanceFile = join(here, "..", "routers", "secrets-vault.ts");

  it("the issuance site calls assertGrantScoped before inserting", () => {
    const src = readFileSync(issuanceFile, "utf8");
    expect(src).toContain(".insert(vaultGrants)");
    expect(src).toContain("assertGrantScoped(");
  });
});
