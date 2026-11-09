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
 *  - only a Relay device key: pod admin cannot get the grant;
 *  - a failed read of the device keys is not "none": it says so.
 */

export type PasskeyAddStep =
  "add" | "authorize" | "create" | "relayOnly" | "devicesFailed";

export function passkeyAddStep(input: {
  /** The person's passkeys, from the settings flow. */
  passkeys: number;
  /** Their Relay device keys; null while the read failed. */
  deviceKeys: number | null;
  /** A grant is held and still in time. */
  granted: boolean;
}): PasskeyAddStep {
  if (input.passkeys > 0) return input.granted ? "create" : "authorize";
  if (input.deviceKeys === null) return "devicesFailed";
  return input.deviceKeys > 0 ? "relayOnly" : "add";
}
