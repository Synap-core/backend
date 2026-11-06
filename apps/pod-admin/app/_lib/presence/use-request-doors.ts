"use client";

/**
 * The console's doors that decide a sensitive request WITHOUT a proposal
 * (W3 slice 2, backend#808), with the proof of presence: a key or device
 * request, an OAuth consent, an application connection, an outside issuer,
 * a catalog source's new key, and a skill or tool turned ON. Each challenge
 * names that request (`{request: {kind, id}}`, `PRESENCE_REQUEST_KINDS`) or
 * the authorization a consent screen shows (`{oauthConsent}`).
 *
 * Every one of them is sensitive by kind, so the proof is asked UP FRONT
 * when the call approves or turns something on; a refusal or a turn-off
 * needs none (the pod gates only the yes). Pages call these hooks, never the
 * tRPC procedure (tripwire `__tripwires__/presence-approve-doors.test.ts`).
 * They keep the wrapped mutation's shape (`mutate`, `mutateAsync`,
 * `isPending`, `error`, `onSuccess` / `onError`), so a page swaps the hook
 * and nothing else.
 */

import { trpc } from "../../../lib/trpc";
import {
  labelled,
  usePresenceDoor,
  type DoorHandlers,
  type DoorLabel,
  type InputFor,
  type Resolves,
} from "./use-presence-door";

export type { DoorHandlers, DoorLabel } from "./use-presence-door";

/** `apiKeys.decideKeyRequest`: a key the CLI asked for, minted as the person. */
export function useDecideKeyRequest(label?: DoorLabel<{ requestId: string }>) {
  return usePresenceDoor(
    trpc.apiKeys.decideKeyRequest.useMutation(),
    (input: { requestId: string; decision: string }) =>
      input.decision === "approve"
        ? labelled(
            { request: { kind: "key_request", id: input.requestId } },
            label,
            input
          )
        : null
  );
}

/**
 * `apiKeys.decideOAuthAuthorization`: an app or AI client connected by
 * consent. `needsProof`: the client is not "Sign in with Synap" (an app that
 * only signs the person in), the one consent the pod does not gate.
 */
export function useDecideOAuthAuthorization(opts: {
  needsProof: boolean;
  label?: DoorLabel<{ clientId: string }>;
}) {
  return usePresenceDoor(
    trpc.apiKeys.decideOAuthAuthorization.useMutation(),
    (input: {
      approve: boolean;
      clientId: string;
      redirectUri: string;
      codeChallenge?: string;
      state?: string;
    }) =>
      input.approve && opts.needsProof
        ? labelled(
            {
              oauthConsent: {
                clientId: input.clientId,
                redirectUri: input.redirectUri,
                codeChallenge: input.codeChallenge ?? null,
                state: input.state ?? null,
              },
            },
            opts.label,
            input
          )
        : null
  );
}

/** `applicationConnections.approveRequest`: a federated application. */
export function useApproveConnectionRequest(
  label?: DoorLabel<{ requestId: string }>,
  defaults: DoorHandlers<
    Resolves<typeof trpc.applicationConnections.approveRequest.useMutation>,
    InputFor<typeof trpc.applicationConnections.approveRequest.useMutation>
  > = {}
) {
  return usePresenceDoor(
    trpc.applicationConnections.approveRequest.useMutation(),
    (input: { requestId: string }) =>
      labelled(
        { request: { kind: "app_connection_request", id: input.requestId } },
        label,
        input
      ),
    defaults
  );
}

/** `trustedIssuers.approve`: what an outside issuer may do on the pod. */
export function useApproveIssuer(
  label?: DoorLabel<{ id: string }>,
  defaults: DoorHandlers<
    Resolves<typeof trpc.trustedIssuers.approve.useMutation>,
    InputFor<typeof trpc.trustedIssuers.approve.useMutation>
  > = {}
) {
  return usePresenceDoor(
    trpc.trustedIssuers.approve.useMutation(),
    (input: { id: string }) =>
      labelled(
        { request: { kind: "trusted_issuer", id: input.id } },
        label,
        input
      ),
    defaults
  );
}

/** `marketplace.sources.approveKeyChange`: trusting a source's new signing key. */
export function useApproveKeyChange(
  label?: DoorLabel<{ id: string }>,
  defaults: DoorHandlers<
    Resolves<typeof trpc.marketplace.sources.approveKeyChange.useMutation>,
    InputFor<typeof trpc.marketplace.sources.approveKeyChange.useMutation>
  > = {}
) {
  return usePresenceDoor(
    trpc.marketplace.sources.approveKeyChange.useMutation(),
    (input: { id: string }) =>
      labelled(
        { request: { kind: "marketplace_key", id: input.id } },
        label,
        input
      ),
    defaults
  );
}

/** `skills.setApproved`: turning a skill's verb ON (off needs no proof). */
export function useSetSkillApproved(
  label?: DoorLabel<{ id: string }>,
  defaults: DoorHandlers<
    Resolves<typeof trpc.skills.setApproved.useMutation>,
    InputFor<typeof trpc.skills.setApproved.useMutation>
  > = {}
) {
  return usePresenceDoor(
    trpc.skills.setApproved.useMutation(),
    (input: { id: string; approved: boolean }) =>
      input.approved
        ? labelled({ request: { kind: "skill", id: input.id } }, label, input)
        : null,
    defaults
  );
}

/** `capabilities.setToolEnabled`: turning a verb ON (off needs no proof). */
export function useSetToolEnabled(
  label?: DoorLabel<{ skillId: string }>,
  defaults: DoorHandlers<
    Resolves<typeof trpc.capabilities.setToolEnabled.useMutation>,
    InputFor<typeof trpc.capabilities.setToolEnabled.useMutation>
  > = {}
) {
  return usePresenceDoor(
    trpc.capabilities.setToolEnabled.useMutation(),
    (input: { skillId: string; enabled: boolean }) =>
      input.enabled
        ? labelled(
            { request: { kind: "skill", id: input.skillId } },
            label,
            input
          )
        : null,
    defaults
  );
}

/** `tools.setApproved`: turning a tool ON (off needs no proof). */
export function useSetToolApproved(
  label?: DoorLabel<{ id: string }>,
  defaults: DoorHandlers<
    Resolves<typeof trpc.tools.setApproved.useMutation>,
    InputFor<typeof trpc.tools.setApproved.useMutation>
  > = {}
) {
  return usePresenceDoor(
    trpc.tools.setApproved.useMutation(),
    (input: { id: string; approved: boolean }) =>
      input.approved
        ? labelled({ request: { kind: "tool", id: input.id } }, label, input)
        : null,
    defaults
  );
}
