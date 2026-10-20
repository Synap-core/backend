/**
 * PROVIDE — the shared rules of handing something over for a `provide` ask
 * (a secret, a connection, a file). The pod applies them at the answer door
 * and `focusSessions.provideOptions`; every surface reads them from here.
 *
 * A secret handed over for an ask also lets the agent that ASKED read it, for
 * {@link PROVIDE_SECRET_GRANT_MINUTES} minutes (`scope: 'session'`). When the
 * pod cannot name that agent, no read is granted: the hand-over still stands
 * (a `vault://` reference gives nobody the value), and the agent must ask for
 * access through the vault's own request door.
 */

import { ASK_COPY } from "./card.js";

/** How long the asking agent may read a secret handed over for its ask. */
export const PROVIDE_SECRET_GRANT_MINUTES = 60;

/**
 * Why a handed-over secret came with no read for the agent.
 *   `agent_unknown`  — the pod cannot tell which agent asked.
 *   `not_grantable`  — a legacy client-encrypted secret the pod cannot read.
 *   `key_not_allowed` — the key that answered may not grant vault access.
 *   `agent_changed`  — the agent asking now is not the one the person was
 *                      shown (`expectedGranteeId` on the answer).
 */
export type ProvideSecretGrantRefusal =
  "agent_unknown" | "not_grantable" | "key_not_allowed" | "agent_changed";

/** What a secret answer did about the asking agent's access to it. */
export type ProvideSecretGrant =
  | {
      status: "granted";
      agentUserId: string;
      agentName: string;
      /** ISO; `null` when an existing grant with no end already covered it. */
      expiresAt: string | null;
    }
  | { status: "refused"; reason: ProvideSecretGrantRefusal }
  /** The read could not be written; the hand-over stands. */
  | { status: "failed" };

/**
 * The receipt's second half — who can now read the secret. Appended to the
 * answer's summary (`summarizeAnswer`), so every surface that shows the answer
 * shows it. No em dashes in visible copy.
 */
export function provideSecretAccessLine(
  grant: ProvideSecretGrant,
  /** The moment the receipt is written (ms), to say how long is left. */
  now: number
): string {
  if (grant.status !== "granted") return "No agent can read it yet";
  if (!grant.expiresAt) return `${grant.agentName} can read it`;
  const minutes = Math.max(
    1,
    Math.round((Date.parse(grant.expiresAt) - now) / 60_000)
  );
  return `${grant.agentName} can read it for ${minutes} ${minutes === 1 ? "minute" : "minutes"}, in this session`;
}

// ─── Secret: what handing one over lets the asking agent do ─────────────────

/**
 * What `provideOptions` says a secret hand-over WILL do, before the person
 * presses: the agent it will grant a read to, or why none will be granted.
 */
export type ProvideSecretGrantOffer =
  | {
      status: "will_grant";
      /** Sent back on the answer as `expectedGranteeId`. */
      agentUserId: string;
      agentName: string;
      minutes: number;
    }
  | { status: "no_grant"; reason: ProvideSecretGrantRefusal };

/** The line shown above the submit button of a secret sheet. */
export function provideGrantNote(grant: ProvideSecretGrantOffer): string {
  return grant.status === "will_grant"
    ? ASK_COPY.provideGrantNote(grant.agentName, grant.minutes)
    : ASK_COPY.provideNoGrantNote;
}

/**
 * The agent named in {@link provideGrantNote}, to send back on the answer as
 * `expectedGranteeId`: the pod grants the read only if that agent is still
 * the one asking. null when no grant was offered.
 */
export function provideExpectedGranteeId(
  grant: ProvideSecretGrantOffer
): string | null {
  return grant.status === "will_grant" ? grant.agentUserId : null;
}

// ─── Connection: the accounts the person could hand over ────────────────────

/** Why a new connection can't be started from this pod. */
export type ProvideConnectUnavailableReason =
  "no_broker" | "not_offered" | "unreadable";

/** A connection the person could hand over, as `provideOptions` lists it. */
export interface ProvideConnectionRowLite {
  id: string;
  /** The connection's own name. */
  label: string;
  /** Which account of the service, when the pod knows one. */
  accountHint: string | null;
  podWide: boolean;
  needsReauth: boolean;
}

/** One account as a provide sheet draws it. */
export interface ProvideAccountChoice {
  /** The answer's `connectionId`. */
  id: string;
  /** The account when the pod knows it, else the connection's name. */
  label: string;
  /** The rest, in words: its name, shared, needs signing in. null when nothing. */
  detail: string | null;
  podWide: boolean;
  /** Signed out: shown, but never handed over. */
  usable: boolean;
}

/** The connection rows → the accounts a sheet lists, in the pod's order. */
export function provideAccountChoices(
  rows: readonly ProvideConnectionRowLite[]
): ProvideAccountChoice[] {
  return rows.map((r) => {
    const hint = r.accountHint?.trim() || null;
    const label = r.label.trim();
    const detail = [
      hint && label && label !== hint ? label : null,
      r.podWide ? ASK_COPY.provideAccountShared : null,
      r.needsReauth ? ASK_COPY.provideAccountNeedsSignIn : null,
    ].filter((part): part is string => part !== null);
    return {
      id: r.id,
      label: hint ?? r.label,
      detail: detail.length > 0 ? detail.join(" · ") : null,
      podWide: r.podWide,
      usable: !r.needsReauth,
    };
  });
}

/**
 * The account a sheet picks for the person: the only one, when the pod does
 * not ask them to confirm which (`confirmAccount`) and it is usable. A
 * signed-out account is never picked; several accounts are never picked.
 */
export function providePrePickedAccount(
  choices: readonly ProvideAccountChoice[],
  confirmAccount: boolean
): ProvideAccountChoice | null {
  if (confirmAccount || choices.length !== 1) return null;
  const only = choices[0]!;
  return only.usable ? only : null;
}

// ─── File: what the agent asked for ─────────────────────────────────────────

/**
 * One accepted entry, normalised: a media type (`image/png`), a family
 * (`image/*`) or an extension with its dot (`.pdf`). A bare token (`pdf`) is
 * an extension. Blank → null.
 */
function normalizeAccept(raw: string): string | null {
  const a = raw.trim().toLowerCase();
  if (!a) return null;
  return a.includes("/") || a.startsWith(".") ? a : `.${a}`;
}

/**
 * Does a picked file match the ask's `accept`? `.pdf` and `pdf` match the
 * extension, `image/png` the type, `image/*` the family. Nothing asked: any
 * file fits. Re-checked after picking, because a picker's filter is a hint
 * the person can switch off.
 */
export function provideFileAccepts(
  file: { name: string; type?: string | null },
  accept: readonly string[] | null | undefined
): boolean {
  const wanted = (accept ?? [])
    .map(normalizeAccept)
    .filter((a): a is string => a !== null);
  if (wanted.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = (file.type ?? "").toLowerCase();
  return wanted.some((a) => {
    if (a.startsWith(".")) return name.endsWith(a);
    if (a.endsWith("/*")) return type.startsWith(a.slice(0, -1));
    return type === a;
  });
}

/**
 * The file picker's `accept` attribute for the ask's list (bare tokens get
 * their dot, as the attribute requires). `undefined` = any file.
 */
export function provideAcceptAttribute(
  accept: readonly string[] | null | undefined
): string | undefined {
  const wanted = (accept ?? [])
    .map(normalizeAccept)
    .filter((a): a is string => a !== null);
  return wanted.length > 0 ? wanted.join(",") : undefined;
}
