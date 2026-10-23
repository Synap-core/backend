"use client";

/**
 * `useSessionMoves` — a status move (`sessionMoves`, `./session-status.ts`)
 * sent through the door it names. One mutation per door, so a pending move
 * spins only its own button, and nothing here writes a status the door does
 * not decide: `update` is asked only for the two plain flips it owns
 * (paused ↔ active), the rest go through their own procedures.
 */

import { useState } from "react";
import { trpc } from "../../../lib/trpc";
import {
  moveNotice,
  type MoveNotice,
  type SessionDoor,
  type SessionMove,
  type SessionMoveKey,
} from "./session-status";

export function useSessionMoves(sessionId: string) {
  const utils = trpc.useUtils();
  const [notice, setNotice] = useState<MoveNotice | null>(null);
  const [lastKey, setLastKey] = useState<SessionMoveKey | null>(null);

  // A move changes the session, the lists it sits in and what the pod says
  // needs attention.
  const settled = (door: SessionDoor) => async (result: unknown) => {
    setNotice(moveNotice(door, result));
    await Promise.all([
      utils.focusSessions.get.invalidate({ id: sessionId }),
      utils.focusSessions.browse.invalidate(),
      utils.focusSessions.owed.invalidate(),
      utils.signals.invalidate(),
    ]);
  };

  const accept = trpc.focusSessions.acceptFromTriage.useMutation({
    onSuccess: settled("acceptFromTriage"),
  });
  const discard = trpc.focusSessions.discardFromTriage.useMutation({
    onSuccess: settled("discardFromTriage"),
  });
  const update = trpc.focusSessions.update.useMutation({
    onSuccess: settled("update"),
  });
  const close = trpc.focusSessions.close.useMutation({
    onSuccess: settled("close"),
  });
  const cancel = trpc.focusSessions.cancel.useMutation({
    onSuccess: settled("cancel"),
  });

  const byDoor = {
    acceptFromTriage: accept,
    discardFromTriage: discard,
    update,
    close,
    cancel,
  } as const;

  /**
   * Send the move. A confirm, when the move needs one, is the caller's;
   * `onDone` closes it once the door has answered.
   */
  function run(m: SessionMove, onDone?: () => void) {
    setNotice(null);
    setLastKey(m.key);
    const opts = onDone ? { onSuccess: onDone } : undefined;
    switch (m.door) {
      case "acceptFromTriage":
        return update.mutate({ id: sessionId, status: "active" }, opts);
      case "discardFromTriage":
        return discard.mutate({ sessionId }, opts);
      case "update":
        return update.mutate({ id: sessionId, status: m.toStatus! }, opts);
      case "close":
        return close.mutate({ id: sessionId }, opts);
      case "cancel":
        return cancel.mutate({ sessionId }, opts);
    }
  }

  const pending = Object.values(byDoor).some((m) => m.isPending)
    ? lastKey
    : null;

  return {
    run,
    /** The move in flight, if any. */
    pending,
    notice,
    /** Every move's error, for the page's re-auth and its error line. */
    errors: [
      accept.error,
      discard.error,
      update.error,
      close.error,
      cancel.error,
    ],
  };
}
