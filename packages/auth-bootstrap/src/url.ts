/**
 * Pod URL validation + normalization.
 *
 * `podUrl` is attacker-influenceable in multi-tenant / portal contexts, and the
 * bootstrap helpers POST bearer tokens to it — so every credential-bearing call
 * validates the URL first. Without this a caller could be coaxed into sending a
 * handshake JWT or provisioning token to an arbitrary host.
 */

import { AuthBootstrapError } from "./errors.js";

export interface AssertValidPodUrlOptions {
  /** Allow `http://` (intended for localhost / local-mode dev only). Default false. */
  allowHttp?: boolean;
}

/** Strip a single trailing slash. */
export function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * Throws `AuthBootstrapError(status:0)` if `url` is not a valid http(s) pod
 * origin: must parse, be `https:` (or `http:` when `allowHttp`), and carry no
 * embedded credentials.
 */
export function assertValidPodUrl(
  url: string,
  opts: AssertValidPodUrlOptions = {}
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AuthBootstrapError(`Invalid pod URL: ${url}`, 0, {
      code: "INVALID_POD_URL",
    });
  }
  if (parsed.username || parsed.password) {
    throw new AuthBootstrapError(
      "Pod URL must not contain embedded credentials",
      0,
      { code: "INVALID_POD_URL" }
    );
  }
  const isHttps = parsed.protocol === "https:";
  const isHttp = parsed.protocol === "http:";
  if (!isHttps && !(isHttp && opts.allowHttp)) {
    throw new AuthBootstrapError(
      `Pod URL must use https:// (got ${parsed.protocol}//)`,
      0,
      { code: "INSECURE_POD_URL" }
    );
  }
}
