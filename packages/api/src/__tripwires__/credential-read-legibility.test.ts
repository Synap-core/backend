import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/**
 * WAVE-1 invariant: reading a credential must be able to tell "not configured"
 * from "configured but unreadable".
 *
 * The bug this locks: `getServiceSecret` and `resolveNangoConnector` both
 * collapsed vault-unavailable / undecryptable / db-error into a single `null`,
 * so a broken vault degraded silently to the env tier and the pod kept working.
 * Once the env tier is removed, that same silence becomes "you never configured
 * Nango" — an operator chasing a missing feature instead of a broken key.
 *
 * These are SOURCE-level proofs (no DB/vault mocking, which is fragile in this
 * package). They assert the STRUCTURE that keeps the read path honest:
 *   1. a typed result function exists and enumerates the distinct failure reasons
 *   2. the lossy `null`-returning helper is a thin WRAPPER over it, so no second
 *      failure-swallowing implementation can be re-introduced.
 */

const vaultSrc = readFileSync(
  new URL("../../../database/src/utils/vault-resolver.ts", import.meta.url),
  "utf-8"
);
const connSrc = readFileSync(
  new URL("../connectors/index.ts", import.meta.url),
  "utf-8"
);

describe("tripwire: credential reads distinguish absent from unreadable", () => {
  it("getServiceSecretResult exists and enumerates the fault reasons", () => {
    expect(vaultSrc).toContain("export async function getServiceSecretResult");
    // The whole point is that these are DISTINCT outcomes, not one null.
    for (const reason of [
      "absent",
      "vault-unavailable",
      "undecryptable",
      "db-error",
    ]) {
      expect(
        vaultSrc.includes(`"${reason}"`),
        `ServiceSecretResult must carry reason "${reason}"`
      ).toBe(true);
    }
  });

  it("getServiceSecret is a thin wrapper over getServiceSecretResult (no second lossy impl)", () => {
    const body = vaultSrc.match(
      /export async function getServiceSecret\([\s\S]*?\n}/
    )?.[0];
    expect(body, "getServiceSecret not found").toBeTruthy();
    // It must delegate, and it must NOT re-query the secrets table itself —
    // a hand-rolled body is exactly how the lossy behaviour crept back.
    expect(body).toContain("getServiceSecretResult");
    expect(
      /secrets\.findFirst|db\.query\.secrets/.test(body!),
      "getServiceSecret must delegate, not re-implement the lookup"
    ).toBe(false);
  });

  it("resolveNangoConnectorResult exists and separates not-configured from faults", () => {
    expect(connSrc).toContain(
      "export async function resolveNangoConnectorResult"
    );
    for (const reason of [
      "not-configured",
      "vault-unreadable",
      "db-unavailable",
    ]) {
      expect(
        connSrc.includes(`"${reason}"`),
        `NangoResolveResult must carry reason "${reason}"`
      ).toBe(true);
    }
  });

  it("a vault FAULT does not fall through to the env tier", () => {
    // The ordering guarantee: inside the resolver, a non-absent vault failure
    // returns vault-unreadable rather than continuing to env. If someone deletes
    // this guard, a broken vault silently serves env again.
    expect(connSrc).toContain('vault.reason !== "absent"');
    expect(connSrc).toContain('reason: "vault-unreadable"');
  });

  it("resolveNangoConnector is a thin wrapper over resolveNangoConnectorResult", () => {
    const body = connSrc.match(
      /export async function resolveNangoConnector\(\)[\s\S]*?\n}/
    )?.[0];
    expect(body, "resolveNangoConnector not found").toBeTruthy();
    expect(body).toContain("resolveNangoConnectorResult");
  });
});
