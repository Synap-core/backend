"use client";

/**
 * "Add this device", on a device the person ALREADY uses: the new devices
 * asking (`presence.deviceLink.pending`, read every 10 s while the tab is
 * seen, and again when the window gets focus), and the two answers:
 *
 *  - a number: `presence.deviceLink.approve`, proved UP FRONT for
 *    `device_link:<id>` through the presence door (`usePresenceDoor` →
 *    `approveWithPresence`): this folder is the only place it is called
 *    (tripwire `__tripwires__/presence-approve-doors.test.ts`);
 *  - "Not me": `presence.deviceLink.decline` (it only takes power away).
 *
 * Each answer leaves one receipt (`requests-model.ts`) and reads the list
 * again.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { useT } from "../../../../lib/i18n/locale-provider";
import { PresenceDeclined } from "../presence-model";
import { labelled, usePresenceDoor } from "../use-presence-door";
import { en, fr } from "./copy";
import {
  DEVICE_LINK_PENDING_POLL_MS,
  approveReceipt,
  declineReceipt,
  requestsView,
  type RequestReceipt,
} from "./requests-model";

const CATALOGS = { en, fr };

/** One receipt, for the request it answered (its label as the device sent it). */
export interface ShownReceipt {
  id: string;
  label: string;
  receipt: RequestReceipt;
}

export function useDeviceLinkRequests() {
  const t = useT(CATALOGS);
  const pending = trpc.presence.deviceLink.pending.useQuery(undefined, {
    retry: false,
    // React Query pauses an interval while the tab is hidden
    // (`refetchIntervalInBackground` is off) and reads on focus.
    refetchInterval: DEVICE_LINK_PENDING_POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  // The labels the dialog names each request by (`requests.subject`).
  const labels = useRef(new Map<string, string>());
  for (const r of pending.data ?? []) labels.current.set(r.id, r.label);

  const approve = usePresenceDoor(
    trpc.presence.deviceLink.approve.useMutation(),
    (input: { id: string; number: string }) =>
      labelled(
        { request: { kind: "device_link", id: input.id } },
        (i: { id: string }) => {
          const label = labels.current.get(i.id);
          return label ? t("requests.subject", { label }) : null;
        },
        input
      )
  );
  const decline = trpc.presence.deviceLink.decline.useMutation();

  const [receipts, setReceipts] = useState<ShownReceipt[]>([]);
  /** The request an answer is on its way for: its buttons wait. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const say = (id: string, receipt: RequestReceipt | null) => {
    if (!receipt) return;
    const label = labels.current.get(id) ?? "";
    setReceipts((prev) => [
      ...prev.filter((r) => r.id !== id),
      { id, label, receipt },
    ]);
  };
  // The latest door and read, for callbacks that never change.
  const latest = useRef({ approve, decline, pending, say });
  latest.current = { approve, decline, pending, say };

  const pick = useCallback(async (id: string, number: string) => {
    const { approve, pending, say } = latest.current;
    setBusyId(id);
    try {
      await approve.mutateAsync({ id, number });
      say(id, approveReceipt({ ok: true }));
    } catch (err) {
      say(
        id,
        approveReceipt({
          ok: false,
          error: err,
          declined: err instanceof PresenceDeclined,
        })
      );
    } finally {
      setBusyId(null);
      void pending.refetch();
    }
  }, []);

  const notMe = useCallback(async (id: string) => {
    const { decline, pending, say } = latest.current;
    setBusyId(id);
    try {
      await decline.mutateAsync({ id });
      say(id, declineReceipt({ ok: true }));
    } catch (err) {
      say(id, declineReceipt({ ok: false, error: err }));
    } finally {
      setBusyId(null);
      void pending.refetch();
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => setReceipts((prev) => prev.filter((r) => r.id !== id)),
    []
  );

  // The minutes left move between reads too: draw again every 15 s.
  const [, setTick] = useState(0);
  const anyRows = (pending.data?.length ?? 0) > 0;
  useEffect(() => {
    if (!anyRows) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [anyRows]);

  return {
    view: requestsView(
      {
        data: pending.data,
        isLoading: pending.isLoading,
        error: pending.error,
      },
      Date.now()
    ),
    retry: () => void pending.refetch(),
    receipts,
    busyId,
    pick,
    notMe,
    dismiss,
  };
}
