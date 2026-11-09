/**
 * Where a passkey lives, read from its authenticator's AAGUID (the id Kratos
 * records for each passkey, `credentials.passkey.config.credentials[].
 * authenticator.aaguid`). Pod admin uses it to send the browser's WebAuthn
 * call to the prompt that can actually answer it:
 *
 *  - `device`: a store the browser's OWN prompt reaches (iCloud Keychain /
 *    Apple Passwords, Google Password Manager, Windows Hello, Chrome or Edge
 *    on this computer).
 *  - `manager`: a password manager whose BROWSER EXTENSION holds it
 *    (Bitwarden, 1Password, Dashlane, Proton Pass…). Such an extension
 *    replaces `navigator.credentials.get/create` in the page, and answers
 *    "no passkey" for any passkey it does not hold itself.
 *  - `unknown`: an AAGUID this table does not list, the all-zero AAGUID
 *    ("none" attestation) or none recorded (a security key, a phone, an
 *    unlisted store).
 *
 * Source, verified entry by entry: the community list
 * github.com/passkeydeveloper/passkey-authenticator-aaguids, `aaguid.json`
 * at commit 22c5ac90 (20 Oct 2026). `name` is that list's name. Add a row
 * from that list only; never type an AAGUID from memory.
 */

/** Where a passkey lives: this device's own store, a password manager's extension, or unknown. */
export type PasskeyHolder = "device" | "manager" | "unknown";

/** The listed authenticators, by AAGUID (lowercase, hyphenated). */
export const PASSKEY_AUTHENTICATORS: Readonly<
  Record<string, { name: string; holder: Exclude<PasskeyHolder, "unknown"> }>
> = {
  // The browser's or the operating system's own store.
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": {
    name: "Apple Passwords",
    holder: "device",
  },
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": {
    name: "iCloud Keychain (Managed)",
    holder: "device",
  },
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": {
    name: "Google Password Manager",
    holder: "device",
  },
  "adce0002-35bc-c60a-648b-0b25f1f05503": {
    name: "Chrome on Mac",
    holder: "device",
  },
  "b5397666-4885-aa6b-cebf-e52262a439a2": {
    name: "Chromium Browser",
    holder: "device",
  },
  "771b48fd-d3d4-4f74-9232-fc157ab0507a": {
    name: "Edge on Mac",
    holder: "device",
  },
  "08987058-cadc-4b81-b6e1-30de50dcbe96": {
    name: "Windows Hello",
    holder: "device",
  },
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": {
    name: "Windows Hello",
    holder: "device",
  },
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": {
    name: "Windows Hello",
    holder: "device",
  },
  "d3452668-01fd-4c12-926c-83a4204853aa": {
    name: "Microsoft Password Manager",
    holder: "device",
  },
  "53414d53-554e-4700-0000-000000000000": {
    name: "Samsung Pass",
    holder: "device",
  },
  // Password managers that hold their passkeys in a browser extension.
  "d548826e-79b4-db40-a3d8-11116f7e8349": {
    name: "Bitwarden",
    holder: "manager",
  },
  "bada5566-a7aa-401f-bd96-45619a55120d": {
    name: "1Password",
    holder: "manager",
  },
  "531126d6-e717-415c-9320-3d9aa6981239": {
    name: "Dashlane",
    holder: "manager",
  },
  "50726f74-6f6e-5061-7373-50726f746f6e": {
    name: "Proton Pass",
    holder: "manager",
  },
  "0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6": { name: "Keeper", holder: "manager" },
  "b84e4048-15dc-4dd0-8640-f4f60813c8af": {
    name: "NordPass",
    holder: "manager",
  },
  "f3809540-7f14-49c1-a8b3-8f813b225541": {
    name: "Enpass",
    holder: "manager",
  },
  "b78a0a55-6ef8-d246-a042-ba0f6d55050c": {
    name: "LastPass",
    holder: "manager",
  },
  "fdb141b2-5d84-443e-8a35-4698c205a502": {
    name: "KeePassXC",
    holder: "manager",
  },
  "b35a26b2-8f6e-4697-ab1d-d44db4da28c6": {
    name: "Zoho Vault",
    holder: "manager",
  },
  "de503f9c-21a4-4f76-b4b7-558eb55c6f89": {
    name: "Devolutions",
    holder: "manager",
  },
  "22248c4c-7a12-46e2-9a41-44291b373a4d": {
    name: "LogMeOnce",
    holder: "manager",
  },
  "a10c6dd9-465e-4226-8198-c7c44b91c555": {
    name: "Kaspersky Password Manager",
    holder: "manager",
  },
  "d9be9d39-e6a6-4c28-a581-32b044d986e4": {
    name: "Sticky Password Manager",
    holder: "manager",
  },
  "fa37f553-f9b6-4adb-ac53-8bbb57ebdf0d": {
    name: "Norton Password Manager",
    holder: "manager",
  },
  "a4a2d88e-9796-4356-9164-e2a5a8bd019c": {
    name: "Avast Password Manager",
    holder: "manager",
  },
  "e7db2bd3-f2fe-4d71-ad78-7e7aa166cfd1": {
    name: "Avira Password Manager",
    holder: "manager",
  },
  "6bb49926-160a-4306-a100-4eb39ba6ac45": {
    name: "AVG Password Manager",
    holder: "manager",
  },
};

const AAGUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 16 AAGUID bytes → its lowercase hyphenated form; null when not 16 bytes. */
export function aaguidFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length !== 16) return null;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Where the passkey with this AAGUID lives, and the name of its store:
 * `fallbackName` first (Kratos' own `display_name`, which Kratos v1.3.1 sets
 * from ITS AAGUID list, never typed by the person: "iCloud Keychain"), else
 * this table's name. An unlisted, malformed, all-zero or missing AAGUID is
 * `unknown`.
 */
export function passkeyHolder(
  aaguid: string | null | undefined,
  fallbackName?: string | null
): { holder: PasskeyHolder; name: string | null } {
  const key = aaguid?.trim().toLowerCase() ?? "";
  const listed = AAGUID.test(key) ? PASSKEY_AUTHENTICATORS[key] : undefined;
  const fallback = fallbackName?.trim() || null;
  if (!listed) return { holder: "unknown", name: fallback };
  return { holder: listed.holder, name: fallback ?? listed.name };
}
