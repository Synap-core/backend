"use client";

/**
 * What this pod asks a passkey for (W5, `presence.sensitivity`): the rows of
 * the sensitive lists a pod admin switched off, and the mode in force. Every
 * proof door of this folder reads it, so pod admin asks for a passkey up
 * front only where the pod will (founder, 6 Nov 2026: a switched-off deploy
 * must stop asking).
 *
 * Not read yet, or a failed read: null, which every caller takes as the
 * lists as written (ask). Asking where the pod would not is a spare prompt;
 * skipping where it would is a refusal the door still answers by asking.
 */

import { trpc } from "../../../lib/trpc";

export function usePodSensitivity() {
  const read = trpc.presence.sensitivity.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });
  return read.data ?? null;
}
