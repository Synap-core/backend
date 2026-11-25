/**
 * What the proof-of-presence dialog shows, derived in one place
 * (`presence-provider.tsx` draws it). Pure, so each state is tested:
 *  - a failed challenge read is its own state, with Try again; the pod's own
 *    message is a muted detail, never the headline;
 *  - no passkey on this pod: "Add a passkey" is the primary action; once it
 *    opened its tab, the dialog says to come back and press Try again, which
 *    becomes the primary action;
 *  - a browser that cannot use a passkey: no primary action, no Try again;
 *  - Relay is offered only on a device the person enrolled, and only for
 *    what Relay can approve (never this page's own change, `inBrowserOnly`);
 *  - in a batch, the way out is "Stop here";
 *  - once the first prompt failed and the person's passkeys live in more
 *    than one place (a password-manager extension took over WebAuthn), the
 *    other prompt is offered beside Confirm: "Use this device’s passkey" or
 *    "Use your password manager" (`planAssertion`, `lib/passkey.ts`);
 *  - a prompt that ended with an error keeps the browser's own words behind
 *    "Copy details", never in the sentence.
 *  - a person with a 2FA app or recovery codes may TYPE a code instead (the
 *    recovery ladder, founder, 6 Nov 2026): "Use a code instead" is offered
 *    in every ready state, and in code mode the code is the primary action
 *    and no passkey notice shows. With no passkey but a code, the dialog
 *    opens in code mode.
 *  - "Add this device" (founder decision of 9 Nov 2026): when this browser
 *    cannot prove (no passkey of this pod reaches it: the prompt failed or
 *    was closed, or the person's ways in are elsewhere), "Set up this
 *    device" is offered (`setUp`). It switches the dialog's body to the
 *    device-link panel (`panel`): a device the person already uses approves
 *    this one, which then creates its own passkey; the dialog then reads a
 *    new challenge and Confirm runs again. Never offered while approving a
 *    device link itself or changing a passkey, nor where this browser cannot
 *    create a passkey (`setUpAllowed`, decided by the provider).
 */

import type { PasskeyRoute } from "../../../lib/passkey";

/** The words the view names, keys of `copy.ts`. */
export type PresenceWord =
  | "checking"
  | "waiting"
  | "readFailed"
  | "confirm"
  | "tryAgain"
  | "addPasskey"
  | "comeBack"
  | "notNow"
  | "stopHere"
  | "confirmCode";

export interface PresenceDialogInput {
  phase:
    | { kind: "reading" }
    | { kind: "read-failed"; detail: string | null }
    | {
        kind: "ready" | "signing";
        passkey: boolean;
        deviceKeys: ReadonlyArray<{ label: string }>;
        note?: string | null;
        /** The other prompt to offer after the first one failed, or null. */
        fallback?: PasskeyRoute | null;
        /** The failed prompt's error (name and message), for "Copy details". */
        copyDetail?: string | null;
        /** The passkey prompt ran and did not sign (closed, or no passkey here). */
        promptFailed?: boolean;
      };
  /** This browser can run `navigator.credentials.get`. */
  passkeySupported: boolean;
  progress?: { index: number; total: number };
  /**
   * The proof can only come from THIS browser: a change the page makes
   * itself (a sensitive action, a passkey change, the mode switched off),
   * which Relay cannot sign. Relay is then never offered.
   */
  inBrowserOnly?: boolean;
  /** "Add a passkey" opened its tab: the person adds it there, then comes back. */
  addPasskeyOpened?: boolean;
  /** The person may type a code here (a 2FA app, or unused recovery codes). */
  typed?: boolean;
  /** The person chose "Use a code instead" (or holds no passkey but a code). */
  codeMode?: boolean;
  /**
   * "Set up this device" may be offered: the subject is not a device link's
   * own approval, and this browser can create a passkey.
   */
  setUpAllowed?: boolean;
  /** The person pressed "Set up this device": the panel is the body. */
  setUpOpen?: boolean;
}

export interface PresenceDialogView {
  /** The status line's word, or the note (why it asks again, a closed prompt). */
  status: { word: PresenceWord } | { note: string } | null;
  tone: "muted" | "warning" | "danger";
  /** The pod's own message under a failed read, small and muted. */
  detail: string | null;
  /** A failed prompt's error, behind "Copy details"; null hides the control. */
  copyDetail: string | null;
  notice: "noPasskey" | "unsupported" | null;
  primary: "confirm" | "tryAgain" | "addPasskey" | "confirmCode" | null;
  /** Show the code field (a 2FA app code or a recovery code). */
  codeField: boolean;
  /** Offer "Use a code instead" (a link that switches to the code field). */
  useCode: boolean;
  /**
   * Beside the primary: read again once a passkey is added, or open its tab
   * again; or, after a failed prompt, the other one (this device's own
   * prompt, or the password manager's).
   */
  secondary: "tryAgain" | "addPasskey" | "useDevice" | "useManager" | null;
  decline: "notNow" | "stopHere";
  /** The enrolled Relay device to offer, or null: never promise Relay blind. */
  relayDevice: string | null;
  busy: boolean;
  /** Offer "Set up this device" (a link that opens the device-link panel). */
  setUp: boolean;
  /** The body is the device-link panel: no status, notice or primary. */
  panel: boolean;
}

export function presenceDialogView(
  input: PresenceDialogInput
): PresenceDialogView {
  const { phase } = input;
  const decline: PresenceWord =
    input.progress && input.progress.total > 1 ? "stopHere" : "notNow";
  const base = {
    detail: null,
    copyDetail: null,
    notice: null,
    secondary: null,
    decline,
    relayDevice: null,
    codeField: false,
    useCode: false,
    setUp: false,
    panel: false,
  } as const;
  if (phase.kind === "reading") {
    return {
      ...base,
      status: { word: "checking" },
      tone: "muted",
      primary: "confirm",
      busy: true,
    };
  }
  if (phase.kind === "read-failed") {
    return {
      ...base,
      status: { word: "readFailed" },
      tone: "danger",
      detail: phase.detail?.trim() || null,
      primary: "tryAgain",
      busy: false,
    };
  }
  if (input.setUpOpen && input.setUpAllowed) {
    return {
      ...base,
      status: null,
      tone: "muted",
      primary: null,
      panel: true,
      busy: false,
    };
  }
  const relayDevice =
    !input.inBrowserOnly && phase.deviceKeys.length > 0
      ? phase.deviceKeys[0]!.label.trim() || ""
      : null;
  // This browser cannot prove here: no passkey of this pod, or its prompt
  // did not sign. A device the person already uses can bring it in.
  const setUp =
    Boolean(input.setUpAllowed) &&
    phase.kind === "ready" &&
    (!phase.passkey || Boolean(phase.promptFailed));
  if (input.typed && (input.codeMode || !phase.passkey)) {
    const signing = phase.kind === "signing";
    return {
      ...base,
      status: signing
        ? { word: "checking" }
        : phase.note
          ? { note: phase.note }
          : null,
      tone: signing ? "muted" : "warning",
      primary: "confirmCode",
      codeField: true,
      relayDevice,
      busy: signing,
      setUp,
    };
  }
  const useCode = Boolean(input.typed);
  if (!phase.passkey && input.addPasskeyOpened) {
    return {
      ...base,
      status: { word: "comeBack" },
      tone: "muted",
      notice: "noPasskey",
      primary: "tryAgain",
      secondary: "addPasskey",
      relayDevice,
      useCode,
      busy: false,
      setUp,
    };
  }
  if (!phase.passkey) {
    return {
      ...base,
      status: phase.note ? { note: phase.note } : null,
      tone: "warning",
      notice: "noPasskey",
      primary: "addPasskey",
      secondary: "tryAgain",
      relayDevice,
      useCode,
      busy: false,
      setUp,
    };
  }
  if (!input.passkeySupported) {
    return {
      ...base,
      status: null,
      tone: "muted",
      notice: "unsupported",
      primary: null,
      relayDevice,
      useCode,
      busy: false,
    };
  }
  const signing = phase.kind === "signing";
  return {
    ...base,
    status: signing
      ? { word: "waiting" }
      : phase.note
        ? { note: phase.note }
        : null,
    tone: signing ? "muted" : "warning",
    primary: "confirm",
    secondary: signing
      ? null
      : phase.fallback === "native"
        ? "useDevice"
        : phase.fallback === "page"
          ? "useManager"
          : null,
    copyDetail: signing ? null : phase.copyDetail?.trim() || null,
    relayDevice,
    useCode: useCode && !signing,
    busy: signing,
    setUp,
  };
}

/** The words of a passkey prompt that did not sign, keys of `copy.ts`. */
export type FailedPromptWord =
  | "cancelled"
  | "ceremonyFailed"
  | "fallback.device"
  | "fallback.device.unnamed"
  | "device.unreachable.mac"
  | "device.unreachable"
  | "device.closed.mac"
  | "device.closed";

/**
 * Why the prompt did not sign, in words:
 *  - the browser's own prompt (`native`) failed with an error: it cannot
 *    reach the passkey on this device (a second extension or the system
 *    answered instead); on a Mac, Safari can. Relay is offered by the
 *    dialog's own Relay line, only where the person enrolled a device;
 *  - it ended as a closed prompt: nothing was confirmed, and the same, IF
 *    the prompt did not offer the passkey (a person closing it and a second
 *    extension answering "no passkey" throw the same error);
 *  - any other error: "ended with an error", its words behind Copy details;
 *  - the page's prompt found nothing (or was closed) while this device's own
 *    prompt is on offer: nothing was confirmed, and where the passkey may be;
 *  - else: nothing was confirmed (closed, or no passkey here).
 */
export function failedPromptWord(input: {
  /** The prompt threw NotAllowedError (closed, or no passkey where it looked). */
  cancelled: boolean;
  /** The prompt that failed. */
  route: PasskeyRoute;
  /** The other prompt the dialog offers now, or null. */
  offer: PasskeyRoute | null;
  /** The name of the store holding a device passkey ("iCloud Keychain"), or null. */
  deviceName: string | null;
  onMac: boolean;
}): { word: FailedPromptWord; name?: string } {
  if (input.route === "native") {
    if (input.cancelled) {
      return { word: input.onMac ? "device.closed.mac" : "device.closed" };
    }
    return {
      word: input.onMac ? "device.unreachable.mac" : "device.unreachable",
    };
  }
  if (!input.cancelled) return { word: "ceremonyFailed" };
  if (input.offer === "native") {
    return input.deviceName
      ? { word: "fallback.device", name: input.deviceName }
      : { word: "fallback.device.unnamed" };
  }
  return { word: "cancelled" };
}
