/**
 * Kratos flow → explicit pod-admin sign-in state.
 *
 * Kratos hands the login page a flow whose `ui.messages` carry ids. A few of
 * them mean something the user must ACT on, and rendering their raw text as a
 * red banner left people stuck ("which password?"). This maps those ids to a
 * state the page renders on purpose; anything unrecognised stays `none` and
 * keeps the existing banner.
 *
 * The ids come from ONE place, `@synap-core/types/kratos-messages` — the pod's
 * registration gate emits the same constants.
 */

import {
  KRATOS_ACCOUNT_LINK_ID_SET,
  POD_ACCESS_REQUIRED,
  SELF_REGISTRATION_DISABLED,
} from "@synap-core/types/kratos-messages";
import type { KratosFlow, KratosMessage } from "./kratos-flow";

/** Which Kratos self-service flow the `?flow=` id belongs to. */
export type SelfServiceFlowKind = "login" | "registration";

export type SignInState =
  /** A Synap Cloud user this pod has not let in (gate 4000901). */
  | { kind: "access_required"; email: string | null }
  /** An existing pod account signing in with Cloud for the first time. */
  | { kind: "account_link"; email: string | null }
  /** Password / non-Cloud self sign-up (gate 4000902, or a bare sign-up flow). */
  | { kind: "self_registration_disabled" }
  | { kind: "none" };

function allMessages(flow: KratosFlow): KratosMessage[] {
  return [
    ...(flow.ui.messages ?? []),
    ...flow.ui.nodes.flatMap((n) => n.messages ?? []),
  ];
}

function hasReason(m: KratosMessage, reason: string): boolean {
  return m.context?.reason === reason;
}

function stringValue(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function nodeValue(flow: KratosFlow, name: string): string | null {
  const node = flow.ui.nodes.find((n) => n.attributes?.name === name);
  return stringValue(node?.attributes?.value);
}

/** True when the message is one of the gate's or Kratos' state-bearing ids. */
export function isStateMessage(m: KratosMessage): boolean {
  return (
    m.id === POD_ACCESS_REQUIRED.id ||
    m.id === SELF_REGISTRATION_DISABLED.id ||
    (typeof m.id === "number" && KRATOS_ACCOUNT_LINK_ID_SET.has(m.id)) ||
    hasReason(m, POD_ACCESS_REQUIRED.context.reason) ||
    hasReason(m, SELF_REGISTRATION_DISABLED.context.reason)
  );
}

export function classifySignInFlow(
  flow: KratosFlow,
  flowKind: SelfServiceFlowKind
): SignInState {
  const messages = allMessages(flow);

  if (
    messages.some(
      (m) =>
        m.id === POD_ACCESS_REQUIRED.id ||
        hasReason(m, POD_ACCESS_REQUIRED.context.reason)
    )
  ) {
    return {
      kind: "access_required",
      email: nodeValue(flow, "traits.email") ?? nodeValue(flow, "identifier"),
    };
  }

  if (
    messages.some(
      (m) =>
        m.id === SELF_REGISTRATION_DISABLED.id ||
        hasReason(m, SELF_REGISTRATION_DISABLED.context.reason)
    )
  ) {
    return { kind: "self_registration_disabled" };
  }

  const linkMessage = messages.find(
    (m) => typeof m.id === "number" && KRATOS_ACCOUNT_LINK_ID_SET.has(m.id)
  );
  // Kratos also relabels the submit button (1010017 "Sign in and link"), so a
  // re-rendered flow whose banner was replaced by a password error still reads
  // as linking.
  const linkLabel = flow.ui.nodes.some(
    (n) =>
      typeof n.meta?.label?.id === "number" &&
      KRATOS_ACCOUNT_LINK_ID_SET.has(n.meta.label.id)
  );
  if (flowKind === "login" && (linkMessage || linkLabel)) {
    return {
      kind: "account_link",
      email:
        stringValue(linkMessage?.context?.duplicateIdentifier) ??
        stringValue(linkMessage?.context?.duplicate_identifier) ??
        nodeValue(flow, "identifier"),
    };
  }

  // pod-admin has no sign-up form: Kratos' registration ui_url points at
  // /login, so a registration flow with no error of its own is someone who
  // opened sign-up directly. Any other error keeps the existing banner.
  if (
    flowKind === "registration" &&
    !messages.some((m) => m.type === "error")
  ) {
    return { kind: "self_registration_disabled" };
  }

  return { kind: "none" };
}
