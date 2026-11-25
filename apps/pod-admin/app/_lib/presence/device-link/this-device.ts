/**
 * Does THIS browser hold a passkey for this pod? The pod cannot say (a
 * passkey lives on the device, and Kratos lists every passkey of the person,
 * wherever it lives), so the browser remembers it: the marker is set when
 * this browser CREATES a passkey (the passkeys card, the "Add this device"
 * panel) or PROVES with one (the presence dialog, method passkey).
 *
 * It feeds the lowest nudge, `this-device` (`securityNudge`): an offer to set
 * up a passkey here, never a warning. A browser whose storage cannot be read
 * (a private window, blocked site data) has no marker: the offer shows, and
 * skipping it is remembered the same way, or not at all.
 *
 * Per pod: the key names the pod's origin, so one browser that signs in to
 * two pods keeps two answers.
 */

/** The storage key's prefix; the pod's origin follows it. */
export const THIS_DEVICE_KEY_PREFIX = "synap.presence.thisDevice.v1:";

/** The marker's value. */
export const THIS_DEVICE_PASSKEY = "passkey";

export function thisDeviceKey(podOrigin: string): string {
  return `${THIS_DEVICE_KEY_PREFIX}${podOrigin}`;
}

type Readable = Pick<Storage, "getItem">;
type Writable = Pick<Storage, "setItem">;

/** The marker, read; storage that is missing or throws reads as no marker. */
export function readThisDevice(
  storage: Readable | null | undefined,
  podOrigin: string
): boolean {
  if (!storage || !podOrigin) return false;
  try {
    return storage.getItem(thisDeviceKey(podOrigin)) === THIS_DEVICE_PASSKEY;
  } catch {
    return false;
  }
}

/** Set the marker; storage that is missing or throws keeps nothing, silently. */
export function writeThisDevice(
  storage: Writable | null | undefined,
  podOrigin: string
): boolean {
  if (!storage || !podOrigin) return false;
  try {
    storage.setItem(thisDeviceKey(podOrigin), THIS_DEVICE_PASSKEY);
    return true;
  } catch {
    return false;
  }
}
