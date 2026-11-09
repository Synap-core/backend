/**
 * The person's passkeys, as Kratos' settings flow lists them (W5, founder
 * 6 Nov 2026: "handle (add/remove) passkeys"), and whether one may be
 * removed. Pure, so each state is tested.
 *
 * Kratos v1.3.1 (`selfservice/strategy/passkey/passkey_settings.go`) puts
 * one `passkey_remove` submit node per passkey in the `passkey` group: its
 * `value` is the credential id (hex), its label's context carries
 * `display_name` and `added_at`, and it is `disabled` when the passkey is the
 * account's only way to sign in (Kratos refuses that removal itself). Kratos
 * has no rename for a passkey, so the list offers none.
 */
import type { KratosFlow } from "../../../lib/kratos-flow";

export interface PasskeyRow {
  /** The credential id Kratos removes by (`passkey_remove`'s value). */
  id: string;
  /** Kratos' display name (the account's identifier), when it gives one. */
  name: string | null;
  /** When it was added (ISO), when Kratos says. */
  addedAt: string | null;
  /** Kratos keeps it: the account's only way to sign in. */
  onlySignIn: boolean;
}

export function passkeyRows(flow: KratosFlow): PasskeyRow[] {
  return flow.ui.nodes
    .filter(
      (n) => n.group === "passkey" && n.attributes?.name === "passkey_remove"
    )
    .map((n) => {
      const context = n.meta?.label?.context;
      const name = context?.display_name;
      const addedAt = context?.added_at;
      return {
        id: String(n.attributes?.value ?? ""),
        name: typeof name === "string" && name.trim() ? name : null,
        addedAt:
          typeof addedAt === "string" && !Number.isNaN(Date.parse(addedAt))
            ? addedAt
            : null,
        onlySignIn: n.attributes?.disabled === true,
      };
    })
    .filter((r) => r.id !== "");
}

/**
 * Why this passkey cannot be removed here, or null when it can:
 *  - `onlySignIn`: it is how the account signs in (Kratos refuses);
 *  - `lastWithProof`: it is the person's last passkey while approvals need
 *    them in person: pod admin proves only with a passkey, so they would
 *    lose the way to approve here (the pod refuses, PRESENCE_LAST_PASSKEY);
 *  - `unknownMode`: the mode could not be read, and it is their last
 *    passkey: never offered as removable on a guess.
 */
export type PasskeyRemoveBlock = "onlySignIn" | "lastWithProof" | "unknownMode";

export function passkeyRemoveBlock(input: {
  row: PasskeyRow;
  passkeys: number;
  /** The mode in force (`presence.sensitivity`); null while unread or failed. */
  mode: "enforce" | "report" | null;
}): PasskeyRemoveBlock | null {
  if (input.row.onlySignIn) return "onlySignIn";
  if (input.passkeys > 1) return null;
  if (input.mode === null) return "unknownMode";
  return input.mode === "enforce" ? "lastWithProof" : null;
}
