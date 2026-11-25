"use client";

/**
 * Create a passkey in this browser and register it through Kratos' settings
 * flow (`passkey` method): the ONE add-passkey step, shared by the passkeys
 * card and the "Add this device" panel. Kratos' settings guard decides
 * whether the change may go: with no factor yet, freely; else it redeems a
 * grant (`presence.authorizePasskeyChange`) or an approved device link of
 * THIS session. Neither is asked for here: the caller holds it first.
 *
 * Throws what `createPasskey` throws (`PasskeyCancelled`,
 * `PasskeyCreateFailed`); resolves with Kratos' classified answer.
 */
import {
  nodeValue,
  submitSelfServiceFlow,
  type KratosFlow,
  type SubmitFlowResult,
} from "../../../lib/kratos-flow";
import { createPasskey, type PasskeyPlacement } from "../../../lib/passkey";

/** The flow offers no passkey creation (passkeys off on this pod). */
export class PasskeyNotOffered extends Error {
  constructor() {
    super("This pod's sign-in service offers no passkey creation here.");
    this.name = "PasskeyNotOffered";
  }
}

export async function registerPasskey(
  flow: KratosFlow,
  placement: PasskeyPlacement,
  /** The passkey exists in the browser; Kratos is told next. */
  onCreated?: () => void
): Promise<SubmitFlowResult> {
  const createData = nodeValue(flow, "passkey_create_data");
  if (!createData) throw new PasskeyNotOffered();
  const register = await createPasskey(createData, placement);
  onCreated?.();
  return submitSelfServiceFlow(flow, {
    method: "passkey",
    csrf_token: nodeValue(flow, "csrf_token") ?? "",
    passkey_settings_register: register,
  });
}
