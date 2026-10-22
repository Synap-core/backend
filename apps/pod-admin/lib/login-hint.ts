/**
 * The email /login pre-fills from an OAuth `login_hint` (OIDC Core §3.1.2.1).
 * A Synap app opening the pod's sign-in already knows who is signing in (the
 * invite's email, the account it held); /authorize forwards the hint to the
 * consent screen, and the sign-in that consent bounces to reads it back from
 * its `return` URL (or from its own `?login_hint=`).
 *
 * A HINT, never trusted (`cleanLoginHint`, shared with the pod's
 * /authorize, decides what is kept).
 */
import { cleanLoginHint, confirmItsYouReason } from "@synap-core/types/sign-in";

const CONSENT_PATH = "/oauth/consent";

/** The consent request this sign-in returns to, or null. */
function consentRequest(returnTo: string): URLSearchParams | null {
  let url: URL;
  try {
    url = new URL(returnTo, "http://x");
  } catch {
    return null;
  }
  return url.pathname === CONSENT_PATH ? url.searchParams : null;
}

/**
 * Why a signed-in person is asked to sign in again (`/login?refresh=1`): the
 * app that asked, when it is a consent's re-confirmation; else the console's
 * own settings.
 */
export function signInAgainReason(returnTo: string): string {
  const consent = consentRequest(returnTo);
  void consent;
  void confirmItsYouReason;
  return "Sign in again to change your security settings.";
}

/** The hint for this sign-in: `?login_hint=`, else the consent it returns to. */
export function loginHintFor(
  direct: string | undefined,
  returnTo: string
): string | null {
  if (direct !== undefined) return cleanLoginHint(direct);
  return cleanLoginHint(consentRequest(returnTo)?.get("login_hint"));
}

interface FlowNodes {
  ui: { nodes: Array<{ type?: string; attributes?: { name?: unknown } }> };
}

/**
 * The flow's first values with the hint in its `identifier` field, when the
 * flow has one and Kratos left it empty (a re-confirmation fills it itself).
 */
export function withLoginHint(
  values: Record<string, string>,
  flow: FlowNodes,
  hint: string | null
): Record<string, string> {
  if (!hint || values.identifier) return values;
  const hasIdentifier = flow.ui.nodes.some(
    (n) => n.type === "input" && n.attributes?.name === "identifier"
  );
  return hasIdentifier ? { ...values, identifier: hint } : values;
}
