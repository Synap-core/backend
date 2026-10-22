/**
 * The ONE pod-held-factor rule (account recovery, the Kratos settings hook and
 * the unlink confirm all ask it): a password/passkey, else an unused recovery
 * code; a failed read throws, never "no factor".
 */
import { describe, expect, it, vi } from "vitest";
import {
  accountHasPodHeldFactor,
  identityHasPodHeldCredential,
} from "./pod-held-credential.js";

describe("identityHasPodHeldCredential", () => {
  it("a password or passkey is pod-held; Cloud oidc alone is not", () => {
    expect(
      identityHasPodHeldCredential({ credentials: { password: {} } })
    ).toBe(true);
    expect(identityHasPodHeldCredential({ credentials: { passkey: {} } })).toBe(
      true
    );
    expect(identityHasPodHeldCredential({ credentials: { oidc: {} } })).toBe(
      false
    );
    expect(identityHasPodHeldCredential(null)).toBe(false);
  });
});

describe("accountHasPodHeldFactor", () => {
  it("a credential answers without reading the codes", async () => {
    const unusedRecoveryCodes = vi.fn(async () => 0);
    await expect(
      accountHasPodHeldFactor("kid", {
        podHeldCredential: async () => true,
        unusedRecoveryCodes,
      })
    ).resolves.toBe(true);
    expect(unusedRecoveryCodes).not.toHaveBeenCalled();
  });

  it("without one, an unused recovery code is a pod-held factor", async () => {
    const podHeldCredential = vi.fn(async () => false);
    await expect(
      accountHasPodHeldFactor("kid", {
        podHeldCredential,
        unusedRecoveryCodes: async () => 2,
      })
    ).resolves.toBe(true);
    expect(podHeldCredential).toHaveBeenCalledWith("kid");
    await expect(
      accountHasPodHeldFactor("kid", {
        podHeldCredential,
        unusedRecoveryCodes: async () => 0,
      })
    ).resolves.toBe(false);
  });

  it("a failed read throws", async () => {
    await expect(
      accountHasPodHeldFactor("kid", {
        podHeldCredential: async () => false,
        unusedRecoveryCodes: async () => {
          throw new Error("db down");
        },
      })
    ).rejects.toThrow("db down");
  });
});
