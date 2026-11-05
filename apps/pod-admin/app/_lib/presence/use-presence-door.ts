"use client";

/**
 * One tRPC mutation wrapped with the proof of presence (W3): the shape every
 * door of this folder returns (`use-request-doors.ts`, the decisions that
 * settle no proposal; `use-sensitive-actions.ts`, the sensitive actions).
 *
 * `subjectOf(input)` names what this call proves, or null when it needs no
 * proof. A call that needs one is proved UP FRONT (`approveWithPresence`
 * with `upFront`), so `report` mode already runs the path `enforce` will
 * require; a presence refusal asks again. The wrapped hook keeps the tRPC
 * mutation's shape (`mutate`, `mutateAsync`, `isPending`, `error`,
 * `variables`, `data`, `onSuccess` / `onError`), so a page swaps the hook and
 * nothing else. Handlers go to THIS hook, never to the inner `useMutation`:
 * there, `onError` would fire on the refused first try the proof then fixes.
 */

import { useCallback, useRef, useState } from "react";
import type { PresenceProof } from "@synap-core/types/presence";
import { approveWithPresence, type PresenceSubject } from "./presence-model";
import { usePresence } from "./presence-provider";
import type { ApproveError } from "./use-approve";

/** The part of a tRPC mutation hook these doors use. */
export interface DoorMutation<I, O> {
  mutateAsync: (input: I) => Promise<O>;
  isPending: boolean;
  isSuccess: boolean;
  error: unknown;
  data?: unknown;
  reset: () => void;
}

type InputOf<M> = M extends DoorMutation<infer I, unknown> ? I : never;
export type OutputOf<M> = M extends DoorMutation<never, infer O> ? O : never;
/** What the tRPC hook `H` resolves with. */
export type Resolves<H extends (...args: never[]) => unknown> = OutputOf<
  ReturnType<H>
>;

/** `Omit` over each member of a union (a plain `Omit` keeps only shared keys). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** The door's input; `presence` is this hook's to add. */
export type DoorInput<M> = DistributiveOmit<InputOf<M>, "presence">;

/** The input the tRPC hook `H`'s door takes, without `presence`. */
export type InputFor<H extends (...args: never[]) => unknown> = DoorInput<
  ReturnType<H>
>;

/** Per-call handlers, like a tRPC `mutate(input, {onSuccess, onError})`. */
export interface DoorHandlers<O, I = never> {
  onSuccess?: (result: O, input: I) => void;
  onError?: (error: ApproveError, input: I) => void;
}

/**
 * Wrap one door: `subjectOf(input)` names what this call proves (an
 * approval, a turn-on, a sensitive action), or null when it needs none.
 */
export function usePresenceDoor<M extends DoorMutation<never, unknown>>(
  mutation: M,
  subjectOf: (input: DoorInput<M>) => PresenceSubject | null,
  defaults: DoorHandlers<OutputOf<M>, DoorInput<M>> = {}
) {
  const { prove } = usePresence();
  const [running, setRunning] = useState(false);
  // The input of the call in flight (or the last one), like `variables`.
  const [variables, setVariables] = useState<DoorInput<M> | undefined>();
  const [data, setData] = useState<OutputOf<M> | undefined>();
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
      setData(result);
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
    data,
    reset: mutation.reset,
  };
}

/**
 * What the dialog calls the request: the page's own heading for it (through
 * the vocabulary door), fixed or per call (a list deciding many).
 */
export type DoorLabel<I> =
  string | null | undefined | ((input: I) => string | null);

export function labelled<I>(
  subject: PresenceSubject,
  label: DoorLabel<I>,
  input: I
): PresenceSubject {
  const text = typeof label === "function" ? label(input) : label;
  return text ? { ...subject, label: text } : subject;
}
