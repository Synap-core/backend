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

/** How long the asking agent may read a secret handed over for its ask. */
export const PROVIDE_SECRET_GRANT_MINUTES = 60;

/**
 * Why a handed-over secret came with no read for the agent.
 *   `agent_unknown`  — the pod cannot tell which agent asked.
 *   `not_grantable`  — a legacy client-encrypted secret the pod cannot read.
 *   `key_not_allowed` — the key that answered may not grant vault access.
 */
export type ProvideSecretGrantRefusal =
  "agent_unknown" | "not_grantable" | "key_not_allowed";

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

/** A connection the person could hand over, as `provideOptions` lists it. */
export interface ProvideConnectionRowLite {
  id: string;
  accountHint: string | null;
}

/**
 * "Use an existing connection" is one tap with one account; with several the
 * person confirms WHICH account first (owner decision P4).
 */
export function provideNeedsAccountConfirm(
  rows: readonly ProvideConnectionRowLite[]
): boolean {
  return rows.length > 1;
}
