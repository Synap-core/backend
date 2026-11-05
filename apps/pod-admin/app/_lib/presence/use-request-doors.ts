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

import { useCallback, useRef, useState } from "react";
import type { PresenceProof } from "@synap-core/types/presence";
import { trpc } from "../../../lib/trpc";
import { approveWithPresence, type PresenceSubject } from "./presence-model";
import { usePresence } from "./presence-provider";
import type { ApproveError } from "./use-approve";

/** The part of a tRPC mutation hook these doors use. */
interface DoorMutation<I, O> {
  mutateAsync: (input: I) => Promise<O>;
  isPending: boolean;
  isSuccess: boolean;
  error: unknown;
  reset: () => void;
}

type InputOf<M> = M extends DoorMutation<infer I, unknown> ? I : never;
type OutputOf<M> = M extends DoorMutation<never, infer O> ? O : never;
/** What the tRPC hook `H` resolves with. */
type Resolves<H extends (...args: never[]) => unknown> = OutputOf<
  ReturnType<H>
>;

/** The input the tRPC hook `H`'s door takes, without `presence`. */
type InputFor<H extends (...args: never[]) => unknown> = DoorInput<
  ReturnType<H>
>;

/** The door's input; `presence` is this hook's to add. */
type DoorInput<M> = Omit<InputOf<M>, "presence">;

/** Per-call handlers, like a tRPC `mutate(input, {onSuccess, onError})`. */
export interface DoorHandlers<O, I = never> {
  onSuccess?: (result: O, input: I) => void;
  onError?: (error: ApproveError, input: I) => void;
}

/**
 * Wrap one door: `subjectOf(input)` names the request when this call needs
 * a proof (an approval, a turn-on), or null when it needs none.
 */
function usePresenceDoor<M extends DoorMutation<never, unknown>>(
  mutation: M,
  subjectOf: (input: DoorInput<M>) => PresenceSubject | null,
  defaults: DoorHandlers<OutputOf<M>, DoorInput<M>> = {}
) {
  const { prove } = usePresence();
  const [running, setRunning] = useState(false);
  // The input of the call in flight (or the last one), like `variables`.
  const [variables, setVariables] = useState<DoorInput<M> | undefined>();
  const latest = useRef({ mutation, subjectOf, defaults, prove });
  latest.current = { mutation, subjectOf, defaults, prove };

  const mutateAsync = useCallback(
    async (
      input: DoorInput<M>,
      handlers: DoorHandlers<OutputOf<M>, DoorInput<M>> = {}
    ) => {
      const { mutation, subjectOf, defaults, prove } = latest.current;
      const send = (presence?: PresenceProof) =>
        mutation.mutateAsync(
          (presence ? { ...input, presence } : input) as never
        ) as Promise<OutputOf<M>>;
      const subject = subjectOf(input);
      setRunning(true);
      setVariables(input);
      let result: OutputOf<M>;
      try {
        result = subject
          ? await approveWithPresence({
              subject,
              prove,
              upFront: true,
              attempt: send,
            })
          : await send();
      } catch (err) {
        (handlers.onError ?? defaults.onError)?.(err as ApproveError, input);
        throw err;
      } finally {
        setRunning(false);
      }
      (handlers.onSuccess ?? defaults.onSuccess)?.(result, input);
      return result;
    },
    []
  );
  const mutate = useCallback(
    (
      input: DoorInput<M>,
      handlers?: DoorHandlers<OutputOf<M>, DoorInput<M>>
    ) => {
      mutateAsync(input, handlers).catch(() => undefined); // `onError` has it.
    },
    [mutateAsync]
  );
  return {
    mutate,
    mutateAsync,
    isPending: running || mutation.isPending,
    isSuccess: mutation.isSuccess,
    // The pod's last refusal, typed as the wrapped hook's own error.
    error: mutation.error as M["error"],
    variables,
    reset: mutation.reset,
  };
}

/**
 * What the dialog calls the request: the page's own heading for it (through
 * the vocabulary door), fixed or per call (a list deciding many).
 */
export type DoorLabel<I> =
  string | null | undefined | ((input: I) => string | null);

function labelled<I>(
  subject: PresenceSubject,
  label: DoorLabel<I>,
  input: I
): PresenceSubject {
  const text = typeof label === "function" ? label(input) : label;
  return text ? { ...subject, label: text } : subject;
}

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
