"use client";

/**
 * The proof of presence's own settings, each with
 * the proof the pod asks for:
 *  - `presence.setMode`: switching "Approvals need you in person" ON is free;
 *    switching it OFF (`report`) needs a proof for `presence_mode:report`, in
 *    every mode, and the pod tells every pod admin;
 *  - `presence.authorizePasskeyChange`: before a passkey is added or removed
 *    through Kratos' settings flow, a person who already holds a factor
 *    proves `passkey_change:<their user id>` with it (founder decision 2 of
 *    4 Nov). The settings guard then redeems that grant, once, within 5
 *    minutes; with none it refuses the change;
 *  - `presence.setSensitivity` (W5): switching a row of "What asks for your
 *    passkey" OFF needs a proof for `presence_sensitivity:<id of the new
 *    choice>`, in every mode; back ON is free. Every pod admin is told;
 *  - `presence.totp.confirm` (the recovery ladder): a person who already
 *    holds a factor proves `totp_enroll:<pending id>` to add a 2FA app;
 *  - new recovery codes (`POST /api/account-recovery/codes`): recovery codes
 *    prove presence, so a person who holds a factor proves
 *    `recovery_codes:<their user id>`.
 *
 * Each is the person's OWN change, proved in this browser (`doing`).
 */

import {
  PRESENCE_REQUIRED,
  normalizePresenceSensitivity,
  presenceSensitivityId,
  sensitivityLoosens,
  type PresenceProof,
  type PresenceSensitivityChoice,
} from "@synap-core/types/presence";
import { useCallback, useRef } from "react";
import { trpc } from "../../../lib/trpc";
import { recoveryApi } from "../../../lib/account-recovery";
import { presenceT } from "./copy";
import {
  PresenceRefusedError,
  approveWithPresence,
  asPresenceCode,
  type PresenceSubject,
} from "./presence-model";
import { usePresence } from "./presence-provider";
import {
  usePresenceDoor,
  type DoorHandlers,
  type InputFor,
  type Resolves,
} from "./use-presence-door";

/** The subject of switching the proof OFF. */
export function modeOffSubject(): PresenceSubject {
  return {
    request: { kind: "presence_mode", id: "report" },
    doing: presenceT()("doing.modeOff"),
  };
}

/** What a passkey change does: add one, or remove one (W5). */
export type PasskeyChange = "add" | "remove";

/** The subject of one passkey change of this person. */
export function passkeyChangeSubject(
  userId: string,
  change: PasskeyChange = "add"
): PresenceSubject {
  return {
    request: { kind: "passkey_change", id: userId },
    doing: presenceT()(
      change === "remove" ? "doing.passkeyRemove" : "doing.passkeyAdd"
    ),
  };
}

/** The subject of a sensitivity change that switches rows off (W5). */
export async function sensitivityOffSubject(
  next: PresenceSensitivityChoice
): Promise<PresenceSubject> {
  return {
    request: {
      kind: "presence_sensitivity",
      id: await presenceSensitivityId(next),
    },
    doing: presenceT()("doing.sensitivityOff"),
  };
}

/** `presence.setMode`: ON as is, OFF with the proof. */
export function useSetPresenceMode(
  defaults?: DoorHandlers<
    Resolves<typeof trpc.presence.setMode.useMutation>,
    InputFor<typeof trpc.presence.setMode.useMutation>
  >
) {
  return usePresenceDoor(
    trpc.presence.setMode.useMutation(),
    (input: { mode: "enforce" | "report" }) =>
      input.mode === "report" ? modeOffSubject() : null,
    defaults
  );
}

/**
 * `presence.authorizePasskeyChange`: resolves once the pod holds the grant,
 * rejects with `PresenceDeclined` when the person does not confirm. The door
 * takes nothing but the proof, so a try with no proof is never sent: it is
 * read as the pod's PRESENCE_REQUIRED, and the dialog says what is missing
 * (no passkey this browser can use, a failed read).
 */
export function useAuthorizePasskeyChange() {
  const { prove } = usePresence();
  const mutation = trpc.presence.authorizePasskeyChange.useMutation();
  const latest = useRef({ prove, mutation });
  latest.current = { prove, mutation };
  return useCallback(async (userId: string, change: PasskeyChange = "add") => {
    const { prove, mutation } = latest.current;
    return approveWithPresence({
      subject: passkeyChangeSubject(userId, change),
      prove,
      upFront: true,
      attempt: (presence?: PresenceProof) =>
        presence
          ? mutation.mutateAsync({ presence, change })
          : Promise.reject(
              new PresenceRefusedError(
                PRESENCE_REQUIRED,
                presenceT()("passkeyChange.needsProof")
              )
            ),
    });
  }, []);
}

/**
 * `presence.setSensitivity` (W5): resolves with the pod's new choice. A
 * change that switches a row OFF is proved up front, bound to exactly the
 * new choice; one that only switches rows back ON goes as is. Rejects with
 * `PresenceDeclined` when the person does not confirm (nothing changed).
 */
export function useSetPresenceSensitivity() {
  const { prove } = usePresence();
  const mutation = trpc.presence.setSensitivity.useMutation();
  const latest = useRef({ prove, mutation });
  latest.current = { prove, mutation };
  return useCallback(
    async (
      current: PresenceSensitivityChoice,
      next: PresenceSensitivityChoice
    ) => {
      const { prove, mutation } = latest.current;
      const choice = normalizePresenceSensitivity(next);
      return approveWithPresence({
        subject: await sensitivityOffSubject(choice),
        prove,
        upFront: sensitivityLoosens(
          normalizePresenceSensitivity(current),
          choice
        ),
        attempt: (presence?: PresenceProof) => {
          const input = {
            approvalsOff: [...choice.approvalsOff],
            actionsOff: [...choice.actionsOff],
          };
          return mutation.mutateAsync(
            presence ? { ...input, presence } : input
          );
        },
      });
    },
    []
  );
}

/**
 * `presence.totp.confirm`: the 2FA app's first code, sent first with no
 * proof (a person with no factor needs none); a presence refusal asks the
 * person and sends it again with the proof.
 */
export function useConfirmTotp() {
  const { prove } = usePresence();
  const mutation = trpc.presence.totp.confirm.useMutation();
  const latest = useRef({ prove, mutation });
  latest.current = { prove, mutation };
  return useCallback(async (input: { id: string; code: string }) => {
    const { prove, mutation } = latest.current;
    return approveWithPresence({
      subject: {
        request: { kind: "totp_enroll", id: input.id },
        doing: presenceT()("doing.totpAdd"),
      },
      prove,
      attempt: (presence?: PresenceProof) =>
        mutation.mutateAsync({ ...input, ...(presence ? { presence } : {}) }),
    });
  }, []);
}

/**
 * New recovery codes, with the proof when the pod asks for it (the person
 * holds a factor). Resolves with the door's answer; a presence refusal the
 * person could not settle is thrown as a {@link PresenceRefusedError}.
 */
export function useGenerateRecoveryCodes() {
  const { prove } = usePresence();
  const latest = useRef(prove);
  latest.current = prove;
  return useCallback(async (userId: string) => {
    return approveWithPresence({
      subject: {
        request: { kind: "recovery_codes", id: userId },
        doing: presenceT()("doing.recoveryCodes"),
      },
      prove: latest.current,
      attempt: async (presence?: PresenceProof) => {
        const r = await recoveryApi.generateCodes(presence);
        const code =
          !r.ok && r.error === "presence_required"
            ? asPresenceCode(r.reasonCode)
            : null;
        if (code) throw new PresenceRefusedError(code, r.ok ? "" : r.message);
        return r;
      },
    });
  }, []);
}
