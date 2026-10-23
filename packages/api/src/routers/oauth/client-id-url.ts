/**
 * The URL rules for a Client ID Metadata Document `client_id` (spec 17 §6.1),
 * with no I/O, so every door that STORES or CHECKS a client_id applies the same
 * rule as /authorize: `client-metadata.ts` (the one place the document is
 * fetched) and the workspace primary-surface schema (`podApp.clientId`, spec 17
 * §7.1, PB7). Kept out of `client-metadata.ts` so a zod schema can import it
 * without loading the store and the fetch.
 */

import { isIP } from "node:net";

export const CIMD_MAX_URL_LENGTH = 512;

/**
 * Why a client_id URL or its document was refused. The message is shown to the
 * USER on the pod (phase 1 of /authorize): there is no verified redirect_uri to
 * send it to yet.
 */
export class ClientMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientMetadataError";
  }
}

/**
 * Does this client_id name a metadata document rather than a DCR row? Any
 * absolute-URL shape goes down the CIMD path, so an `http://` id is refused
 * with a reason instead of reading as an unknown DCR id. DCR ids are
 * `dcr_<base64url>` and never contain `:`.
 */
export function isClientMetadataUrl(clientId: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(clientId);
}

/**
 * The URL rules for a CIMD client_id. Returns the parsed URL.
 *
 * Canonical form is REQUIRED (the WHATWG serialization must equal the input):
 * `HTTPS://Studio.example.com/a` and `https://studio.example.com/a` would
 * otherwise be two client_ids, two cache rows and two consent histories for one
 * document.
 */
export function assertClientMetadataUrl(
  clientId: string,
  issuer: string | null
): URL {
  if (clientId.length > CIMD_MAX_URL_LENGTH) {
    throw new ClientMetadataError(
      `client_id URL is longer than ${CIMD_MAX_URL_LENGTH} characters`
    );
  }
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new ClientMetadataError("client_id is not an absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new ClientMetadataError("client_id URL must use https");
  }
  if (url.username || url.password) {
    throw new ClientMetadataError("client_id URL must not contain credentials");
  }
  if (url.search || clientId.includes("?")) {
    throw new ClientMetadataError("client_id URL must not contain a query");
  }
  if (url.hash || clientId.includes("#")) {
    throw new ClientMetadataError("client_id URL must not contain a fragment");
  }
  // The raw path, before the parser resolves them away.
  const rawPath = clientId
    .slice(clientId.indexOf("//") + 2)
    .replace(/^[^/]*/, "");
  if (rawPath.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new ClientMetadataError(
      "client_id URL must not contain . or .. path segments"
    );
  }
  if (url.pathname === "/" || url.pathname === "") {
    throw new ClientMetadataError("client_id URL must have a path");
  }
  if (url.href !== clientId) {
    throw new ClientMetadataError(
      `client_id URL is not in canonical form (expected ${url.href})`
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    throw new ClientMetadataError("client_id URL must use a domain name");
  }
  if (issuer && url.origin === new URL(issuer).origin) {
    throw new ClientMetadataError("client_id URL must not be on this pod");
  }
  return url;
}
