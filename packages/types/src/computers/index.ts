/**
 * The COMPUTER rule: how a computer's key and presence read, in words. Three
 * surfaces draw the same computer and must never disagree: pod admin's
 * Computers (web), the desktop's Connected › Computers, and Relay. Each used
 * to carry its own copy of these helpers, with diverging words ("seen never"
 * here, "Not seen yet" there). They all import this file; none re-derives a
 * key state, a number of days, an OS name, a "never seen" or a command.
 *
 * What lives here: key state → words, whole days left, the one "never seen"
 * wording, the OS in a person's words and the two commands a person runs ON
 * the computer. What does NOT: how a surface draws it (pill, mark, row),
 * relative-time formatting (each surface keeps its own clock words) and the
 * transport. Words for domain values come from the vocabulary door.
 *
 * Pure: loaded by Next (pod-admin), Electron (browser), React Native (relay)
 * and Node alike.
 */
import { AGENT_CONNECT_COMMAND } from "../agents/index.js";
import { resolveStatusLabel } from "../vocabulary/index.js";

/** A key's state as `machines.list` derives it (`MachineKeyState`). */
export type ComputerKeyState =
  "active" | "expiring" | "expired" | "revoked" | "none";

/** The part of a computer's key this rule reads. */
export interface ComputerKeyLike {
  state: ComputerKeyState;
  expiresAt: Date | string | null;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until `expiresAt` (at least 1 while it has not passed). */
export function daysLeft(expiresAt: Date | string, now: number): number {
  return Math.max(1, Math.ceil((new Date(expiresAt).getTime() - now) / DAY_MS));
}

/** "1 day" · "12 days". */
export const days = (n: number): string => `${n} day${n === 1 ? "" : "s"}`;

/** A computer's own key state ("none" when it holds no key). */
export function computerKeyState(c: {
  key: Pick<ComputerKeyLike, "state"> | null;
}): ComputerKeyState {
  return c.key?.state ?? "none";
}

/** A key that still lets its holder in. */
export function isLiveKey(key: Pick<ComputerKeyLike, "state"> | null): boolean {
  return key?.state === "active" || key?.state === "expiring";
}

/** The word for a computer that holds no key. */
export const NO_KEY_LABEL = "No key";

/** What a surface says about a key: its state, the words, and the expiry note. */
export interface ComputerKeyRead {
  state: ComputerKeyState;
  /** The state in words: "Active", "Expires in 3 days", "Expired", "Revoked", "No key". */
  label: string;
  /**
   * What an ACTIVE key adds to its label: "12 days left", or "No expiry". Null
   * for every other state, whose label already says it. A surface that has
   * room draws it; one that draws the bare state ignores it.
   */
  detail: string | null;
}

/**
 * A key's state in words. A live key is healthy; one about to lapse says how
 * long it has (the computer renews it on its own at `synap login`); a lapsed
 * key failed; a revoked one is simply off.
 */
export function computerKeyRead(
  key: ComputerKeyLike | null,
  now: number = Date.now()
): ComputerKeyRead {
  switch (key?.state) {
    case "active":
      return {
        state: "active",
        label: resolveStatusLabel("active"),
        detail: key.expiresAt
          ? `${days(daysLeft(key.expiresAt, now))} left`
          : "No expiry",
      };
    case "expiring":
      return {
        state: "expiring",
        label: key.expiresAt
          ? `Expires in ${days(daysLeft(key.expiresAt, now))}`
          : "Expiring",
        detail: null,
      };
    case "expired":
      return {
        state: "expired",
        label: resolveStatusLabel("expired"),
        detail: null,
      };
    case "revoked":
      return {
        state: "revoked",
        label: resolveStatusLabel("revoked"),
        detail: null,
      };
    default:
      return { state: "none", label: NO_KEY_LABEL, detail: null };
  }
}

/** The one wording for a computer (or an agent on it) that never connected. */
export const NEVER_SEEN_LABEL = "Not seen yet";

/**
 * "Seen 3 min ago" · "Not seen yet". The surface formats the time in its own
 * clock words (`relative`); the rule decides the frame and the empty case.
 */
export function seenLine(
  lastSeenAt: Date | string | null | undefined,
  relative: (at: Date | string) => string
): string {
  return lastSeenAt ? `Seen ${relative(lastSeenAt)}` : NEVER_SEEN_LABEL;
}

/** The operating system in a person's words (`process.platform` → "macOS"). */
export function platformLabel(
  platform: string | null | undefined
): string | null {
  const raw = platform?.trim();
  if (!raw) return null;
  switch (raw.toLowerCase()) {
    case "darwin":
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
    case "windows":
      return "Windows";
    default:
      return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
}

/** The one line that connects a machine as a computer. */
export const CONNECT_COMMAND = AGENT_CONNECT_COMMAND;

/**
 * The one line a person runs ON the computer to give it new keys: the device
 * flow again, which offers the same computer and replaces its key. Spelled
 * from the ONE connect command.
 */
export const RECONNECT_COMMAND = AGENT_CONNECT_COMMAND.replace(
  / init$/,
  " pods reconnect"
);
