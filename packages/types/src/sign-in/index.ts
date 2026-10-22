/**
 * A person signed in to a Synap app (Synap Desktop, Synap Relay) through
 * their pod's own sign-in page: the rules and words the pod's pages and the
 * apps share, so the consent screen, the sign-in page and every "Signed-in
 * apps" list say the same thing. Pure: loaded by Next (pod-admin), React
 * Native (Relay), Electron and Node alike. Dates arrive as ISO strings over
 * JSON or as Date objects; formatting them stays with each surface.
 */
import {
  FIRST_PARTY_CLIENT_NAMES,
  resolveFirstPartyClientName,
} from "../vocabulary/index.js";

/** An email's longest length (RFC 5321): the longest hint kept. */
export const LOGIN_HINT_MAX_LENGTH = 254;

/**
 * An OAuth `login_hint` (OIDC Core §3.1.2.1) as a page may use it: who is
 * signing in, to pre-fill the sign-in form. A HINT, never trusted — the
 * person can change it and the password is checked against what is typed.
 * Trimmed, at most an email's length, no control characters; anything else
 * is dropped, because a hint the page cannot use is no hint.
 */
export function cleanLoginHint(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hint = raw.trim();
  if (!hint || hint.length > LOGIN_HINT_MAX_LENGTH) return null;
  for (let i = 0; i < hint.length; i++) {
    const code = hint.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return hint;
}

/** Where a Synap app runs, for its mark and its words. */
export type SignedInAppKind = "computer" | "phone";

const COMPUTER_APPS = new Set(["synap-desktop"]);

/** Synap Desktop runs on a computer; the other Synap apps on a phone. */
export function signedInAppKind(clientId: string): SignedInAppKind {
  return COMPUTER_APPS.has(clientId) ? "computer" : "phone";
}

/** `devices.list` as it arrives. */
export interface SignedInDeviceRow {
  id: string;
  clientId: string;
  /** What the app said about itself at sign-in ("Ada's MacBook"), or null. */
  label: string | null;
  createdAt: string | Date;
  lastUsedAt: string | Date | null;
  /** The device making this request (only ever true inside an app). */
  current: boolean;
}

/** One row of a "Signed-in apps" list. */
export interface SignedInDeviceView {
  id: string;
  /** The app's name, from the vocabulary ("Synap Desktop"). */
  appName: string;
  kind: SignedInAppKind;
  /** The row's title: the device's own label, else the app's name. */
  title: string;
  isThisDevice: boolean;
  /** The last refresh, else the sign-in. */
  lastActiveAt: Date;
}

export function signedInDeviceView(row: SignedInDeviceRow): SignedInDeviceView {
  const appName = resolveFirstPartyClientName(row.clientId);
  const label = row.label?.trim();
  return {
    id: row.id,
    appName,
    kind: signedInAppKind(row.clientId),
    title: label || appName,
    isThisDevice: row.current,
    lastActiveAt: new Date(row.lastUsedAt ?? row.createdAt),
  };
}

/** This device first, then the most recently active. */
export function compareSignedInDevices(
  a: SignedInDeviceView,
  b: SignedInDeviceView
): number {
  if (a.isThisDevice !== b.isThisDevice) return a.isThisDevice ? -1 : 1;
  return b.lastActiveAt.getTime() - a.lastActiveAt.getTime();
}

/** The words of a "Signed-in apps" list, on every surface. */
export const SIGNED_IN_APPS_COPY = {
  title: "Signed-in apps",
  thisDevice: "This device",
  empty: "No Synap app is signed in.",
  emptyWhy:
    "Sign in from Synap Desktop or Synap Relay and the app shows up here, so you can sign it out.",
  signOutAction: "Sign out",
  signOutTitle: (title: string) => `Sign out ${title}?`,
  signOutConsequence: (appName: string) =>
    `${appName} stops working on that device at once. Signing in again needs your password.`,
  signedOut: (title: string) => `${title} is signed out.`,
} as const;

/**
 * Why the person is asked to sign in again, when an app asked for it (a
 * Synap app's step-up before it changes a key, a connection or a secret).
 * Only a Synap app is named: another client's id is not a name.
 */
export function confirmItsYouReason(
  clientId: string | null | undefined
): string {
  const name = clientId ? FIRST_PARTY_CLIENT_NAMES[clientId] : undefined;
  return name
    ? `${name} asks you to confirm it's you.`
    : "An app asks you to confirm it's you.";
}
