import { describe, expect, it } from "vitest";
import {
  PASSKEY_AUTHENTICATORS,
  aaguidFromBytes,
  passkeyHolder,
} from "./index.js";

describe("passkeyHolder", () => {
  it("a device store is `device`, Kratos' own name first", () => {
    expect(
      passkeyHolder("fbfc3007-154e-4ecc-8c0b-6e020557d7bd", "iCloud Keychain")
    ).toEqual({ holder: "device", name: "iCloud Keychain" });
    expect(passkeyHolder("FBFC3007-154E-4ECC-8C0B-6E020557D7BD")).toEqual({
      holder: "device",
      name: "Apple Passwords",
    });
  });

  it("an extension-held manager is `manager`", () => {
    for (const aaguid of [
      "d548826e-79b4-db40-a3d8-11116f7e8349", // Bitwarden
      "bada5566-a7aa-401f-bd96-45619a55120d", // 1Password
      "531126d6-e717-415c-9320-3d9aa6981239", // Dashlane
      "50726f74-6f6e-5061-7373-50726f746f6e", // Proton Pass
    ]) {
      expect(passkeyHolder(aaguid).holder).toBe("manager");
    }
  });

  it("unlisted, all-zero, malformed or missing is `unknown`", () => {
    expect(passkeyHolder("00000000-0000-0000-0000-000000000000")).toEqual({
      holder: "unknown",
      name: null,
    });
    expect(passkeyHolder("not-an-aaguid", "YubiKey 5")).toEqual({
      holder: "unknown",
      name: "YubiKey 5",
    });
    expect(passkeyHolder(null)).toEqual({ holder: "unknown", name: null });
    expect(passkeyHolder(undefined, "  ")).toEqual({
      holder: "unknown",
      name: null,
    });
  });

  it("every row is a lowercase hyphenated AAGUID with a name", () => {
    for (const [aaguid, row] of Object.entries(PASSKEY_AUTHENTICATORS)) {
      expect(aaguid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(row.name.trim()).not.toBe("");
    }
  });
});

describe("aaguidFromBytes", () => {
  it("16 bytes → the hyphenated form; anything else → null", () => {
    const bytes = Uint8Array.from(
      "fbfc3007154e4ecc8c0b6e020557d7bd"
        .match(/../g)!
        .map((h) => parseInt(h, 16))
    );
    expect(aaguidFromBytes(bytes)).toBe("fbfc3007-154e-4ecc-8c0b-6e020557d7bd");
    expect(aaguidFromBytes(new Uint8Array(15))).toBeNull();
  });
});
