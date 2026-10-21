/**
 * The email /login pre-fills from an OAuth `login_hint` (OIDC Core §3.1.2.1).
 * A Synap app opening the pod's sign-in already knows who is signing in (the
 * invite's email, the account it held); /authorize forwards the hint to the
 * consent screen, and the sign-in that consent bounces to reads it back from
 * its `return` URL (or from its own `?login_hint=`).
 *
 * A HINT, never trusted: the person can change it, and Kratos checks the
 * password against whatever is typed. Trimmed, at most an email's length,
 * no control characters; anything else is ignored.
 */
const CONSENT_PATH = "/oauth/consent";
const MAX_LENGTH = 254;

function clean(raw: string | null | undefined): string | null {
  const hint = raw?.trim();
  if (!hint || hint.length > MAX_LENGTH) return null;
  // eslint-disable-next-line no-control-regex -- control characters are refused
  if (/[\u0000-\u001f\u007f]/.test(hint)) return null;
  return hint;
}

/** The hint for this sign-in: `?login_hint=`, else the consent it returns to. */
export function loginHintFor(
  direct: string | undefined,
  returnTo: string
): string | null {
  if (direct !== undefined) return clean(direct);
  let url: URL;
  try {
    url = new URL(returnTo, "http://x");
  } catch {
    return null;
  }
  if (url.pathname !== CONSENT_PATH) return null;
  return clean(url.searchParams.get("login_hint"));
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
