"use client";

/**
 * The console's SENSITIVE ACTIONS (founder decision
 * 1 of 4 Nov), with the proof of presence: a call that creates, rotates or
 * widens a credential or a governance rule directly, with no proposal to
 * approve. The pod's list is `SENSITIVE_ACTIONS` (`@synap-core/types/presence`),
 * keyed by the tRPC path; a listed call needs a proof bound to THIS call:
 * the challenge names `{action: {path, input}}` with the exact input the call
 * sends (the pod digests it, `presenceActionDigest`), and the call carries
 * `presence`. So a proof the person gave for "create key A" never creates
 * key B.
 *
 * Every call is proved UP FRONT, so `report` mode already runs the path
 * `enforce` requires. Pages call these hooks, never the tRPC procedure: the
 * tripwire `__tripwires__/presence-approve-doors.test.ts` derives the paths
 * from `SENSITIVE_ACTIONS` and fails on a page that calls one around them,
 * and on a hook here whose path is not its procedure's. Each hook keeps the
 * tRPC mutation's shape (`mutate`, `mutateAsync`, `isPending`, `variables`,
 * `error`, `data`) and takes `onSuccess` / `onError` itself.
 */

import {
  sensitiveActionTitle,
  type SensitiveActionPath,
} from "@synap-core/types/presence";
import { trpc } from "../../../lib/trpc";
import {
  usePresenceDoor,
  type DoorHandlers,
  type DoorInput,
  type DoorMutation,
  type InputFor,
  type OutputOf,
  type Resolves,
} from "./use-presence-door";

/** `onSuccess` / `onError` for the door of the tRPC hook `H`. */
type ActionHandlers<H extends (...args: never[]) => unknown> = DoorHandlers<
  Resolves<H>,
  InputFor<H>
>;

/** ONE sensitive action: the proof names `path` and the call's own input. */
function useSensitiveAction<M extends DoorMutation<never, unknown>>(
  path: SensitiveActionPath,
  mutation: M,
  defaults: DoorHandlers<OutputOf<M>, DoorInput<M>> = {}
) {
  return usePresenceDoor(
    mutation,
    (input) => ({
      action: { path, input },
      doing: sensitiveActionTitle(path),
    }),
    defaults
  );
}

// ── Keys ────────────────────────────────────────────────────────────────

export function useCreateKey(
  defaults?: ActionHandlers<typeof trpc.apiKeys.create.useMutation>
) {
  return useSensitiveAction(
    "apiKeys.create",
    trpc.apiKeys.create.useMutation(),
    defaults
  );
}

export function useCreateSystemKey(
  defaults?: ActionHandlers<typeof trpc.apiKeys.createSystemKey.useMutation>
) {
  return useSensitiveAction(
    "apiKeys.createSystemKey",
    trpc.apiKeys.createSystemKey.useMutation(),
    defaults
  );
}

export function useCreateServiceKey(
  defaults?: ActionHandlers<
    typeof trpc.apiKeys.adminCreateServiceKey.useMutation
  >
) {
  return useSensitiveAction(
    "apiKeys.adminCreateServiceKey",
    trpc.apiKeys.adminCreateServiceKey.useMutation(),
    defaults
  );
}

export function useRotateKey(
  defaults?: ActionHandlers<typeof trpc.apiKeys.rotate.useMutation>
) {
  return useSensitiveAction(
    "apiKeys.rotate",
    trpc.apiKeys.rotate.useMutation(),
    defaults
  );
}

export function useSetKeyGrants(
  defaults?: ActionHandlers<typeof trpc.apiKeys.setGrants.useMutation>
) {
  return useSensitiveAction(
    "apiKeys.setGrants",
    trpc.apiKeys.setGrants.useMutation(),
    defaults
  );
}

export function useConnectIntegration(
  defaults?: ActionHandlers<typeof trpc.apiKeys.connectIntegration.useMutation>
) {
  return useSensitiveAction(
    "apiKeys.connectIntegration",
    trpc.apiKeys.connectIntegration.useMutation(),
    defaults
  );
}

export function useBeginMcpConnect(
  defaults?: ActionHandlers<typeof trpc.apiKeys.beginMcpConnect.useMutation>
) {
  return useSensitiveAction(
    "apiKeys.beginMcpConnect",
    trpc.apiKeys.beginMcpConnect.useMutation(),
    defaults
  );
}

/** The pod default lifetime of a computer's key. */
export function useSetMachineDefaults(
  defaults?: ActionHandlers<typeof trpc.apiKeys.setMachineDefaults.useMutation>
) {
  return useSensitiveAction(
    "apiKeys.setMachineDefaults",
    trpc.apiKeys.setMachineDefaults.useMutation(),
    defaults
  );
}

// ── Apps and computers ──────────────────────────────────────────────────

export function useSetAppWriteMode(
  defaults?: ActionHandlers<typeof trpc.apps.setWriteMode.useMutation>
) {
  return useSensitiveAction(
    "apps.setWriteMode",
    trpc.apps.setWriteMode.useMutation(),
    defaults
  );
}

export function useSetMachineKeyTtl(
  defaults?: ActionHandlers<typeof trpc.machines.setKeyTtl.useMutation>
) {
  return useSensitiveAction(
    "machines.setKeyTtl",
    trpc.machines.setKeyTtl.useMutation(),
    defaults
  );
}

export function useSetMachineRunsScripts(
  defaults?: ActionHandlers<typeof trpc.machines.setRunsScripts.useMutation>
) {
  return useSensitiveAction(
    "machines.setRunsScripts",
    trpc.machines.setRunsScripts.useMutation(),
    defaults
  );
}

/** "Installs from the pod": this computer leases its tools' install jobs (backend#779). */
export function useSetMachineHostsServices(
  defaults?: ActionHandlers<typeof trpc.machines.setHostsServices.useMutation>
) {
  return useSensitiveAction(
    "machines.setHostsServices",
    trpc.machines.setHostsServices.useMutation(),
    defaults
  );
}

/** "Wakes agents": the pod may count on this computer's waker (plan v2 slice 4). */
export function useSetMachineWakesAgents(
  defaults?: ActionHandlers<typeof trpc.machines.setWakesAgents.useMutation>
) {
  return useSensitiveAction(
    "machines.setWakesAgents",
    trpc.machines.setWakesAgents.useMutation(),
    defaults
  );
}

/** Whose computer this is (backend#828), sensitive since W3 slice 3 (#827). */
export function useSetMachineBelongsTo(
  defaults?: ActionHandlers<typeof trpc.machines.setBelongsTo.useMutation>
) {
  return useSensitiveAction(
    "machines.setBelongsTo",
    trpc.machines.setBelongsTo.useMutation(),
    defaults
  );
}

// ── Agents and governance ───────────────────────────────────────────────

export function useSetAgentPosture(
  defaults?: ActionHandlers<typeof trpc.agentUsers.setPosture.useMutation>
) {
  return useSensitiveAction(
    "agentUsers.setPosture",
    trpc.agentUsers.setPosture.useMutation(),
    defaults
  );
}

export function useCreateGovernanceRule(
  defaults?: ActionHandlers<typeof trpc.governanceRules.create.useMutation>
) {
  return useSensitiveAction(
    "governanceRules.create",
    trpc.governanceRules.create.useMutation(),
    defaults
  );
}

/** The input `governanceRules.create` takes (without its proof). */
export type CreateGovernanceRuleInput = InputFor<
  typeof trpc.governanceRules.create.useMutation
>;

export function useWidenCell(
  defaults?: ActionHandlers<typeof trpc.governanceRules.widenCell.useMutation>
) {
  return useSensitiveAction(
    "governanceRules.widenCell",
    trpc.governanceRules.widenCell.useMutation(),
    defaults
  );
}

export function useSetReversibleDefault(
  defaults?: ActionHandlers<
    typeof trpc.governanceRules.setReversibleDefault.useMutation
  >
) {
  return useSensitiveAction(
    "governanceRules.setReversibleDefault",
    trpc.governanceRules.setReversibleDefault.useMutation(),
    defaults
  );
}

export function useSetOwnOrganiseDefault(
  defaults?: ActionHandlers<
    typeof trpc.governanceRules.setOwnOrganiseDefault.useMutation
  >
) {
  return useSensitiveAction(
    "governanceRules.setOwnOrganiseDefault",
    trpc.governanceRules.setOwnOrganiseDefault.useMutation(),
    defaults
  );
}

/** How a tool action runs for every AI (on its own / asks first / never). */
export function useSetActionMode(
  defaults?: ActionHandlers<
    typeof trpc.governanceRules.setActionMode.useMutation
  >
) {
  return useSensitiveAction(
    "governanceRules.setActionMode",
    trpc.governanceRules.setActionMode.useMutation(),
    defaults
  );
}
