/**
 * "Link Synap Cloud": the pod console's half of the Control Plane's
 * claim-access hop (join plan phase 4, decision 2 of 2026-10-23). The CP half
 * is `synap-control-plane-api` `src/routes/claim-access-hop.ts`.
 *
 *   /link-cloud                 → the CP's confirm page (`claimAccessStartUrl`)
 *   CP → /link-cloud#intent=…&assertion=…
 *                               → POST the assertion to this pod's
 *                                 identity-link door (`linkThisPod`), then the
 *                                 CP's finish page with the receipt
 *                                 (`claimAccessFinishUrl`)
 *   CP → /link-cloud#linked     → done
 *   CP → /link-cloud#cancelled  → not linked
 *
 * Both CP addresses are built from THIS pod's Synap Cloud issuer (discovery),
 * never from the fragment: a forged link cannot make this page hand a receipt
 * to anyone but the pod's own Synap Cloud. The fragment is read once and
 * cleared by the page (`history.replaceState`); nothing here logs it.
 */

export type LinkCloudFragment =
  | { kind: "start" }
  | { kind: "ceremony"; intentId: string; assertion: string }
  | { kind: "linked" }
  | { kind: "cancelled" }
  | { kind: "broken" };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the CP sent this page, from `location.hash` (with or without `#`). */
export function readLinkCloudFragment(hash: string): LinkCloudFragment {
  const raw = hash.replace(/^#/, "");
  if (!raw) return { kind: "start" };
  if (raw === "linked") return { kind: "linked" };
  if (raw === "cancelled") return { kind: "cancelled" };
  const params = new URLSearchParams(raw);
  const intentId = params.get("intent") ?? "";
  const assertion = params.get("assertion") ?? "";
  if (intentId.length > 0 && assertion.length > 0 && UUID_RE.source.length > 0) {
    return { kind: "ceremony", intentId, assertion };
  }
  return { kind: "broken" };
}

/** The Synap Cloud issuer's origin, or null when it is not an https origin. */
function issuerOrigin(issuerUrl: string): string | null {
  try {
    const url = new URL(issuerUrl);
    return url.origin;
  } catch {
    return null;
  }
}

/** The CP page that asks "Link <your account> to <this pod>?". */
export function claimAccessStartUrl(
  issuerUrl: string,
  podUrl: string
): string | null {
  const origin = issuerOrigin(issuerUrl);
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(podUrl).hostname;
  } catch {
    return null;
  }
  return `${origin}/pods/claim-access/start?${new URLSearchParams({ pod: host })}`;
}

/** The CP page that records the link, the receipt in its fragment. */
export function claimAccessFinishUrl(
  issuerUrl: string,
  intentId: string,
  receiptId: string
): string | null {
  const origin = issuerOrigin(issuerUrl);
  if (!origin) return null;
  return `${origin}/pods/claim-access/finish?${new URLSearchParams({
    intent: intentId,
    receipt: receiptId,
  })}`;
}

export type LinkThisPodResult =
  | { ok: true; receiptId: string }
  | {
      ok: false;
      reason:
        | "signed_out"
        | "turned_off"
        | "assertion_refused"
        | "already_linked_elsewhere"
        | "failed";
      /** For "Copy details" only, never the sentence. */
      detail: string;
    };

/**
 * This pod's identity-link door (`POST /api/federation/identity-links`): the
 * signed-in person proves their pod session; the pod binds the Synap Cloud
 * account named in the assertion and returns a one-time receipt.
 */
export async function linkThisPod(
  podUrl: string,
  assertion: string,
  fetchImpl: typeof fetch = fetch
): Promise<LinkThisPodResult> {
  let res: Response;
  try {
    res = await fetchImpl(
      `${podUrl.replace(/\/$/, "")}/api/federation/identity-links`,
      {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ assertion }),
      }
    );
  } catch {
    return { ok: false, reason: "failed", detail: "network" };
  }
  const body = (await res.json().catch(() => null)) as {
    receiptId?: unknown;
    code?: unknown;
    error?: unknown;
    reason?: unknown;
  } | null;
  if (res.ok && typeof body?.receiptId === "string") {
    return { ok: true, receiptId: body.receiptId };
  }
  const detail =
    `${res.status} ${typeof body?.error === "string" ? body.error : ""}`.trim();
  // The session middleware's 401 (`@synap/auth` ory-middleware).
  if (res.status === 401 && body?.error === "Unauthorized") {
    return { ok: false, reason: "signed_out", detail };
  }

  // Signed in, yet the door refused the assertion: its verified email is not
  // this pod account's email, or it took longer than its few minutes.
  if (res.status === 401) {
    return { ok: false, reason: "assertion_refused", detail };
  }
  if (res.status === 409) {
    return { ok: false, reason: "already_linked_elsewhere", detail };
  }
  return { ok: false, reason: "failed", detail };
}
