"use client";

declare global {
  interface Window {
    __SYNAP_POD_ADMIN_RUNTIME__?: { podUrl?: unknown };
  }
}

export const POD_PUBLIC_URL_CONFIGURATION_ERROR =
  "This Pod Admin is not configured with the Pod's secure API URL. A Pod owner needs to set PUBLIC_URL to the Pod's HTTPS address and restart Pod Admin.";

function canonicalPublicPodUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const localHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !localHttp) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Public Pod API origin injected by the Pod Admin server at request time.
 *
 * Next's NEXT_PUBLIC_* values are build-time substitutions, so they cannot be
 * trusted for a reusable image whose Pod hostname changes at claim/restore.
 * The server-owned runtime value keeps browser clients generic and lets Caddy,
 * Kratos and API configuration share PUBLIC_URL as their single source.
 */
export function publicPodUrl(): string {
  // Client components are server-rendered too. Returning the same
  // request-time value that the root layout injects avoids a blank API origin
  // in server-rendered links followed by a hydration mismatch in the browser.
  if (typeof window === "undefined") {
    return canonicalPublicPodUrl(process.env.POD_PUBLIC_URL) ?? "";
  }
  const configured = canonicalPublicPodUrl(
    window.__SYNAP_POD_ADMIN_RUNTIME__?.podUrl
  );
  // Pod Admin is deliberately a different origin from the Pod API. Falling
  // back to window.location would send Kratos requests back to this Next app,
  // which returns HTML and turns a deployment error into a JSON parse error.
  return configured ?? "";
}
