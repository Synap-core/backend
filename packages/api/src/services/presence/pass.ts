/**
 * The pass a sensitive SERVICE requires (review of 6 Nov 2026, W3).
 *
 * A sensitive act has several doors: the tRPC procedure, its Hub REST or Hub
 * tRPC twin, tomorrow an MCP tool. Gating each DOOR leaves the next one open:
 * the Hub twins of `apps.issueKey`, `apps.setWriteMode`, `agentUsers.setPosture`
 * … took no proof at all, because `SENSITIVE_ACTIONS` is keyed by tRPC path
 * and only the tRPC step-up middleware read it. So the SERVICE behind the act
 * (`issueKey`, `setAppRedirectUris`, `setAppWriteMode`, `createNamedAgent`)
 * asks for a pass that only the gate mints (`passPresenceForAction`,
 * `gate.ts`), after it checked the proof bound to that call for that person,
 * or recorded the missing one in `report` mode. A door that skips the gate
 * has no pass to hand, and the act is refused.
 *
 * This module has no imports beyond the types, so a service can depend on it
 * without pulling the gate's graph (proof checks, Kratos). The tripwire
 * `presence-gate-every-door` pins `mintPresencePass` to `gate.ts`.
 */
import { TRPCError } from "@trpc/server";
import {
  PRESENCE_REQUIRED,
  type SensitiveActionPath,
} from "@synap-core/types/presence";

/** What a sensitive service is handed: proof that the gate ran for this act and person. */
export interface PresencePass {
  readonly action: SensitiveActionPath;
  readonly userId: string;
  /** A proof was checked (false: `report` mode let it through, and recorded it). */
  readonly proved: boolean;
}

/** The passes the gate minted. Only `mintPresencePass` adds to it. */
const MINTED = new WeakSet<object>();

/** ONLY the gate calls this (`gate.ts`, pinned by the tripwire). */
export function mintPresencePass(
  action: SensitiveActionPath,
  userId: string,
  proved: boolean
): PresencePass {
  const pass: PresencePass = Object.freeze({ action, userId, proved });
  MINTED.add(pass);
  return pass;
}

/** The refusal of a sensitive act reached by a door that never asked the gate. */
export const PRESENCE_PASS_MISSING_MESSAGE =
  "This needs the person to confirm it is them, and this way in does not ask: do it in pod admin.";

/**
 * Every sensitive service calls this first: the pass must come from the gate,
 * for one of the service's acts, for the person the service acts for.
 */
export function assertPresencePass(
  pass: PresencePass | null | undefined,
  args: { actions: readonly SensitiveActionPath[]; userId: string }
): asserts pass is PresencePass {
  if (
    !pass ||
    !MINTED.has(pass) ||
    !args.actions.includes(pass.action) ||
    pass.userId !== args.userId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: PRESENCE_PASS_MISSING_MESSAGE,
      cause: { reasonCode: PRESENCE_REQUIRED, proposalId: args.actions[0] },
    });
  }
}
