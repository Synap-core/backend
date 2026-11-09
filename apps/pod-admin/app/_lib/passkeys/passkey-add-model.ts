/**
 * What "Add a passkey" does next (W3 slice 3, founder decision 2 of 4 Nov).
 * Kratos' settings guard refuses a new passkey from a person who already
 * holds a proof factor (a passkey, a Relay device key) unless it redeems a
 * grant that factor gave (`presence.authorizePasskeyChange`, one change,
 * within 5 minutes). Pod admin can prove only with a passkey in this
 * browser, so:
 *  - no factor yet: add it straight away (the person's first factor rests on
 *    their fresh sign-in);
 *  - a passkey: confirm with it first, then create the new one (two presses:
 *    a browser runs each WebAuthn prompt from its own click);
 *  - only a Relay device key: pod admin cannot get the grant here, so this
 *    device is approved from Relay or another device ("Add this device");
 *  - a failed read of the device keys is not "none": it says so.
 *
 * "Add this device" (founder decision of 9 Nov 2026): a passkey that is not
 * in THIS browser cannot give the grant here either, so the confirm step
 * also offers "Approve from another device" (`offersDeviceLink`): a device
 * the person already uses approves this one, and Kratos' guard redeems that
 * approval for this session instead of a grant.
 */

export type PasskeyAddStep =
  "add" | "authorize" | "create" | "relayOnly" | "devicesFailed";

export function passkeyAddStep(input: {
  /** The person's passkeys, from the settings flow. */
  passkeys: number;
  /** Their Relay device keys; null while the read failed. */
  deviceKeys: number | null;
  /**
   * They hold an authenticator app or unused recovery codes, which the
   * confirm dialog takes as a typed code; null while the read failed.
   * Optional: omitted reads as "none" (callers that do not read factors).
   */
  codes?: boolean | null;
  /** A grant is held and still in time. */
  granted: boolean;
}): PasskeyAddStep {
  if (input.passkeys > 0) return input.granted ? "create" : "authorize";
  if (input.deviceKeys === null || input.codes === null) return "devicesFailed";
  // A code is a factor too: Kratos' guard refuses a plain add, but a typed
  // code gives the grant in this browser (the dialog opens on the code).
  if (input.codes) return input.granted ? "create" : "authorize";
  return input.deviceKeys > 0 ? "relayOnly" : "add";
}

/**
 * Does this step offer "Add this device"? With a factor the person holds
 * elsewhere: beside "Confirm with your passkey" (the passkey may be on
 * another device), and as the way forward when only a Relay key protects
 * the account. Never before the device keys were read, and never with no
 * factor (the passkey is added straight away).
 */
export function offersDeviceLink(step: PasskeyAddStep): boolean {
  return step === "authorize" || step === "relayOnly";
}
