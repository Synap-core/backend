import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PASSKEY_DATA_UNREADABLE,
  PasskeyCancelled,
  PasskeyCreateFailed,
  otherRoute,
  planAssertion,
  webauthnTakenOver,
  base64UrlToBuffer,
  bufferToBase64Url,
  createPasskey,
  getPasskeyAssertion,
  passkeyCreationOptions,
  passkeyRequestOptions,
  placePasskey,
  PRESENCE_PROMPT_TIMEOUT_MS,
  type PlacedCreationOptions,
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

/**
 * What Kratos v1.3.1 really sends (`driver/config/config.go` PasskeyConfig):
 * "platform" on every passkey, a required resident key, UV preferred.
 */
const kratosData = JSON.stringify({
  publicKey: {
    challenge: "AQID",
    rp: { name: "Synap", id: "lab.pod.synap.live" },
    user: { id: "BAUG", name: "ada@example.com", displayName: "Ada" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    timeout: 60000,
    attestation: "none",
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      requireResidentKey: true,
      residentKey: "required",
      userVerification: "preferred",
    },
    excludeCredentials: [{ id: "DA", type: "public-key" }],
    extensions: { credProps: true },
  },
});

describe("placePasskey: where the new passkey lives", () => {
  const kratos = () => passkeyCreationOptions(kratosData);

  it("this device: platform attachment and the client-device hint", () => {
    const o = placePasskey(kratos(), "device");
    expect(o.authenticatorSelection?.authenticatorAttachment).toBe("platform");
    expect(o.hints).toEqual(["client-device"]);
  });

  it("password manager: no attachment and no hint, so nothing is hidden", () => {
    const o = placePasskey(kratos(), "manager");
    expect(o.authenticatorSelection).not.toHaveProperty(
      "authenticatorAttachment"
    );
    expect(o).not.toHaveProperty("hints");
  });

  it.each(["device", "manager"] as const)(
    "%s keeps every other field Kratos sent",
    (placement) => {
      const o = placePasskey(kratos(), placement);
      expect(o.authenticatorSelection).toMatchObject({
        requireResidentKey: true,
        residentKey: "required",
        userVerification: "preferred",
      });
      expect(bytes(o.challenge as ArrayBuffer)).toEqual([1, 2, 3]);
      expect(bytes(o.user.id as ArrayBuffer)).toEqual([4, 5, 6]);
      expect(o.user.name).toBe("ada@example.com");
      expect(o.rp).toEqual({ name: "Synap", id: "lab.pod.synap.live" });
      expect(o.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
      expect(o.timeout).toBe(60000);
      expect(o.attestation).toBe("none");
      expect(o.extensions).toEqual({ credProps: true });
      expect(bytes(o.excludeCredentials![0]!.id as ArrayBuffer)).toEqual([12]);
    }
  );

  it("the answer wins over a server's own placement fields", () => {
    const server = {
      ...kratos(),
      hints: ["security-key"],
    } as PlacedCreationOptions;
    expect(placePasskey(server, "device").hints).toEqual(["client-device"]);
    expect(placePasskey(server, "manager")).not.toHaveProperty("hints");
    const crossPlatform = {
      ...kratos(),
      authenticatorSelection: { authenticatorAttachment: "cross-platform" },
    } as PublicKeyCredentialCreationOptions;
    expect(
      placePasskey(crossPlatform, "device").authenticatorSelection
        ?.authenticatorAttachment
    ).toBe("platform");
  });

  it("a server that sent no authenticatorSelection still gets the device answer", () => {
    const { authenticatorSelection: _none, ...bare } = kratos();
    const o = placePasskey(bare, "device");
    expect(o.authenticatorSelection).toEqual({
      authenticatorAttachment: "platform",
    });
    expect(placePasskey(bare, "manager").authenticatorSelection).toEqual({});
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
    const value = await createPasskey(registrationData, "device", {
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

  it.each([
    ["device", "platform", ["client-device"]],
    ["manager", undefined, undefined],
  ] as const)(
    "asks the browser with the %s answer merged in",
    async (placement, attachment, hints) => {
      const create = vi.fn(async (_o: unknown) => ({
        id: "c",
        rawId: new Uint8Array([1]).buffer,
        type: "public-key",
        response: {
          attestationObject: new Uint8Array([2]).buffer,
          clientDataJSON: new Uint8Array([3]).buffer,
        },
      }));
      stubWebAuthn(create);
      await createPasskey(kratosData, placement);
      const { publicKey } = create.mock.calls[0]![0] as {
        publicKey: PlacedCreationOptions;
      };
      expect(publicKey.authenticatorSelection?.authenticatorAttachment).toBe(
        attachment
      );
      expect(publicKey.hints).toEqual(hints);
      expect(publicKey.authenticatorSelection?.residentKey).toBe("required");
      expect(publicKey.authenticatorSelection?.userVerification).toBe(
        "preferred"
      );
    }
  );

  it("a dismissed prompt is PasskeyCancelled, not an error to show", async () => {
    stubWebAuthn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    await expect(
      createPasskey(registrationData, "manager", { name: "a@b.c" })
    ).rejects.toBeInstanceOf(PasskeyCancelled);
  });
});

describe("proof of presence: the assertion (W3)", () => {
  const request = {
    challenge: "AQID", // [1,2,3]
    rpId: "lab.pod.synap.live",
    rpIds: ["lab.pod.synap.live", "pod.synap.live"],
    allowCredentials: [
      {
        id: "BAUG",
        type: "public-key" as const,
        holder: "unknown" as const,
        name: null,
      },
    ],
    userVerification: "required" as const,
  };

  afterEach(() => vi.unstubAllGlobals());

  it("asks with the pod's challenge, rp id and passkeys, user verification REQUIRED", () => {
    const options = passkeyRequestOptions(request);
    expect(bytes(options.challenge as ArrayBuffer)).toEqual([1, 2, 3]);
    expect(options.rpId).toBe("lab.pod.synap.live");
    expect(options.userVerification).toBe("required");
    expect(options.timeout).toBe(PRESENCE_PROMPT_TIMEOUT_MS);
    expect(
      options.allowCredentials!.map((c) => [c.type, bytes(c.id as ArrayBuffer)])
    ).toEqual([["public-key", [4, 5, 6]]]);
  });

  it("encodes the signed assertion as the approve doors read it (base64url, no padding)", async () => {
    const buf = (...b: number[]) => new Uint8Array(b).buffer;
    const credential = {
      id: "BAUG",
      rawId: buf(4, 5, 6),
      type: "public-key",
      response: {
        clientDataJSON: buf(251, 255),
        authenticatorData: buf(7),
        signature: buf(8, 9),
        userHandle: null,
      },
      getClientExtensionResults: () => ({}),
    };
    const get = vi.fn(async () => credential);
    vi.stubGlobal("window", { PublicKeyCredential: function PKC() {} });
    vi.stubGlobal("navigator", { credentials: { get } });
    await expect(getPasskeyAssertion(request)).resolves.toEqual({
      id: "BAUG",
      rawId: "BAUG",
      type: "public-key",
      response: {
        clientDataJSON: "-_8",
        authenticatorData: "Bw",
        signature: "CAk",
        userHandle: null,
      },
      clientExtensionResults: {},
    });
    const passed = (
      get.mock.calls[0] as unknown as [CredentialRequestOptions]
    )[0];
    expect(passed.publicKey?.userVerification).toBe("required");
  });

  it("a closed prompt (NotAllowedError) is PasskeyCancelled", async () => {
    vi.stubGlobal("window", { PublicKeyCredential: function PKC() {} });
    vi.stubGlobal("navigator", {
      credentials: {
        get: async () => {
          throw new DOMException("denied", "NotAllowedError");
        },
      },
    });
    await expect(getPasskeyAssertion(request)).rejects.toBeInstanceOf(
      PasskeyCancelled
    );
  });
});

// ─── Past a password-manager extension (6 Nov 2026) ───────────────────────
//
// The founder's passkey is in iCloud Keychain; Bitwarden replaced
// `navigator.credentials.get` as an OWN property of the page's instance and
// answered "no passkey" (NotAllowedError). The browser's own method stays on
// `CredentialsContainer.prototype`.

/** A function whose source reads `[native code]`, as the browser's own do (a bound function does in V8). */
function nativeLike<T extends (...args: never[]) => unknown>(impl: T): T {
  return impl.bind(null) as T;
}

/** A page whose `navigator.credentials` is a CredentialsContainer, its methods the prototype's unless `own` replaces them. */
function stubPage(
  proto: { get?: unknown; create?: unknown },
  own: { get?: unknown; create?: unknown } = {}
) {
  class CredentialsContainer {}
  Object.assign(CredentialsContainer.prototype, proto);
  const credentials = Object.assign(new CredentialsContainer(), own);
  vi.stubGlobal("CredentialsContainer", CredentialsContainer);
  vi.stubGlobal("window", { PublicKeyCredential: function PKC() {} });
  vi.stubGlobal("navigator", { credentials, userAgent: "test" });
  return credentials;
}

describe("webauthnTakenOver: an extension replaced WebAuthn in the page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the browser's own methods, untouched: not taken over", () => {
    stubPage({
      get: nativeLike(async () => null),
      create: nativeLike(async () => null),
    });
    expect(webauthnTakenOver("get")).toBe(false);
    expect(webauthnTakenOver("create")).toBe(false);
  });

  it("an own property on navigator.credentials (Bitwarden): taken over", () => {
    stubPage({ get: nativeLike(async () => null) }, { get: async () => null });
    expect(webauthnTakenOver("get")).toBe(true);
  });

  it("an own property that even reads as native code is still another function: taken over", () => {
    stubPage(
      { get: nativeLike(async () => null) },
      { get: nativeLike(async () => null) }
    );
    expect(webauthnTakenOver("get")).toBe(true);
  });

  it("the prototype itself patched with a script (Dashlane): taken over", () => {
    stubPage({ get: async () => null });
    expect(webauthnTakenOver("get")).toBe(true);
  });

  it("no CredentialsContainer to compare with: not taken over", () => {
    vi.stubGlobal("navigator", { credentials: { get: async () => null } });
    expect(webauthnTakenOver("get")).toBe(false);
  });
});

describe("planAssertion: which prompt Confirm opens", () => {
  it("no extension: the page's call, nothing else to offer", () => {
    expect(planAssertion(["device", "manager"], false)).toEqual({
      route: "page",
      fallback: null,
    });
  });

  it("an extension and only device passkeys: the browser's own prompt, no fallback", () => {
    expect(planAssertion(["device"], true)).toEqual({
      route: "native",
      fallback: null,
    });
  });

  it("an extension and passkeys of unknown home (or a challenge from a pod before holders): both prompts on offer", () => {
    expect(planAssertion(["unknown"], true)).toEqual({
      route: "native",
      fallback: "page",
    });
  });

  it("an extension, device and unknown passkeys: the browser's own prompt, then the page's", () => {
    expect(planAssertion(["device", "unknown"], true)).toEqual({
      route: "native",
      fallback: "page",
    });
  });

  it("an extension holding a manager passkey: the page's call, this device's offered after", () => {
    expect(planAssertion(["manager", "device"], true)).toEqual({
      route: "page",
      fallback: "native",
    });
    expect(planAssertion(["manager", "unknown"], true)).toEqual({
      route: "page",
      fallback: "native",
    });
    expect(planAssertion(["manager"], true)).toEqual({
      route: "page",
      fallback: null,
    });
  });

  it("otherRoute: after either prompt failed, the plan's other one", () => {
    const plan = { route: "page", fallback: "native" } as const;
    expect(otherRoute(plan, "page")).toBe("native");
    expect(otherRoute(plan, "native")).toBe("page");
    expect(otherRoute({ route: "native", fallback: null }, "native")).toBe(
      null
    );
  });
});

describe("the native route reaches the browser's own prompt past the extension", () => {
  afterEach(() => vi.unstubAllGlobals());

  const request = {
    challenge: "AQID",
    rpId: "lab.pod.synap.live",
    rpIds: ["lab.pod.synap.live"],
    allowCredentials: [
      {
        id: "BAUG",
        type: "public-key" as const,
        holder: "device" as const,
        name: "iCloud Keychain",
      },
    ],
    userVerification: "required" as const,
  };
  const buf = (...b: number[]) => new Uint8Array(b).buffer;
  const signed = {
    id: "BAUG",
    rawId: buf(4, 5, 6),
    type: "public-key",
    response: {
      clientDataJSON: buf(1),
      authenticatorData: buf(2),
      signature: buf(3),
      userHandle: null,
    },
  };

  it("assertion by `native`: the prototype's get, called on navigator.credentials; the extension's never", async () => {
    const browser = vi.fn(async function (this: unknown) {
      return { ...signed, self: this };
    });
    const extension = vi.fn(async () => {
      throw new DOMException("No passkey found", "NotAllowedError");
    });
    const credentials = stubPage({ get: browser }, { get: extension });
    await expect(getPasskeyAssertion(request, "native")).resolves.toMatchObject(
      { id: "BAUG" }
    );
    expect(browser).toHaveBeenCalledTimes(1);
    expect(browser.mock.contexts[0]).toBe(credentials);
    expect(extension).not.toHaveBeenCalled();
  });

  it('an extension\'s "no passkey" is a closed prompt that keeps its words for Copy details', async () => {
    stubPage(
      { get: nativeLike(async () => signed) },
      {
        get: async () => {
          throw new DOMException("No passkey found", "NotAllowedError");
        },
      }
    );
    const err = await getPasskeyAssertion(request, "page").catch((e) => e);
    expect(err).toBeInstanceOf(PasskeyCancelled);
    expect((err as PasskeyCancelled).detail).toBe(
      "NotAllowedError: No passkey found"
    );
  });

  it("assertion by `page`: the page's get, whatever replaced it", async () => {
    const browser = vi.fn(async () => signed);
    const extension = vi.fn(async () => signed);
    stubPage({ get: browser }, { get: extension });
    await getPasskeyAssertion(request, "page");
    expect(extension).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  const created = {
    id: "c",
    rawId: buf(1),
    type: "public-key",
    response: { attestationObject: buf(2), clientDataJSON: buf(3) },
  };

  it("creation on this device with an extension in the page: the prototype's create", async () => {
    const browser = vi.fn(async () => created);
    const extension = vi.fn(async () => created);
    stubPage({ create: nativeLike(browser) }, { create: extension });
    await createPasskey(kratosData, "device");
    expect(browser).toHaveBeenCalledTimes(1);
    expect(extension).not.toHaveBeenCalled();
  });

  it("creation in a password manager: the page's create, so the extension takes it", async () => {
    const browser = vi.fn(async () => created);
    const extension = vi.fn(async () => created);
    stubPage({ create: nativeLike(browser) }, { create: extension });
    await createPasskey(kratosData, "manager");
    expect(extension).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it.each([
    ["InvalidStateError", "exists"],
    ["AbortError", "timeout"],
    ["TimeoutError", "timeout"],
    ["SecurityError", "failed"],
  ] as const)(
    "a creation refused with %s says why (%s), the browser's words kept for Copy details",
    async (name, reason) => {
      stubPage({
        create: nativeLike(async () => {
          throw new DOMException("the browser's own words", name);
        }),
      });
      const err = await createPasskey(kratosData, "device").catch((e) => e);
      expect(err).toBeInstanceOf(PasskeyCreateFailed);
      expect((err as PasskeyCreateFailed).reason).toBe(reason);
      expect((err as Error).message).toBe(`${name}: the browser's own words`);
    }
  );
});
