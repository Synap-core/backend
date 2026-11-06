/**
 * The browser half of Kratos' passkey CREATION ceremony, for pod-admin's own
 * pages: the invite page's "Create a passkey" (a registration flow) and
 * Settings › Security's "Add a passkey" (a settings flow).
 *
 * Kratos v1.3.1 hands the options in the `passkey_create_data` node and reads
 * the result from a hidden field (`passkey_register` in registration,
 * `passkey_settings_register` in settings). The encoding mirrors Kratos'
 * `webauthn.js` (`__oryPasskeyRegistration` / `__oryPasskeySettingsRegistration`):
 * byte fields travel as base64url without padding; a registration's data is
 * `{ credentialOptions: { publicKey }, displayNameFieldName }` with an empty
 * `user.name`, which the page fills from the typed email. A settings flow's
 * data is `{ publicKey }` with the user already named.
 *
 * The same contract is implemented for the web apps in synap-app
 * (`apps/base/lib/kit/auth-ui/webauthn.ts`); pod-admin cannot import it (another
 * repository, no shared package), so this is its own copy of the ceremony.
 */

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";
import {
  PRESENCE_CHALLENGE_TTL_SECONDS,
  type PasskeyAssertionJSON,
} from "@synap-core/types/presence";

/** base64url (no padding) → bytes, as Kratos' `__oryWebAuthnBufferDecode`. */
export function base64UrlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

/** bytes → base64url (no padding), as Kratos' `__oryWebAuthnBufferEncode`. */
export function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** This browser exposes WebAuthn (the passkey way is offered only then). */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.create === "function"
  );
}

interface EncodedCredentialDescriptor {
  id: string;
  type: PublicKeyCredentialType;
  transports?: AuthenticatorTransport[];
}

interface EncodedCreationOptions {
  challenge: string;
  rp: PublicKeyCredentialRpEntity;
  user: { id: string; name?: string; displayName?: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: EncodedCredentialDescriptor[] | null;
}

/** The thrown message when the server's data is not a creation request. */
export const PASSKEY_DATA_UNREADABLE =
  "This pod sent passkey data the page could not read. Try again, or choose another way.";

/**
 * `passkey_create_data` → WebAuthn creation options. Accepts the registration
 * shape (`credentialOptions.publicKey`) and the settings shape (`publicKey`).
 * `person` names the passkey when the server left it unnamed (registration):
 * the email, so the person's passkey manager lists it under that address.
 */
export function passkeyCreationOptions(
  createData: string,
  person?: { name: string; displayName?: string }
): PublicKeyCredentialCreationOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(createData);
  } catch {
    throw new Error(PASSKEY_DATA_UNREADABLE);
  }
  const root = (parsed ?? {}) as {
    credentialOptions?: { publicKey?: EncodedCreationOptions };
    publicKey?: EncodedCreationOptions;
  };
  const pk = root.credentialOptions?.publicKey ?? root.publicKey;
  if (!pk?.challenge || !pk.user?.id || !pk.rp) {
    throw new Error(PASSKEY_DATA_UNREADABLE);
  }
  const name = pk.user.name || person?.name || "";
  // Everything the server sent passes through (extensions, hints, …) as
  // webauthn.js does; only the byte fields are decoded.
  return {
    ...(pk as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64UrlToBuffer(pk.challenge),
    user: {
      id: base64UrlToBuffer(pk.user.id),
      name,
      displayName: pk.user.displayName || person?.displayName || name,
    },
    excludeCredentials: (pk.excludeCredentials ?? []).map((c) => ({
      ...c,
      id: base64UrlToBuffer(c.id),
    })),
  };
}

/**
 * Where a new passkey lives: the person's answer to "Where should this
 * passkey live?", asked wherever pod admin creates one (Settings › Security,
 * the invite page; the presence dialog's "Add a passkey" opens Settings).
 *
 *  - `device`: this computer's own lock (Touch ID, Windows Hello).
 *  - `manager`: a password manager, a security key or a phone.
 */
export type PasskeyPlacement = "device" | "manager";

/**
 * Creation options with WebAuthn L3 `hints`, which TypeScript 5.9's DOM lib
 * types only on the JSON form (`PublicKeyCredentialCreationOptionsJSON`).
 * A browser that does not know `hints` ignores it.
 */
export type PlacedCreationOptions = PublicKeyCredentialCreationOptions & {
  hints?: ("client-device" | "security-key" | "hybrid")[];
};

/**
 * The person's placement merged onto the server's creation options. The
 * answer owns exactly two fields; everything else Kratos sent passes through
 * (`residentKey`, `requireResidentKey`, `userVerification`, extensions, …).
 *
 * Kratos v1.3.1 asks for `authenticatorAttachment: "platform"` on EVERY
 * passkey (`driver/config/config.go` `PasskeyConfig`), so:
 *  - `device` keeps "platform" and adds the WebAuthn L3 hint
 *    `["client-device"]`: the browser's own prompt goes to this device first.
 *  - `manager` drops the attachment and sends no hints: "platform" would hide
 *    security keys and phones from the browser's prompt. L3 has no hint for a
 *    password manager ("security-key" is a USB/NFC key, "hybrid" a phone by
 *    QR code), and a manager the operating system lists (iCloud Keychain,
 *    1Password on macOS) counts as "client-device"; hinting "security-key" or
 *    "hybrid" would open the USB or QR dialog first and bury it. With neither
 *    field, the browser and any password-manager extension offer everything.
 *
 * Both are requests, not guarantees: a password-manager extension replaces
 * `navigator.credentials.create` in the page and may take the passkey either
 * way (the words say how to pick the device then).
 */
export function placePasskey(
  options: PlacedCreationOptions,
  placement: PasskeyPlacement
): PlacedCreationOptions {
  const { hints: _serverHints, ...rest } = options;
  const { authenticatorAttachment: _serverAttachment, ...selection } =
    options.authenticatorSelection ?? {};
  if (placement === "device") {
    return {
      ...rest,
      authenticatorSelection: {
        ...selection,
        authenticatorAttachment: "platform",
      },
      hints: ["client-device"],
    };
  }
  return { ...rest, authenticatorSelection: selection };
}

/** A created credential as Kratos reads it from the register field. */
export function encodeAttestation(credential: PublicKeyCredential): string {
  const response = credential.response as AuthenticatorAttestationResponse;
  return JSON.stringify({
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      attestationObject: bufferToBase64Url(response.attestationObject),
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
    },
  });
}

/** The person closed the passkey prompt or it timed out: not an error to report. */
export class PasskeyCancelled extends Error {
  constructor() {
    super("Passkey creation was cancelled.");
  }
}

/**
 * Run the ceremony: ask for a new passkey where the person chose
 * ({@link placePasskey}) and return the value for the flow's register field.
 * Every pod-admin creation goes through here, so `placement` is required.
 * Throws {@link PasskeyCancelled} when the person dismisses the prompt
 * (WebAuthn `NotAllowedError`), an Error otherwise.
 */
export async function createPasskey(
  createData: string,
  placement: PasskeyPlacement,
  person?: { name: string; displayName?: string }
): Promise<string> {
  if (!isPasskeySupported()) {
    throw new Error("This browser can't create a passkey.");
  }
  const publicKey = placePasskey(
    passkeyCreationOptions(createData, person),
    placement
  );
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({ publicKey });
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      throw new PasskeyCancelled();
    }
    throw err instanceof Error
      ? err
      : new Error("This device could not create a passkey.");
  }
  if (!credential) throw new PasskeyCancelled();
  return encodeAttestation(credential as PublicKeyCredential);
}

// ─── Proof of presence: the ASSERTION ceremony (W3) ──────────────────────
//
// A sensitive approval asks for a fresh passkey signature over a pod
// challenge that names ONE proposal (`presence.challenge`, contract: pod
// document "W3 pod-first: proof of presence on the pod"). The pod verifies
// it against the passkeys Kratos holds, so this is the plain WebAuthn `get`
// with user verification REQUIRED: Touch ID, Windows Hello or the security
// key's PIN, never a bare tap.

/** `presence.challenge`'s `passkey` block: what `navigator.credentials.get` needs. */
export type PresencePasskeyRequest = NonNullable<
  inferRouterOutputs<AppRouter>["presence"]["challenge"]["passkey"]
>;

/** How long the browser's prompt waits: the challenge's own lifetime. */
export const PRESENCE_PROMPT_TIMEOUT_MS = PRESENCE_CHALLENGE_TTL_SECONDS * 1000;

/** This browser can sign with a passkey (`navigator.credentials.get`). */
export function isPasskeyAssertionSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.get === "function"
  );
}

/** The pod's challenge → WebAuthn request options, user verification required. */
export function passkeyRequestOptions(
  request: PresencePasskeyRequest
): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64UrlToBuffer(request.challenge),
    rpId: request.rpId,
    allowCredentials: request.allowCredentials.map((c) => ({
      type: "public-key",
      id: base64UrlToBuffer(c.id),
    })),
    // Always "required", whatever the pod sent: the pod refuses an assertion
    // without the UV flag, so asking for less only fails later.
    userVerification: "required",
    timeout: PRESENCE_PROMPT_TIMEOUT_MS,
  };
}

/** A signed assertion → the `credential` of a `{kind: "passkey"}` proof. */
export function encodeAssertion(
  credential: PublicKeyCredential
): PasskeyAssertionJSON {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: "public-key",
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle
        ? bufferToBase64Url(response.userHandle)
        : null,
    },
    clientExtensionResults:
      typeof credential.getClientExtensionResults === "function"
        ? (credential.getClientExtensionResults() as Record<string, unknown>)
        : {},
  };
}

/**
 * Run the assertion: the browser asks for Touch ID, Windows Hello or the
 * security key, and the passkey signs the pod's challenge. Throws
 * {@link PasskeyCancelled} when the person closes the prompt, or when no
 * passkey of this pod is on this device (WebAuthn reports both as
 * `NotAllowedError`); an Error otherwise.
 */
export async function getPasskeyAssertion(
  request: PresencePasskeyRequest
): Promise<PasskeyAssertionJSON> {
  if (!isPasskeyAssertionSupported()) {
    throw new Error("This browser can't use a passkey.");
  }
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: passkeyRequestOptions(request),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      throw new PasskeyCancelled();
    }
    throw err instanceof Error
      ? err
      : new Error("This device could not use the passkey.");
  }
  if (!credential) throw new PasskeyCancelled();
  return encodeAssertion(credential as PublicKeyCredential);
}
