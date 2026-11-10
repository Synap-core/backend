/**
 * "Add this device" (founder decision of 9 Nov 2026, session 84c74a23), the
 * NEW device's side: the panel's state machine, pure, so each state is
 * tested. `use-device-link.ts` drives it; `DeviceLinkPanel.tsx` draws it.
 *
 *   asking ─▶ approved (id null: the person holds no factor yet, nothing to
 *          │            approve: create the passkey straight away)
 *          ├▶ waiting {number} ─▶ approved ─▶ creating ─▶ done
 *          │      │  ▲                 ▲          │
 *          │      ▼  │                 └──────────┴▶ create-failed / reauth
 *          │   status-failed (a failed READ, never "declined": Try again,
 *          │                  and the poll keeps trying)
 *          │      └▶ declined | expired (Ask again)
 *          ├▶ request-failed (Try again) · rate-limited · no-session
 *
 * WebAuthn runs only from a click, so `approved` waits for the person's
 * press ("Create a passkey on this device") before `creating`. The approval
 * is redeemed by Kratos' settings guard when the passkey is registered, by
 * THIS session only, within `DEVICE_LINK_TTL_SECONDS`.
 *
 * The pod's refusals arrive as `data.reasonCode` on the tRPC error (the
 * router's `cause: {reasonCode}`): RATE, NO_SESSION and GONE each have their
 * state; any other failure is a failed request or read.
 */
import type { CreateFlowResult, KratosFlow } from "../../../../lib/kratos-flow";
import {
  PRESENCE_DEVICE_LINK_GONE,
  PRESENCE_DEVICE_LINK_NO_SESSION,
  PRESENCE_DEVICE_LINK_RATE,
  type DeviceLinkReadStatus,
} from "@synap-core/types/presence";

/** How often the new device asks where its request stands. */
export const DEVICE_LINK_POLL_MS = 2_000;

/** Why a passkey could not be created; the words are `copy.ts`'s `create.<reason>`. */
export type CreateFailure = "exists" | "timeout" | "failed" | "refused";

export type LinkState =
  | { kind: "asking" }
  | {
      kind: "waiting";
      id: string;
      number: string;
      /** ISO: when the request stops waiting. */
      expiresAt: string;
    }
  | {
      kind: "status-failed";
      id: string;
      number: string;
      expiresAt: string;
      detail: string | null;
    }
  | {
      kind: "approved";
      /** null: nothing to approve (the person holds no factor yet). */
      id: string | null;
      /** ISO: when the approval can no longer be redeemed; null with no id. */
      expiresAt: string | null;
      /**
       * The last prompt ended with no passkey (closed, or never opened: a
       * browser that refused it says the same NotAllowedError). Said, never
       * silent; `detail` is the browser's words for "Copy details".
       */
      closed?: { detail: string | null };
    }
  | { kind: "creating"; id: string | null; expiresAt: string | null }
  | {
      kind: "create-failed";
      id: string | null;
      expiresAt: string | null;
      reason: CreateFailure;
      detail: string | null;
    }
  /** Kratos wants a recent sign-in before the passkey is registered. */
  | { kind: "reauth" }
  | { kind: "done" }
  | { kind: "declined" }
  | { kind: "expired" }
  | { kind: "request-failed"; detail: string | null }
  | { kind: "rate-limited" }
  /** This sign-in has no session to tie the request to: sign in again. */
  | { kind: "no-session" };

export type LinkEvent =
  | { type: "ask" }
  | {
      type: "asked";
      answer:
        | { needed: false }
        | { needed: true; id: string; number: string; expiresAt: string };
    }
  | { type: "ask-failed"; reasonCode: string | null; detail: string | null }
  | { type: "status"; status: DeviceLinkReadStatus; expiresAt: string }
  | {
      type: "status-failed";
      reasonCode: string | null;
      detail: string | null;
    }
  /** The clock: a request or an approval past its time has run out. */
  | { type: "clock"; now: number }
  | { type: "create" }
  | { type: "created" }
  /**
   * The prompt ended with no passkey (NotAllowedError: the person closed it,
   * or the browser never opened it): back to where they pressed, saying so.
   */
  | { type: "create-cancelled"; detail: string | null }
  | { type: "create-failed"; reason: CreateFailure; detail: string | null }
  | { type: "reauth" };

export const INITIAL_LINK_STATE: LinkState = { kind: "asking" };

/** The machine code of a tRPC refusal (`data.reasonCode`), or null. */
export function reasonCodeOf(err: unknown): string | null {
  const code = (err as { data?: { reasonCode?: unknown } | null } | null)?.data
    ?.reasonCode;
  return typeof code === "string" ? code : null;
}

function past(iso: string | null, now: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at <= now;
}

/** The request's id while one is open (to poll, or to decline on Cancel). */
export function openRequestId(state: LinkState): string | null {
  switch (state.kind) {
    case "waiting":
    case "status-failed":
    case "approved":
    case "creating":
    case "create-failed":
      return state.id;
    default:
      return null;
  }
}

/** Ask the pod where the request stands: only while it waits for approval. */
export function shouldPoll(state: LinkState): string | null {
  return state.kind === "waiting" || state.kind === "status-failed"
    ? state.id
    : null;
}

/** The moment that ends the current wait, for the time left; null for none. */
export function deadlineOf(state: LinkState): string | null {
  switch (state.kind) {
    case "waiting":
    case "status-failed":
      return state.expiresAt;
    case "approved":
    case "create-failed":
      return state.expiresAt;
    default:
      return null;
  }
}

export function linkReducer(state: LinkState, event: LinkEvent): LinkState {
  switch (event.type) {
    case "ask":
      return { kind: "asking" };
    case "asked":
      if (state.kind !== "asking") return state;
      return event.answer.needed
        ? {
            kind: "waiting",
            id: event.answer.id,
            number: event.answer.number,
            expiresAt: event.answer.expiresAt,
          }
        : { kind: "approved", id: null, expiresAt: null };
    case "ask-failed":
      if (state.kind !== "asking") return state;
      if (event.reasonCode === PRESENCE_DEVICE_LINK_RATE) {
        return { kind: "rate-limited" };
      }
      if (event.reasonCode === PRESENCE_DEVICE_LINK_NO_SESSION) {
        return { kind: "no-session" };
      }
      return { kind: "request-failed", detail: event.detail };
    case "status": {
      // Only a request still waiting reads its status; a late answer after
      // the person moved on changes nothing.
      if (state.kind !== "waiting" && state.kind !== "status-failed") {
        return state;
      }
      const at = { id: state.id, number: state.number };
      switch (event.status) {
        case "pending":
          return { kind: "waiting", ...at, expiresAt: event.expiresAt };
        case "approved":
          return { kind: "approved", id: state.id, expiresAt: event.expiresAt };
        case "redeemed":
          // Another tab of this same sign-in already added the passkey.
          return { kind: "done" };
        case "declined":
          return { kind: "declined" };
        // Replaced (asked again elsewhere) or past its time: ask again.
        case "replaced":
        case "expired":
          return { kind: "expired" };
        default:
          return state;
      }
    }
    case "status-failed":
      if (state.kind !== "waiting" && state.kind !== "status-failed") {
        return state;
      }
      // GONE: the pod no longer knows this request for this sign-in.
      if (event.reasonCode === PRESENCE_DEVICE_LINK_GONE) {
        return { kind: "expired" };
      }
      if (event.reasonCode === PRESENCE_DEVICE_LINK_NO_SESSION) {
        return { kind: "no-session" };
      }
      return {
        kind: "status-failed",
        id: state.id,
        number: state.number,
        expiresAt: state.expiresAt,
        detail: event.detail,
      };
    case "clock": {
      if (
        (state.kind === "waiting" ||
          state.kind === "status-failed" ||
          state.kind === "approved" ||
          state.kind === "create-failed") &&
        past(deadlineOf(state), event.now)
      ) {
        return { kind: "expired" };
      }
      return state;
    }
    case "create":
      if (state.kind !== "approved" && state.kind !== "create-failed") {
        return state;
      }
      return { kind: "creating", id: state.id, expiresAt: state.expiresAt };
    case "created":
      return state.kind === "creating" ? { kind: "done" } : state;
    case "create-cancelled":
      return state.kind === "creating"
        ? {
            kind: "approved",
            id: state.id,
            expiresAt: state.expiresAt,
            closed: { detail: event.detail },
          }
        : state;
    case "create-failed":
      return state.kind === "creating"
        ? {
            kind: "create-failed",
            id: state.id,
            expiresAt: state.expiresAt,
            reason: event.reason,
            detail: event.detail,
          }
        : state;
    case "reauth":
      return state.kind === "creating" ? { kind: "reauth" } : state;
  }
}

/**
 * The time left before `iso`, for "{n} min left" / "{n} s left": whole
 * minutes rounded UP from one minute on, seconds below it; null once past.
 */
export function timeLeft(
  iso: string | null,
  now: number
): { unit: "minutes" | "seconds"; n: number } | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.ceil((at - now) / 1000);
  if (seconds <= 0) return null;
  return seconds >= 60
    ? { unit: "minutes", n: Math.ceil(seconds / 60) }
    : { unit: "seconds", n: seconds };
}

/** Kratos' answer to the passkey registration, as the panel's next event. */
export function registrationEvent(
  r:
    | { kind: "flow"; errors: readonly string[]; success: boolean }
    | { kind: "refresh_required" }
    | { kind: "redirect"; to: string }
    | { kind: "session" }
    | { kind: "error"; message?: string | null }
): LinkEvent | { type: "redirect"; to: string } {
  switch (r.kind) {
    case "flow":
      if (r.errors.length > 0) {
        return {
          type: "create-failed",
          reason: "refused",
          detail: r.errors.join(" "),
        };
      }
      return r.success
        ? { type: "created" }
        : { type: "create-failed", reason: "failed", detail: null };
    case "refresh_required":
      return { type: "reauth" };
    case "redirect":
      return { type: "redirect", to: r.to };
    case "session":
      return { type: "create-failed", reason: "failed", detail: null };
    case "error":
      return {
        type: "create-failed",
        reason: "failed",
        detail: r.message ?? null,
      };
  }
}

/**
 * Start the passkey step from the person's press. With the settings flow
 * already held, `register` (which opens the passkey prompt) runs in the SAME
 * tick as the press: nothing is awaited before it, because WebKit opens the
 * prompt only while the tap still counts (founder's iPhone, 10 Nov 2026: a
 * read of the flow between the tap and the prompt left nothing on screen).
 * With none held (its early read failed), the flow is read first; the
 * failure, if any, rejects. Not a flow: this sign-in must sign in again.
 */
export function startPasskeyStep<R>(
  held: CreateFlowResult | null,
  readFlow: () => Promise<CreateFlowResult>,
  register: (flow: KratosFlow) => Promise<R>
): Promise<{ kind: "reauth" } | { kind: "registered"; result: R }> {
  const proceed = (
    started: CreateFlowResult
  ): Promise<{ kind: "reauth" } | { kind: "registered"; result: R }> =>
    "flow" in started
      ? register(started.flow).then((result) => ({
          kind: "registered" as const,
          result,
        }))
      : Promise.resolve({ kind: "reauth" as const });
  return held ? proceed(held) : readFlow().then(proceed);
}
