/**
 * WebAuthn / passkey ceremony helpers for pod-admin — framework-agnostic.
 *
 * pod-admin (`pod-admin.<root>`) is a registrable-suffix of the Kratos RP id
 * (`<root>`), so the WebAuthn ceremony runs here with a matching origin. (The
 * Electron renderer cannot — its origin is file:///localhost — so native
 * passkey login is delegated to this pod-origin page.)
 *
 * Native implementation of Ory Kratos's passkey login + settings (enrollment)
 * ceremonies, matched 1:1 to the live Kratos v1.3.1 `webauthn.js` contract:
 *   LOGIN: `passkey_challenge` node value → encoded assertion → `passkey_login`
 *   REGISTER: settings `passkey_create_data` → encoded attestation →
 *             `passkey_settings_register`
 * base64url = base64 with +→-, /→_, trailing = stripped.
 * (Mirror of synap-app/packages/core/auth-ui/src/webauthn.ts — duplicated
 * because pod-admin is a separate repo from synap-app; keep the two in sync.)
 */

export function base64UrlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

export function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined"
  );
}

export async function isConditionalUiSupported(): Promise<boolean> {
  if (!isPasskeySupported()) return false;
  const PKC = window.PublicKeyCredential as typeof PublicKeyCredential & {
    isConditionalMediationAvailable?: () => Promise<boolean>;
  };
  if (typeof PKC.isConditionalMediationAvailable !== "function") return false;
  try {
    return await PKC.isConditionalMediationAvailable();
  } catch {
    return false;
  }
}

interface KratosGetOptions {
  publicKey: {
    challenge: string;
    timeout?: number;
    rpId?: string;
    userVerification?: UserVerificationRequirement;
    allowCredentials?: Array<{
      id: string;
      type: PublicKeyCredentialType;
      transports?: AuthenticatorTransport[];
    }>;
  };
}

interface KratosCreateOptions {
  publicKey: {
    challenge: string;
    rp: PublicKeyCredentialRpEntity;
    user: { id: string; name?: string; displayName?: string };
    pubKeyCredParams: PublicKeyCredentialParameters[];
    timeout?: number;
    attestation?: AttestationConveyancePreference;
    authenticatorSelection?: AuthenticatorSelectionCriteria;
    excludeCredentials?: Array<{
      id: string;
      type: PublicKeyCredentialType;
      transports?: AuthenticatorTransport[];
    }>;
  };
}

/**
 * Run the passkey LOGIN ceremony.
 * @param challengeNodeValue raw value of the `passkey_challenge` node.
 * @param mediation "conditional" for username-field autofill, else explicit.
 * @returns JSON string to post as `passkey_login`.
 */
export async function runPasskeyLogin(
  challengeNodeValue: string,
  mediation?: CredentialMediationRequirement,
  signal?: AbortSignal
): Promise<string> {
  if (!isPasskeySupported()) throw new Error("This browser does not support passkeys.");
  let parsed: KratosGetOptions;
  try {
    parsed = JSON.parse(challengeNodeValue) as KratosGetOptions;
  } catch {
    throw new Error("Could not parse the passkey challenge from the server.");
  }
  if (!parsed?.publicKey?.challenge) {
    throw new Error("The passkey challenge from the server was empty.");
  }
  const pk = parsed.publicKey;
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: base64UrlToBuffer(pk.challenge),
    timeout: pk.timeout,
    rpId: pk.rpId,
    userVerification: pk.userVerification,
    allowCredentials: (pk.allowCredentials ?? []).map((c) => ({
      id: base64UrlToBuffer(c.id),
      type: c.type,
      transports: c.transports,
    })),
  };
  const credential = (await navigator.credentials.get({
    publicKey,
    mediation,
    signal,
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was provided.");
  const response = credential.response as AuthenticatorAssertionResponse;
  return JSON.stringify({
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : "",
    },
  });
}

/**
 * Run the passkey REGISTER (settings enrollment) ceremony.
 * @param challengeNodeValue raw value of the settings `passkey_create_data` node.
 * @returns JSON string to post as `passkey_settings_register`.
 */
export async function runPasskeyRegister(challengeNodeValue: string): Promise<string> {
  if (!isPasskeySupported()) throw new Error("This browser does not support passkeys.");
  let parsed: KratosCreateOptions;
  try {
    parsed = JSON.parse(challengeNodeValue) as KratosCreateOptions;
  } catch {
    throw new Error("Could not parse the passkey enrollment data from the server.");
  }
  if (!parsed?.publicKey?.challenge || !parsed.publicKey.user?.id) {
    throw new Error("The passkey enrollment data from the server was incomplete.");
  }
  const pk = parsed.publicKey;
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: base64UrlToBuffer(pk.challenge),
    rp: pk.rp,
    user: {
      id: base64UrlToBuffer(pk.user.id),
      name: pk.user.name ?? "",
      displayName: pk.user.displayName ?? pk.user.name ?? "",
    },
    pubKeyCredParams: pk.pubKeyCredParams,
    timeout: pk.timeout,
    attestation: pk.attestation,
    authenticatorSelection: pk.authenticatorSelection,
    excludeCredentials: (pk.excludeCredentials ?? []).map((c) => ({
      id: base64UrlToBuffer(c.id),
      type: c.type,
      transports: c.transports,
    })),
  };
  const credential = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
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

// ── Passkey "have we got one here?" hint ─────────────────────────────────────
// WebAuthn cannot be queried for "does this user have a passkey" before auth
// (privacy). We remember, per pod origin, that a passkey was used/enrolled on
// this device so the next visit can DEFAULT to passkey. Authoritative absence
// is confirmed post-login via the settings flow (the post-password nudge).

const PASSKEY_HINT_KEY = "synap.passkey.hint";

export function hasPasskeyHint(): boolean {
  try {
    return typeof window !== "undefined" &&
      window.localStorage.getItem(PASSKEY_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPasskeyHint(present: boolean): void {
  try {
    if (present) window.localStorage.setItem(PASSKEY_HINT_KEY, "1");
    else window.localStorage.removeItem(PASSKEY_HINT_KEY);
  } catch {
    /* storage unavailable — non-fatal */
  }
}
