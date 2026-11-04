"use client";

/**
 * The console's tRPC approve doors, with the proof of presence (W3): every
 * page approves a proposal through these, never through
 * `trpc.proposals.approve` / `batchApprove` directly (tripwire
 * `__tripwires__/presence-approve-doors.test.ts`).
 *
 * They keep the shape of the tRPC mutation they wrap (`mutate`,
 * `mutateAsync`, `isPending`, `onSuccess` / `onError`), so a page swaps the
 * hook and nothing else. `isPending` holds while the person confirms: a
 * second click cannot start a second approval.
 */

import { useCallback, useRef, useState } from "react";
import { trpc } from "../../../lib/trpc";
import {
  approveEachWithPresence,
  approveWithPresence,
  asPresenceCode,
} from "./presence-model";
import { usePresence } from "./presence-provider";

type ApproveMutation = ReturnType<typeof trpc.proposals.approve.useMutation>;
/** `proposals.approve`'s input; `presence` is this hook's to add. */
export type ApproveInput = Omit<
  Parameters<ApproveMutation["mutateAsync"]>[0],
  "presence"
>;
export type ApproveOutput = Awaited<ReturnType<ApproveMutation["mutateAsync"]>>;

type BatchMutation = ReturnType<typeof trpc.proposals.batchApprove.useMutation>;
export type BatchApproveInput = Omit<
  Parameters<BatchMutation["mutateAsync"]>[0],
  "presenceByProposal"
>;
export type BatchApproveOutput = Awaited<
  ReturnType<BatchMutation["mutateAsync"]>
>;
type BatchItem = BatchApproveOutput["results"][number];

/**
 * What `onError` gets: the door's tRPC error (`data.code`, and
 * `data.reasonCode` for a typed refusal), or `PresenceDeclined` when the
 * person did not confirm (its message says so; no `data`).
 */
export interface ApproveError {
  message: string;
  data?: { code?: string | null; reasonCode?: unknown } | null;
}

interface Handlers<O> {
  onSuccess?: (result: O) => void;
  onError?: (error: ApproveError) => void;
}

/**
 * Run `run`, holding `pending` the whole time and calling the handlers like
 * a tRPC mutation does (for `mutate` and `mutateAsync` alike).
 */
function useHandled<I, O>(
  run: (input: I) => Promise<O>,
  handlers: Handlers<O>
) {
  const [running, setRunning] = useState(false);
  const latest = useRef({ run, handlers });
  latest.current = { run, handlers };
  const mutateAsync = useCallback(async (input: I): Promise<O> => {
    setRunning(true);
    let result: O;
    try {
      result = await latest.current.run(input);
    } catch (err) {
      latest.current.handlers.onError?.(err as ApproveError);
      throw err;
    } finally {
      setRunning(false);
    }
    latest.current.handlers.onSuccess?.(result);
    return result;
  }, []);
  const mutate = useCallback(
    (input: I) => {
      mutateAsync(input).catch(() => undefined); // `onError` has it.
    },
    [mutateAsync]
  );
  return { mutate, mutateAsync, running };
}

/** `proposals.approve`, with the proof when the pod asks for one. */
export function useApproveProposal(handlers: Handlers<ApproveOutput> = {}) {
  const approve = trpc.proposals.approve.useMutation();
  const { prove } = usePresence();
  const { mutate, mutateAsync, running } = useHandled(
    (input: ApproveInput) =>
      approveWithPresence({
        subject: { proposalId: input.proposalId },
        prove,
        attempt: (presence) =>
          approve.mutateAsync(presence ? { ...input, presence } : input),
      }),
    handlers
  );
  return {
    mutate,
    mutateAsync,
    isPending: running || approve.isPending,
    isSuccess: approve.isSuccess,
  };
}

/**
 * `proposals.batchApprove`, then each item the pod refused for its proof,
 * proved and sent again alone (`approveEachWithPresence`). The answer is the
 * batch's, with those items' new results in place.
 */
export function useBatchApproveProposals(
  handlers: Handlers<BatchApproveOutput> = {}
) {
  const batch = trpc.proposals.batchApprove.useMutation();
  const { prove } = usePresence();
  const { mutate, mutateAsync, running } = useHandled(
    async (input: BatchApproveInput): Promise<BatchApproveOutput> => {
      const first = await batch.mutateAsync(input);
      const results = await approveEachWithPresence<BatchItem>({
        results: first.results,
        refusalOf: (r) => {
          const code = r.success ? null : asPresenceCode(r.reasonCode);
          return code ? { id: r.proposalId, code } : null;
        },
        subjectOf: (proposalId) => ({ proposalId }),
        prove,
        retryOne: async (proposalId, presence) => {
          try {
            const again = await batch.mutateAsync({
              ...input,
              proposalIds: [proposalId],
              presenceByProposal: { [proposalId]: presence },
            });
            const item = again.results.find((r) => r.proposalId === proposalId);
            if (item) return item;
          } catch (err) {
            return {
              proposalId,
              success: false,
              error: err instanceof Error ? err.message : String(err),
            } as BatchItem;
          }
          return { proposalId, success: false } as BatchItem;
        },
      });
      return { ...first, results };
    },
    handlers
  );
  return { mutate, mutateAsync, isPending: running || batch.isPending };
}
