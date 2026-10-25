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
 * Run the ceremony: ask the device for a new passkey and return the value for
 * the flow's register field. Throws {@link PasskeyCancelled} when the person
 * dismisses the prompt (WebAuthn `NotAllowedError`), an Error otherwise.
 */
export async function createPasskey(
  createData: string,
  person?: { name: string; displayName?: string }
): Promise<string> {
  if (!isPasskeySupported()) {
    throw new Error("This browser can't create a passkey.");
  }
  const publicKey = passkeyCreationOptions(createData, person);
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
