/**
 * The page /authorize shows when it refuses a request at phase 1 (review
 * ui-flow P0-4): the client or its redirect_uri is not verified, so the answer
 * goes to the PERSON and is never redirected (RFC 6749 §4.1.2.1). It used to
 * be a bare `text/plain` line with no way back.
 *
 * It names the pod, says in one sentence what happened and what to do, and
 * offers "Go back" through `history.back()`: the only way back that trusts
 * nothing the request carried. The pod's own sentence (`AuthorizeUserError`'s
 * message, often a protocol string) is a muted detail for the app's developer
 * (review U7). It has no link: every URL in the request is unverified
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
  // Sign-in step-ups, not refusals: the consent screen signs the person in
  // again (`toConsentTrpcError`).
  login_required: { title: "Sign in again", next: "" },
  pod_credential_required: { title: "Confirm it's you", next: "" },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * pod-admin's receiver look (apps/pod-admin/app/_lib/receiver-shell.tsx and
 * its tailwind theme), as values: this page is plain HTML. The same values
 * as the control plane's pod chooser (`CHOOSER_THEME`, connect-pod.ts), so the
 * hop between the two and the pod's consent reads as one product. `--muted`
 * is foreground/70 and the light accent emerald-700: pod-admin's /60-/65 and
 * emerald-500 fail AA here.
 */
const THEME = {
  light: {
    bg: "#FAF9F6",
    fg: "#1A1A19",
    muted: "#5B5A59",
    card: "#F1F0ED",
    edge: "#E4E3E0",
    row: "#FFFFFF",
    line: "#85827A",
    "line-strong": "#1A1A19",
    accent: "#047857",
    "on-accent": "#FFFFFF",
    bloom:
      "radial-gradient(60% 50% at 50% -10%,rgba(16,185,129,.05) 0%,transparent 70%)",
  },
  dark: {
    bg: "#0B0C0A",
    fg: "#ECECEA",
    muted: "#ABACA9",
    card: "#141513",
    edge: "#222220",
    row: "#1B1E22",
    line: "#6B6F77",
    "line-strong": "#ECECEA",
    accent: "#34D399",
    "on-accent": "#062418",
    bloom:
      "radial-gradient(70% 55% at 50% -10%,rgba(52,211,153,.08) 0%,transparent 70%)",
  },
} as const;

const tokens = (theme: Record<string, string>) =>
  Object.entries(theme)
    .map(([name, value]) => `--${name}:${value}`)
    .join(";");

const MONO =
  'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace';

const CSS =
  `:root{color-scheme:light;${tokens(THEME.light)}}` +
  `@media (prefers-color-scheme:dark){:root{color-scheme:dark;${tokens(THEME.dark)}}}` +
  `*{box-sizing:border-box}` +
  `html{-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;text-size-adjust:100%}` +
  `body{margin:0;min-height:100vh;min-height:100dvh;padding:48px 16px;color:var(--fg);` +
  `background:var(--bg) var(--bloom) no-repeat fixed;` +
  `font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}` +
  `.shell{width:100%;max-width:28rem;margin:0 auto;display:flex;flex-direction:column;gap:16px}` +
  `.brand{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:0 4px;font-size:13px;line-height:20px}` +
  `.brand-id{display:flex;align-items:center;gap:8px;font-weight:500;letter-spacing:-.01em}` +
  `.mark{display:flex;width:20px;height:20px;align-items:center;justify-content:center;border-radius:6px;` +
  `background:var(--accent);color:var(--on-accent);font-size:10px;font-weight:600}` +
  `.host{font-family:${MONO};font-size:12px;color:var(--muted);overflow-wrap:normal;word-break:normal}` +
  `.host>span{display:inline-block;max-width:100%;overflow-wrap:anywhere}` +
  `.card{display:flex;flex-direction:column;gap:16px;padding:28px;border:1px solid var(--edge);border-radius:16px;background:var(--card)}` +
  `@media (max-width:420px){body{padding-top:32px}.card{padding:20px}}` +
  `h1{margin:0;font-size:18px;font-weight:600;line-height:1.35;letter-spacing:-.01em;text-wrap:balance}` +
  `p{margin:0;text-wrap:pretty}` +
  `button{align-self:flex-start;min-height:44px;padding:8px 16px;border:1px solid var(--line);border-radius:12px;` +
  `background:transparent;color:var(--fg);font:inherit;font-weight:500;cursor:pointer}` +
  `button:hover{border-color:var(--line-strong);background:var(--row)}` +
  `button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}` +
  `.detail{display:flex;flex-direction:column;gap:2px;padding-top:12px;border-top:1px solid var(--edge);color:var(--muted);font-size:12px}` +
  `.detail code{font-family:${MONO};overflow-wrap:anywhere}`;

/**
 * The host one label to a unit, as pod-admin's `HostName` and the chooser's
 * `hostHtml`: a line breaks only after a dot (never after a hyphen), and only
 * a label wider than the line wraps inside itself.
 */
function hostHtml(host: string): string {
  const labels = host.split(".");
  return `<span class="host" translate="no">${labels
    .map(
      (label, i) =>
        `<span>${escapeHtml(label)}${i < labels.length - 1 ? "." : ""}</span>`
    )
    .join("<wbr>")}</span>`;
}

export function renderAuthorizeRefusalPage(input: {
  /** This pod's host (the issuer's), the one the person can trust. */
  podHost: string;
  reason: AuthorizeRefusal;
  /** The pod's sentence: `AuthorizeUserError.message`. */
  message: string;
}): string {
  const copy = COPY[input.reason];
  // The person reads the title and what to do; the pod's own sentence (often
  // a protocol string: "Unknown client_id") is for the app's developer.
  const next = copy.next ? `<p>${escapeHtml(copy.next)}</p>` : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${escapeHtml(copy.title)} · ${escapeHtml(input.podHost)}</title>` +
    `<style>${CSS}</style></head><body><main class="shell">` +
    `<header class="brand"><span class="brand-id"><span class="mark" aria-hidden="true">S</span>Synap</span>` +
    `${hostHtml(input.podHost)}</header>` +
    `<div class="card">` +
    `<h1>${escapeHtml(copy.title)}</h1>` +
    next +
    `<button type="button" id="back" onclick="history.back()">Go back</button>` +
    // Opened in a fresh tab, there is nowhere to go back to.
    `<script>if(history.length<2)document.getElementById("back").hidden=true</script>` +
    `<div class="detail"><p>Details for the app's developer</p>` +
    `<p><code>${escapeHtml(input.message)}</code></p></div>` +
    `</div></main></body></html>`
  );
}
