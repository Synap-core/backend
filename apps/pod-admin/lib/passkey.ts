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
  type PasskeyHolder,
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
 * Both are requests, not guarantees of the browser. A password-manager
 * extension that replaced `navigator.credentials.create` in the page would
 * take the passkey either way, so `createPasskey` sends `device` past it to
 * the browser's own prompt ({@link passkeyRoute}).
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

// ─── Which prompt answers: past a password-manager extension ──────────────
//
// A password-manager extension (Bitwarden, 1Password, …) replaces
// `navigator.credentials.get/create` with its own functions, as OWN
// properties of the page's `navigator.credentials`. Its `get` looks only in
// its vault: with no passkey of this pod there, it says "no passkey" and
// throws NotAllowedError, which is also what a closed prompt throws, so a
// passkey in iCloud Keychain or Windows Hello is never reached. The
// browser's own methods stay on `CredentialsContainer.prototype`; calling
// them on `navigator.credentials` opens the browser's own prompt (Touch ID,
// Windows Hello, a phone, a security key) and skips the extension.
//
// Best effort, not a guarantee: a second extension may patch the prototype
// itself (Dashlane did, 6 Nov 2026), and the operating system may hand the
// browser's own prompt to a password-manager app. The `native` route then
// still reaches that one; the dialog says so in words and offers Relay.

/** Which call runs: the browser's own (`native`), or the page's, which an extension may have replaced. */
export type PasskeyRoute = "native" | "page";

type WebAuthnMethod = "get" | "create";
type WebAuthnOptions = CredentialRequestOptions | CredentialCreationOptions;
type WebAuthnCall = (options?: WebAuthnOptions) => Promise<Credential | null>;

/** The WebAuthn method on `CredentialsContainer.prototype`, or null where there is none. */
function prototypeWebAuthn(method: WebAuthnMethod): WebAuthnCall | null {
  const container = (
    globalThis as { CredentialsContainer?: { prototype: CredentialsContainer } }
  ).CredentialsContainer;
  const fn: unknown = container?.prototype?.[method];
  return typeof fn === "function" ? (fn as WebAuthnCall) : null;
}

/** A function the browser wrote (its source reads `[native code]`), not a page or extension script. */
function isNativeCode(fn: unknown): boolean {
  if (typeof fn !== "function") return false;
  try {
    return Function.prototype.toString.call(fn).includes("[native code]");
  } catch {
    return false;
  }
}

/**
 * Has something (a password-manager extension) replaced the browser's
 * WebAuthn `method` in this page: on `navigator.credentials` (another
 * function than the prototype's, or one that is not native code), or on
 * `CredentialsContainer.prototype` itself (not native code).
 */
export function webauthnTakenOver(method: WebAuthnMethod): boolean {
  const onPrototype = prototypeWebAuthn(method);
  if (!onPrototype || typeof navigator === "undefined") return false;
  const onInstance: unknown = navigator.credentials?.[method];
  return (
    onInstance !== onPrototype ||
    !isNativeCode(onInstance) ||
    !isNativeCode(onPrototype)
  );
}

/** Run WebAuthn `method` by `route`: `native` calls the prototype's method on `navigator.credentials`. */
function callWebAuthn(
  method: WebAuthnMethod,
  options: WebAuthnOptions,
  route: PasskeyRoute
): Promise<Credential | null> {
  const own = route === "native" ? prototypeWebAuthn(method) : null;
  if (own) return own.call(navigator.credentials, options);
  return method === "get"
    ? navigator.credentials.get(options as CredentialRequestOptions)
    : navigator.credentials.create(options as CredentialCreationOptions);
}

/**
 * A new passkey's route: `device` goes to the browser's own prompt when an
 * extension has taken over `create` (or it would land in the extension's
 * vault, not on this device); `manager` keeps the page's call, so the
 * extension the person chose can take it.
 */
export function passkeyRoute(
  placement: PasskeyPlacement,
  takenOver: boolean
): PasskeyRoute {
  return placement === "device" && takenOver ? "native" : "page";
}

/** Which call a presence assertion runs first, and which one the dialog offers after it fails. */
export interface AssertionPlan {
  route: PasskeyRoute;
  /** The other call, offered as a button once the first failed; null when it cannot help. */
  fallback: PasskeyRoute | null;
}

/**
 * Where to ask for the person's passkey, from where each one lives (the
 * challenge's `holder`, `@synap-core/types/presence` `passkeyHolder`) and
 * whether an extension has replaced `get` in this page:
 *  - no extension: the page's call, nothing to route around;
 *  - an extension, and no passkey held by a password manager: the browser's
 *    own prompt (the extension could only answer "no passkey"); a passkey of
 *    unknown home may still be the extension's, so it is offered after;
 *  - an extension, and a manager-held passkey: the page's call (the
 *    extension holds it); a device or unknown passkey is offered after.
 * Never an automatic second call: a NotAllowedError is also the person
 * closing the prompt.
 */
export function planAssertion(
  holders: ReadonlyArray<PasskeyHolder>,
  takenOver: boolean
): AssertionPlan {
  if (!takenOver) return { route: "page", fallback: null };
  if (!holders.includes("manager")) {
    return {
      route: "native",
      fallback: holders.includes("unknown") ? "page" : null,
    };
  }
  return {
    route: "page",
    fallback: holders.some((h) => h !== "manager") ? "native" : null,
  };
}

/** Once the prompt by `failed` did not sign: the plan's other prompt, offered as a button, or null. */
export function otherRoute(
  plan: AssertionPlan,
  failed: PasskeyRoute
): PasskeyRoute | null {
  if (!plan.fallback) return null;
  return failed === plan.route ? plan.fallback : plan.route;
}

/** A WebAuthn error's name, read from the name and never the class: an extension rethrows a plain Error named like the DOMException. */
export function webauthnErrorName(err: unknown): string | null {
  return err !== null &&
    typeof err === "object" &&
    "name" in err &&
    typeof (err as { name: unknown }).name === "string"
    ? (err as { name: string }).name
    : null;
}

/** A caught WebAuthn error as "Copy details" carries it: its name and its message. */
export function webauthnErrorDetail(err: unknown): string {
  const name = webauthnErrorName(err);
  const message =
    err instanceof Error || (err !== null && typeof err === "object")
      ? String((err as { message?: unknown }).message ?? "")
      : String(err);
  return [name, message].filter(Boolean).join(": ") || String(err);
}

/** Why a passkey could not be created; the words are the presence dialog's (`create.<reason>`). */
export type PasskeyCreateReason = "exists" | "timeout" | "failed";

/**
 * A passkey creation that failed for a reason other than the person closing
 * the prompt. Its `message` is the browser's error (name and message), for
 * "Copy details"; the sentence to show is picked by `reason`.
 */
export class PasskeyCreateFailed extends Error {
  readonly reason: PasskeyCreateReason;
  constructor(browserError: unknown) {
    super(webauthnErrorDetail(browserError));
    this.name = "PasskeyCreateFailed";
    this.reason = createFailureReason(browserError);
  }
}

/** A creation error's reason, by WebAuthn error name. */
export function createFailureReason(err: unknown): PasskeyCreateReason {
  switch (webauthnErrorName(err)) {
    case "InvalidStateError":
      return "exists";
    case "AbortError":
    case "TimeoutError":
      return "timeout";
    default:
      return "failed";
  }
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
  /** What the prompt (or an extension) said, for "Copy details"; null when it returned nothing. */
  readonly detail: string | null;
  constructor(browserError?: unknown) {
    super("Passkey creation was cancelled.");
    this.detail =
      browserError === undefined ? null : webauthnErrorDetail(browserError);
  }
}

/**
 * Run the ceremony: ask for a new passkey where the person chose
 * ({@link placePasskey}, {@link passkeyRoute}) and return the value for the
 * flow's register field. Every pod-admin creation goes through here, so
 * `placement` is required. Throws {@link PasskeyCancelled} when the person
 * dismisses the prompt (WebAuthn `NotAllowedError`), a
 * {@link PasskeyCreateFailed} naming why otherwise.
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
    credential = await callWebAuthn(
      "create",
      { publicKey },
      passkeyRoute(placement, webauthnTakenOver("create"))
    );
  } catch (err) {
    if (webauthnErrorName(err) === "NotAllowedError") {
      throw new PasskeyCancelled();
    }
    throw new PasskeyCreateFailed(err);
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
 * Run the assertion by `route` ({@link planAssertion}): the browser asks for
 * Touch ID, Windows Hello or the security key, and the passkey signs the
 * pod's challenge. Throws {@link PasskeyCancelled} when the person closes
 * the prompt, or when no passkey of this pod is where the prompt looked
 * (WebAuthn, and an extension, report both as `NotAllowedError`); an Error
 * otherwise.
 */
export async function getPasskeyAssertion(
  request: PresencePasskeyRequest,
  route: PasskeyRoute = "page"
): Promise<PasskeyAssertionJSON> {
  if (!isPasskeyAssertionSupported()) {
    throw new Error("This browser can't use a passkey.");
  }
  let credential: Credential | null;
  try {
    credential = await callWebAuthn(
      "get",
      { publicKey: passkeyRequestOptions(request) },
      route
    );
  } catch (err) {
    if (webauthnErrorName(err) === "NotAllowedError") {
      throw new PasskeyCancelled(err);
    }
    throw err instanceof Error
      ? err
      : new Error("This device could not use the passkey.");
  }
  if (!credential) throw new PasskeyCancelled();
  return encodeAssertion(credential as PublicKeyCredential);
}
