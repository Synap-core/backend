/**
 * Which https origins may `/connect` deliver a freshly minted key to?
 *
 * A connect link may carry an `issuer_assertion` (a JWT from the control
 * plane) so the CP-MCP / Raycast callbacks need no per-pod env. Its `iss` is
 * read WITHOUT verifying the signature, so on its own it proves nothing: a
 * forged `iss=https://attacker.example` would turn the allowlist into a key
 * exfiltration path once a signed-in operator clicks Approve. It therefore
 * widens the allowlist ONLY when it equals the pod's APPROVED Synap Cloud
 * issuer (`trusted_issuers`, as reported by GET /api/federation/discovery) —
 * the one origin the owner already trusts to sign people in.
 */

/** Normalize an https origin to a SAFE prefix: `https://host/` (trailing slash).
 * Without the slash, `startsWith("https://api.synap.live")` would also match
 * `https://api.synap.live.evil.com` — a prefix-confusion hole. The slash pins it
 * to paths UNDER that exact origin. */
export function toOriginPrefix(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") return null;
    return `${u.origin}/`;
  } catch {
    return null;
  }
}

/** The assertion's `iss` origin, if — and only if — it is the approved issuer. */
export function approvedIssuerRedirectPrefix(
  issuerAssertion: string,
  approvedIssuerUrl: string | null
): string | null {
  if (!issuerAssertion || !approvedIssuerUrl) return null;
  const approved = toOriginPrefix(approvedIssuerUrl);
  if (!approved) return null;
  try {
    const payload = issuerAssertion.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as {
      iss?: unknown;
    };
    const claimed =
      typeof claims.iss === "string" ? toOriginPrefix(claims.iss) : null;
    return claimed === approved ? claimed : null;
  } catch {
    return null;
  }
}
