import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PASSKEY_DATA_UNREADABLE,
  PasskeyCancelled,
  base64UrlToBuffer,
  bufferToBase64Url,
  createPasskey,
  passkeyCreationOptions,
} from "./passkey";

const bytes = (b: ArrayBuffer | ArrayBufferView | undefined) =>
  Array.from(new Uint8Array(b as ArrayBuffer));

/** `passkey_create_data` of a Kratos v1.3.1 REGISTRATION flow (passkeyCreateData). */
const registrationData = JSON.stringify({
  credentialOptions: {
    publicKey: {
      challenge: "AQID", // [1,2,3]
      rp: { name: "Synap", id: "lab.pod.synap.live" },
      user: { id: "BAUG", name: "", displayName: "" }, // [4,5,6]
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 60000,
      authenticatorSelection: { residentKey: "required" },
      extensions: { credProps: true },
    },
  },
  displayNameFieldName: "traits.email",
});

/** `passkey_create_data` of a SETTINGS flow: the options themselves. */
const settingsData = JSON.stringify({
  publicKey: {
    challenge: "BwgJ",
    rp: { name: "Synap", id: "lab.pod.synap.live" },
    user: { id: "Cgs", name: "ada@example.com", displayName: "Ada" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    excludeCredentials: [{ id: "DA", type: "public-key" }],
  },
});

describe("base64url", () => {
  it("round-trips bytes without padding, url-safe", () => {
    const raw = new Uint8Array([251, 255, 0, 1, 2]);
    const enc = bufferToBase64Url(raw);
    expect(enc).not.toMatch(/[+/=]/);
    expect(bytes(base64UrlToBuffer(enc))).toEqual([251, 255, 0, 1, 2]);
  });
});

describe("passkeyCreationOptions", () => {
  it("reads a registration flow's data and names the passkey after the person", () => {
    const o = passkeyCreationOptions(registrationData, {
      name: "ada@example.com",
    });
    expect(bytes(o.challenge as ArrayBuffer)).toEqual([1, 2, 3]);
    expect(bytes(o.user.id as ArrayBuffer)).toEqual([4, 5, 6]);
    expect(o.user.name).toBe("ada@example.com");
    expect(o.user.displayName).toBe("ada@example.com");
    expect(o.rp.id).toBe("lab.pod.synap.live");
    // Passed through as webauthn.js does.
    expect(o.authenticatorSelection).toEqual({ residentKey: "required" });
    expect(o.extensions).toEqual({ credProps: true });
  });

  it("reads a settings flow's data and keeps the server's names", () => {
    const o = passkeyCreationOptions(settingsData, { name: "ignored" });
    expect(o.user.name).toBe("ada@example.com");
    expect(o.user.displayName).toBe("Ada");
    expect(bytes(o.excludeCredentials![0]!.id as ArrayBuffer)).toEqual([12]);
  });

  it("refuses data that is not a creation request", () => {
    expect(() => passkeyCreationOptions("not json")).toThrow(
      PASSKEY_DATA_UNREADABLE
    );
    expect(() =>
      passkeyCreationOptions(JSON.stringify({ publicKey: { rp: {} } }))
    ).toThrow(PASSKEY_DATA_UNREADABLE);
  });
});

describe("createPasskey", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubWebAuthn(create: (o: unknown) => Promise<unknown>) {
    // pod-admin's vitest runs in node: give it the two browser globals used.
    vi.stubGlobal("window", { PublicKeyCredential: function PKC() {} });
    vi.stubGlobal("navigator", { credentials: { create } });
  }

  it("encodes the created credential the way Kratos reads it", async () => {
    const create = vi.fn(async () => ({
      id: "cred-1",
      rawId: new Uint8Array([1, 2]).buffer,
      type: "public-key",
      response: {
        attestationObject: new Uint8Array([3]).buffer,
        clientDataJSON: new Uint8Array([4]).buffer,
      },
    }));
    stubWebAuthn(create);
    const value = await createPasskey(registrationData, {
      name: "ada@example.com",
    });
    expect(JSON.parse(value)).toEqual({
      id: "cred-1",
      rawId: "AQI",
      type: "public-key",
      response: { attestationObject: "Aw", clientDataJSON: "BA" },
    });
    expect(create).toHaveBeenCalledWith({ publicKey: expect.any(Object) });
  });

  it("a dismissed prompt is PasskeyCancelled, not an error to show", async () => {
    stubWebAuthn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    await expect(
      createPasskey(registrationData, { name: "a@b.c" })
    ).rejects.toBeInstanceOf(PasskeyCancelled);
  });
});
