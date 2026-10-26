/**
 * Two of the three ways an invited person makes their account on this pod
 * (join plan phase 4, decision B2), both through a Kratos REGISTRATION flow
 * that carries the invite in `transient_payload.invite_token`:
 *
 *   - a passkey: the pod's registration gate lets the flow through only for
 *     the invited email, and its `/complete` hook accepts the invite; Kratos'
 *     session hook signs the person in;
 *   - Synap Cloud: the browser leaves for Synap Cloud and comes back to
 *     `returnTo`; the gate also needs Synap Cloud to have verified the email.
 *
 * The third way, a password, is the pod's own `/setup/accept-invite`
 * (`AcceptForm.tsx` RegisterPanel). Kratos v1.3.1 registers in two steps by
 * default: the traits first (`method: "profile"`), then the credential; a flow
 * that already shows the passkey data (one-step config) skips the first.
 */
import {
  collectErrorMessages,
  nodeValue,
  type CreateFlowResult,
  type KratosFlow,
  type SubmitFlowResult,
} from "../../../lib/kratos-flow";
import { PasskeyCancelled } from "../../../lib/passkey";

export type JoinOutcome =
  /** The account exists and the invite is accepted. */
  | { kind: "joined"; signedIn: boolean }
  /** Synap Cloud: send the browser here; it comes back to `returnTo`. */
  | { kind: "redirect"; to: string }
  /** The person closed the passkey prompt: nothing to report. */
  | { kind: "cancelled" }
  /** This browser is already signed in: the page re-reads who. */
  | { kind: "signed-in" }
  /** Refused or failed, in words the person can act on. */
  | { kind: "refused"; message: string };

export interface JoinDeps {
  createFlow(returnTo: string): Promise<CreateFlowResult>;
  submit(
    flow: KratosFlow,
    body: Record<string, unknown>
  ): Promise<SubmitFlowResult>;
  createPasskey(
    createData: string,
    person: { name: string; displayName?: string }
  ): Promise<string>;
}

export const JOIN_FAILED =
  "Joining did not work. Try again, or choose another way.";
const PASSKEY_UNAVAILABLE =
  "This pod can't create a passkey right now. Choose another way.";

function refusedBy(flow: KratosFlow): JoinOutcome {
  const messages = collectErrorMessages(flow);
  return { kind: "refused", message: messages.join(" ") || JOIN_FAILED };
}

/** A submit's answer when it is not the one the step expected. */
function unexpected(result: SubmitFlowResult): JoinOutcome {
  if (result.kind === "flow") return refusedBy(result.flow);
  if (result.kind === "error") {
    return { kind: "refused", message: result.error.message || JOIN_FAILED };
  }
  return { kind: "refused", message: JOIN_FAILED };
}

async function startFlow(
  returnTo: string,
  deps: JoinDeps
): Promise<KratosFlow | JoinOutcome> {
  const started = await deps.createFlow(returnTo);
  if ("existingSession" in started) return { kind: "signed-in" };
  if ("signInRequired" in started)
    return { kind: "refused", message: JOIN_FAILED };
  return started.flow;
}

const csrf = (flow: KratosFlow) => nodeValue(flow, "csrf_token") ?? "";

export async function joinWithPasskey(
  input: { token: string; email: string; name?: string; returnTo: string },
  deps: JoinDeps
): Promise<JoinOutcome> {
  const started = await startFlow(input.returnTo, deps);
  if ("kind" in started) return started;
  let flow = started;
  const traits = {
    email: input.email,
    ...(input.name ? { name: input.name } : {}),
  };
  const transient_payload = { invite_token: input.token };

  if (nodeValue(flow, "passkey_create_data") === null) {
    const step = await deps.submit(flow, {
      method: "profile",
      csrf_token: csrf(flow),
      traits,
      transient_payload,
    });
    if (step.kind !== "flow") return unexpected(step);
    flow = step.flow;
  }
  const createData = nodeValue(flow, "passkey_create_data");
  if (!createData) {
    return collectErrorMessages(flow).length
      ? refusedBy(flow)
      : { kind: "refused", message: PASSKEY_UNAVAILABLE };
  }

  let passkey: string;
  try {
    passkey = await deps.createPasskey(createData, {
      name: input.email,
      displayName: input.name || input.email,
    });
  } catch (err) {
    if (err instanceof PasskeyCancelled) return { kind: "cancelled" };
    return {
      kind: "refused",
      message: err instanceof Error && err.message ? err.message : JOIN_FAILED,
    };
  }

  const done = await deps.submit(flow, {
    method: "passkey",
    csrf_token: csrf(flow),
    traits,
    passkey_register: passkey,
    transient_payload,
  });
  if (done.kind === "session") return { kind: "joined", signedIn: true };
  return unexpected(done);
}

export async function joinWithSynapCloud(
  input: { token: string; returnTo: string },
  deps: JoinDeps
): Promise<JoinOutcome> {
  const started = await startFlow(input.returnTo, deps);
  if ("kind" in started) return started;
  const sent = await deps.submit(started, {
    method: "oidc",
    provider: "cp",
    csrf_token: csrf(started),
    transient_payload: { invite_token: input.token },
  });
  if (sent.kind === "redirect") return { kind: "redirect", to: sent.to };
  return unexpected(sent);
}
