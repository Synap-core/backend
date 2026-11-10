"use client";

/**
 * "Add this device", the NEW device's side (`link-model.ts` is its state
 * machine; `DeviceLinkPanel.tsx` draws it):
 *
 *  1. `presence.deviceLink.request` (kind `passkey`, this browser's label)
 *     as soon as the panel opens;
 *  2. while it waits, `presence.deviceLink.status` every 2 s. The poll stops
 *     on any other state, on unmount, and while the tab is hidden; it reads
 *     again the moment the tab is visible;
 *  3. once approved (or with nothing to approve), on the person's press: the
 *     passkey through Kratos' settings flow, the SAME step the passkeys card
 *     runs (`registerPasskey`), with NO `authorizePasskeyChange` first: the
 *     settings guard redeems this session's approved request;
 *  4. Cancel declines the open request (an approval not yet used too).
 *
 * After success: `presence.factors` (the count, the top bar, the passkeys
 * card's readers) is read again, and this browser remembers it holds a
 * passkey (`rememberThisDevicePasskey`).
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import {
  createBrowserFlow,
  collectErrorMessages,
  type CreateFlowResult,
} from "../../../../lib/kratos-flow";
import {
  PasskeyCancelled,
  PasskeyCreateFailed,
  type PasskeyPlacement,
} from "../../../../lib/passkey";
import { useT } from "../../../../lib/i18n/locale-provider";
import { errorDetail } from "../../copy-button";
import { registerPasskey } from "../../passkeys/register-passkey";
import { en, fr } from "./copy";
import { browserSignals, deviceLabel, deviceParts } from "./device-label";
import {
  DEVICE_LINK_POLL_MS,
  INITIAL_LINK_STATE,
  deadlineOf,
  linkReducer,
  openRequestId,
  reasonCodeOf,
  registrationEvent,
  shouldPoll,
  startPasskeyStep,
} from "./link-model";
import { rememberThisDevicePasskey } from "./use-this-device";

const CATALOGS = { en, fr };

/** The new device's label, as the approving device will read it. */
export function useThisDeviceLabel(): string {
  const t = useT(CATALOGS);
  const signals = browserSignals();
  return deviceLabel(
    signals ? deviceParts(signals) : { device: null, browser: null },
    {
      join: (args) => t("label.join", args),
      unknown: t("label.unknown"),
    }
  );
}

export function useDeviceLink() {
  const [state, dispatch] = useReducer(linkReducer, INITIAL_LINK_STATE);
  const label = useThisDeviceLabel();
  const utils = trpc.useUtils();
  const requestMutation = trpc.presence.deviceLink.request.useMutation();
  const declineMutation = trpc.presence.deviceLink.decline.useMutation();
  const latest = useRef({ label, requestMutation, declineMutation, utils });
  latest.current = { label, requestMutation, declineMutation, utils };
  const [now, setNow] = useState(() => Date.now());

  const ask = useCallback(async () => {
    dispatch({ type: "ask" });
    try {
      const answer = await latest.current.requestMutation.mutateAsync({
        kind: "passkey",
        label: latest.current.label,
      });
      dispatch({
        type: "asked",
        answer: answer.needed
          ? {
              needed: true,
              id: answer.id,
              number: answer.number,
              expiresAt: answer.expiresAt,
            }
          : { needed: false },
      });
    } catch (err) {
      dispatch({
        type: "ask-failed",
        reasonCode: reasonCodeOf(err),
        detail: errorDetail(err),
      });
    }
  }, []);

  // Ask once, when the panel opens (a ref, so StrictMode's second effect
  // run does not ask twice).
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void ask();
  }, [ask]);

  // Where the request stands, every 2 s while it waits and the tab is seen.
  const [pollNonce, setPollNonce] = useState(0);
  const pollId = shouldPoll(state);
  useEffect(() => {
    if (!pollId) return;
    let stopped = false;
    let inFlight = false;
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      if (!stopped && document.visibilityState !== "hidden") {
        timer = window.setTimeout(() => void read(), DEVICE_LINK_POLL_MS);
      }
    };
    const read = async () => {
      if (stopped || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const r =
          await latest.current.utils.client.presence.deviceLink.status.query({
            id: pollId,
          });
        if (!stopped) {
          dispatch({
            type: "status",
            status: r.status,
            expiresAt: r.expiresAt,
          });
        }
      } catch (err) {
        if (!stopped) {
          dispatch({
            type: "status-failed",
            reasonCode: reasonCodeOf(err),
            detail: errorDetail(err),
          });
        }
      } finally {
        inFlight = false;
        schedule();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void read();
      else window.clearTimeout(timer);
    };
    document.addEventListener("visibilitychange", onVisibility);
    // A "Try again" (pollNonce) reads at once; a new wait waits one beat.
    if (pollNonce > 0) void read();
    else schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pollId, pollNonce]);

  // The clock: time left, and a wait or an approval that runs out.
  const ticking = deadlineOf(state) !== null;
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      dispatch({ type: "clock", now: at });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  /** Read the status again now (the failed-read state's Try again). */
  const readAgain = useCallback(() => setPollNonce((n) => n + 1), []);

  // The settings flow, read BEFORE the press. WebKit (every iPhone browser,
  // Safari on the Mac) opens a passkey prompt only while the tap still
  // counts; a network wait between the tap and `credentials.create` uses
  // that up and the browser refuses with NotAllowedError, no prompt shown
  // (founder's iPhone, 10 Nov 2026). The passkeys card holds its flow the
  // same way. A flow Kratos was sent is spent: the next try reads a new one.
  const flowRef = useRef<CreateFlowResult | null>(null);
  /** The flow was read (held in `flowRef`, or its read failed): no read again until it is spent. */
  const [flowRead, setFlowRead] = useState(false);
  const canCreate = state.kind === "approved" || state.kind === "create-failed";
  useEffect(() => {
    if (!canCreate || flowRead) return;
    let live = true;
    createBrowserFlow("settings").then(
      (r) => {
        if (!live) return;
        flowRef.current = r;
        setFlowRead(true);
      },
      () => {
        // Not swallowed: with no flow held, the press reads it again and
        // shows that failure (`create-failed` with its details).
        if (live) setFlowRead(true);
      }
    );
    return () => {
      live = false;
    };
  }, [canCreate, flowRead]);

  /** Create this device's passkey: from the person's press (WebAuthn needs it). */
  const create = useCallback(async (placement: PasskeyPlacement) => {
    dispatch({ type: "create" });
    try {
      const step = await startPasskeyStep(
        flowRef.current,
        () => createBrowserFlow("settings"),
        (flow) =>
          registerPasskey(flow, placement, () => {
            // Kratos is sent this flow: it is spent.
            flowRef.current = null;
            setFlowRead(false);
          })
      );
      if (step.kind === "reauth") {
        // No settings flow for this sign-in: it must sign in again.
        dispatch({ type: "reauth" });
        return;
      }
      const r = step.result;
      const next = registrationEvent(
        r.kind === "flow"
          ? {
              kind: "flow",
              errors: collectErrorMessages(r.flow),
              success: r.flow.state === "success",
            }
          : r.kind === "error"
            ? { kind: "error", message: r.error.message ?? null }
            : r.kind === "redirect"
              ? { kind: "redirect", to: r.to }
              : r.kind === "refresh_required"
                ? { kind: "refresh_required" }
                : { kind: "session" }
      );
      if (next.type === "redirect") {
        window.location.assign(next.to);
        return;
      }
      if (next.type === "created") {
        rememberThisDevicePasskey();
        void latest.current.utils.presence.factors.invalidate();
      }
      dispatch(next);
    } catch (err) {
      if (err instanceof PasskeyCancelled) {
        dispatch({ type: "create-cancelled", detail: err.detail });
        return;
      }
      dispatch({
        type: "create-failed",
        reason: err instanceof PasskeyCreateFailed ? err.reason : "failed",
        detail: errorDetail(err),
      });
    }
  }, []);

  /** Cancel: decline the open request (never waited on: it only takes power away). */
  const stateRef = useRef(state);
  stateRef.current = state;
  const cancel = useCallback(() => {
    const id = openRequestId(stateRef.current);
    if (id) {
      latest.current.declineMutation.mutateAsync({ id }).catch(() => undefined);
    }
  }, []);

  /** The press can open the prompt at once: the flow is read (or its read failed). */
  const preparing = canCreate && !flowRead;
  return { state, now, ask, readAgain, create, cancel, preparing };
}
