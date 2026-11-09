/**
 * `passkeysFromKratos`: Kratos v1.3.1 records each passkey's authenticator
 * AAGUID (16 bytes, base64) and names its store (`display_name`). The
 * presence challenge reads both to say where each passkey lives.
 *
 * Pure: `@synap/auth` (Kratos) is not reached.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@synap/auth", () => ({ kratosAdmin: {} }));

import { passkeysFromKratos } from "./proof.js";

/** The founder's passkey (6 Nov 2026): Apple's AAGUID, as Kratos stores it. */
const ICLOUD_AAGUID_B64 = Buffer.from(
  "fbfc3007154e4ecc8c0b6e020557d7bd",
  "hex"
).toString("base64");

describe("passkeysFromKratos", () => {
  it("reads the AAGUID as a hyphenated UUID and keeps Kratos' name", () => {
    const [p] = passkeysFromKratos([
      {
        id: Buffer.from([1, 2, 3]).toString("base64"),
        public_key: Buffer.from([9]).toString("base64"),
        authenticator: { sign_count: 4, aaguid: ICLOUD_AAGUID_B64 },
        display_name: "iCloud Keychain",
      },
    ]);
    expect(p).toMatchObject({
      id: "AQID",
      counter: 4,
      aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
      displayName: "iCloud Keychain",
    });
  });

  it("no AAGUID, a malformed one, or no name read as null", () => {
    const base = {
      id: Buffer.from([1]).toString("base64"),
      public_key: Buffer.from([9]).toString("base64"),
    };
    const out = passkeysFromKratos([
      base,
      { ...base, authenticator: { aaguid: "AAEC" }, display_name: "  " },
    ]);
    expect(out.map((p) => [p.aaguid, p.displayName])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it("skips a credential with no id or public key", () => {
    expect(passkeysFromKratos([{ id: "AQ==" }, {}])).toEqual([]);
  });
});
