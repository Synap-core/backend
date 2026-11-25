"use client";

/**
 * The caller's grace window (founder, 18 Nov 2026): after a passkey proof,
 * this browser session may turn verbs and tools on for a few minutes with no
 * new proof. The pod says how long is left (`presence.sensitivity`'s
 * `graceSecondsLeft`, from `services/presence/grace.ts`); this hook counts
 * it down locally and reads again when the pod's answer changes.
 *
 * Unknown (not read yet, a failed read, no grace) is null: callers ask for a
 * proof, which is the safe side. The pod decides every act either way.
 */

import { useEffect, useState } from "react";
import { trpc } from "../../../lib/trpc";

/** `4:12` for 252 seconds. */
export function formatGraceLeft(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function usePresenceGrace(): { secondsLeft: number | null } {
  const read = trpc.presence.sensitivity.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  const base = read.data?.graceSecondsLeft ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (base === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [base, read.dataUpdatedAt]);
  if (base === null) return { secondsLeft: null };
  const left = base - Math.floor((now - read.dataUpdatedAt) / 1000);
  return { secondsLeft: left > 0 ? left : null };
}
