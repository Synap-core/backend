/**
 * The page /authorize shows when it refuses a request at phase 1 (review
 * ui-flow P0-4): the client or its redirect_uri is not verified, so the answer
 * goes to the PERSON and is never redirected (RFC 6749 §4.1.2.1). It used to
 * be a bare `text/plain` line with no way back.
 *
 * It names the pod, says in one sentence why, says what to do, and offers
 * "Go back" through `history.back()`: the only way back that trusts nothing
 * the request carried. It has no link: every URL in the request is unverified
 * at this point. The message is the pod's own, but parts of it come from the
 * request (a host, a document's error), so every value is escaped.
 */

import type { AuthorizeRefusal } from "./consent.js";

interface RefusalCopy {
  title: string;
  /** What the person can do about it. */
  next: string;
}

const BROKEN_LINK: RefusalCopy = {
  title: "This sign-in link doesn't work",
  next: "Go back to the app and start again. If it keeps happening, the app's developer needs to fix how it connects.",
};

const COPY: Record<AuthorizeRefusal, RefusalCopy> = {
  client_id_missing: BROKEN_LINK,
  unknown_client: BROKEN_LINK,
  redirect_uri_missing: BROKEN_LINK,
  redirect_uri_mismatch: BROKEN_LINK,
  unverified_apps_off: {
    title: "Your pod doesn't allow this app",
    next: "Only your pod admin can change this.",
  },
  app_description_unreadable: {
    title: "This app couldn't be checked",
    next: "Try again in a few minutes. If it keeps happening, the app's developer needs to fix its description.",
  },
  app_cannot_sign_in: {
    title: "This app can't sign anyone in here",
    next: "Ask the member who added the app to this pod to check that it is still approved.",
  },
  pod_unconfigured: {
    title: "This pod can't sign anyone in yet",
    next: "Tell your pod admin: the pod's public address is not set.",
  },
  // Refused on the consent screen, not at /authorize; kept so every reason
  // has a page.
  no_shared_space: { title: "This app can't connect for you", next: "" },
  nothing_to_give: { title: "This app can't connect", next: "" },
  grant_changed: { title: "This request changed", next: "" },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderAuthorizeRefusalPage(input: {
  /** This pod's host (the issuer's), the one the person can trust. */
  podHost: string;
  reason: AuthorizeRefusal;
  /** The pod's sentence: `AuthorizeUserError.message`. */
  message: string;
}): string {
  const copy = COPY[input.reason];
  const next = copy.next ? `<p>${escapeHtml(copy.next)}</p>` : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${escapeHtml(copy.title)}</title>` +
    `<style>` +
    `:root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--fg:#18181b;--muted:#52525b;--line:#e4e4e7;--btn:#18181b;--btn-fg:#fff}` +
    `@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--card:#141416;--fg:#f4f4f5;--muted:#a1a1aa;--line:#27272a;--btn:#f4f4f5;--btn-fg:#18181b}}` +
    `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
    `background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}` +
    `main{box-sizing:border-box;width:100%;max-width:28rem;margin:16px;padding:32px;` +
    `background:var(--card);border:1px solid var(--line);border-radius:12px}` +
    `.pod{margin:0 0 16px;font-size:14px;color:var(--muted)}` +
    `h1{margin:0 0 12px;font-size:20px;line-height:1.3}` +
    `p{margin:0 0 12px;overflow-wrap:anywhere}` +
    `button{margin-top:12px;min-height:44px;padding:0 20px;border:0;border-radius:8px;` +
    `background:var(--btn);color:var(--btn-fg);font:inherit;font-weight:500;cursor:pointer}` +
    `button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}` +
    `</style></head><body><main>` +
    `<p class="pod">${escapeHtml(input.podHost)}</p>` +
    `<h1>${escapeHtml(copy.title)}</h1>` +
    `<p>${escapeHtml(input.message)}</p>` +
    next +
    `<button type="button" id="back" onclick="history.back()">Go back</button>` +
    // Opened in a fresh tab, there is nowhere to go back to.
    `<script>if(history.length<2)document.getElementById("back").hidden=true</script>` +
    `</main></body></html>`
  );
}
