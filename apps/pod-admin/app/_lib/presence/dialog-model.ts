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
 *  - in a batch, the way out is "Stop here".
 */

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
  | "stopHere";

export interface PresenceDialogInput {
  phase:
    | { kind: "reading" }
    | { kind: "read-failed"; detail: string | null }
    | {
        kind: "ready" | "signing";
        passkey: boolean;
        deviceKeys: ReadonlyArray<{ label: string }>;
        note?: string | null;
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
}

export interface PresenceDialogView {
  /** The status line's word, or the note (why it asks again, a closed prompt). */
  status: { word: PresenceWord } | { note: string } | null;
  tone: "muted" | "warning" | "danger";
  /** The pod's own message under a failed read, small and muted. */
  detail: string | null;
  notice: "noPasskey" | "unsupported" | null;
  primary: "confirm" | "tryAgain" | "addPasskey" | null;
  /** Beside the primary: read again once a passkey is added, or open its tab again. */
  secondary: "tryAgain" | "addPasskey" | null;
  decline: "notNow" | "stopHere";
  /** The enrolled Relay device to offer, or null: never promise Relay blind. */
  relayDevice: string | null;
  busy: boolean;
}

export function presenceDialogView(
  input: PresenceDialogInput
): PresenceDialogView {
  const { phase } = input;
  const decline: PresenceWord =
    input.progress && input.progress.total > 1 ? "stopHere" : "notNow";
  const base = {
    detail: null,
    notice: null,
    secondary: null,
    decline,
    relayDevice: null,
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
  const relayDevice =
    !input.inBrowserOnly && phase.deviceKeys.length > 0
      ? phase.deviceKeys[0]!.label.trim() || ""
      : null;
  if (!phase.passkey && input.addPasskeyOpened) {
    return {
      ...base,
      status: { word: "comeBack" },
      tone: "muted",
      notice: "noPasskey",
      primary: "tryAgain",
      secondary: "addPasskey",
      relayDevice,
      busy: false,
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
      busy: false,
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
    relayDevice,
    busy: signing,
  };
}
