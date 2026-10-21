/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document):
 * how a POD APP identifies itself to this authorization server (spec 17 §6.1,
 * founder decision F1).
 *
 * The app's `client_id` is an https URL on the app's own domain, and the JSON
 * document at that URL is its registration. Identity = the domain, proven by
 * the fact that the app controls what is served there; nothing is registered
 * per pod. DCR (`/register`) stays for MCP clients (claude.ai registers before
 * any user is known) and is untouched here.
 *
 * SECURITY — the pod fetches a URL a stranger chose, at an unauthenticated
 * endpoint. That is a confused-deputy surface (T4) and an amplification surface
 * (T11), so this module is the ONLY place a client URL is ever fetched, and the
 * fetch is the codebase's SSRF-safe one:
 *   - the URL itself: https, no userinfo / query / fragment / dot segments,
 *     already in canonical form, ≤ 512 chars, not an IP literal, not this pod;
 *   - `resolvePublicIssuerEndpoint` refuses local hostnames and any DNS answer
 *     that is not publicly routable, and `pinnedHttpsGet` connects to the IP it
 *     checked (no second lookup, no rebinding window);
 *   - no redirect followed, 5 s for the whole exchange, 5 KB, application/json;
 *   - at most one fetch in flight per client_id, and the validated document is
 *     cached in `oauth_clients` (fresh for its Cache-Control, floored at 5 min,
 *     capped at 24 h).
 *
 * The document is then validated as a whole before anything is cached: its
 * `client_id` must equal the URL byte for byte (a document cannot speak for
 * another URL), every `redirect_uri` is https on the SAME ORIGIN as the
 * client_id (Synap policy, stricter than the draft: the code can only ever go
 * back to the domain that is the app's identity), and the client is public
 * (`token_endpoint_auth_method` "none", no `client_secret*`).
 */

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { createLogger } from "@synap-core/core";
import {
  GRANT_ACTIONS,
  InvalidPermissionError,
  parsePermission,
} from "@synap/governance-policy/grants";

import {
  resolvePublicIssuerEndpoint,
  type IssuerDnsLookup,
} from "../../utils/issuer-url-safety.js";
import { pinnedHttpsGet } from "../../utils/pinned-https-get.js";
import { OAUTH_SUPPORTED_SCOPES, normalizeRequestedScopes } from "./config.js";
import { parseScopeParam } from "./protocol.js";
import {
  findClient,
  upsertCimdClient,
  type CimdClientInput,
  type StoredClient,
} from "./store.js";

/** See the `: any` rationale in hub-protocol/rest/_shared.ts (TS2742). */
const logger: any = createLogger({ module: "pod-oauth-cimd" });

export const CIMD_MAX_URL_LENGTH = 512;
export const CIMD_MAX_BYTES = 5 * 1024;
export const CIMD_TIMEOUT_MS = 5_000;
/** Fresh window bounds for a cached document. */
export const CIMD_MIN_TTL_MS = 5 * 60 * 1000;
export const CIMD_MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** A copy this young is used when a refresh FAILS to fetch (not when invalid). */
export const CIMD_STALE_GRACE_MS = 24 * 60 * 60 * 1000;

const CIMD_MAX_REDIRECT_URIS = 8;
const CIMD_MAX_CLIENT_NAME_LENGTH = 100;
const CIMD_MAX_REQUESTS = 32;
const CIMD_MAX_REASON_LENGTH = 200;
const CIMD_MAX_TEMPLATES = 8;
/** A Contract B workspace-template slug (`ensureTemplate`). */
const TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9._/-]{0,99}$/;

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

/** The document could not be READ (network, status, size, type). */
class ClientMetadataFetchError extends ClientMetadataError {}

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

/** What a valid document contributes to the `oauth_clients` cache row. */
export interface ValidatedClientMetadataDocument {
  clientName: string;
  redirectUris: string[];
  /** `scope` ∩ the scopes this AS supports (`mcp.*`). */
  scopes: string[];
  /** `synap_requests[].permission`, grant grammar. */
  requestedPermissions: string[];
  /** `synap_templates`: workspace-template slugs the consent may offer. */
  requestedTemplates: string[];
  clientUri: string | null;
  initiateLoginUri: string | null;
}

function sameOriginHttpsUrl(
  value: unknown,
  origin: string,
  field: string
): string {
  if (typeof value !== "string") {
    throw new ClientMetadataError(`${field} must be a string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ClientMetadataError(`${field} is not an absolute URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new ClientMetadataError(`${field} must use https`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new ClientMetadataError(
      `${field} must not contain credentials or a fragment`
    );
  }
  if (parsed.origin !== origin) {
    throw new ClientMetadataError(
      `${field} must be on the same origin as the client_id (${origin})`
    );
  }
  return value;
}

/**
 * One `synap_requests[].permission`: a valid grant-grammar pattern, no `*` in
 * the subject or the action, and only the plain actions (read/create/update/
 * delete). Governance gate verbs (approve, merge, purge, …) are refused: an app
 * that asks to approve its own proposals is asking to leave the governed path.
 * A `*` kind (`entity.*.read`) is the same as `entity.read` and is allowed.
 */
function assertAppPermission(permission: string): void {
  let segs: string[];
  try {
    segs = parsePermission(permission);
  } catch (err) {
    if (err instanceof InvalidPermissionError) {
      throw new ClientMetadataError(`synap_requests: ${err.message}`);
    }
    throw err;
  }
  const subject = segs[0];
  const action = segs[segs.length - 1];
  if (subject === "*" || action === "*" || segs.length < 2) {
    throw new ClientMetadataError(
      `synap_requests: "${permission}" must name a subject and an action`
    );
  }
  if (!(GRANT_ACTIONS as readonly string[]).includes(action!)) {
    throw new ClientMetadataError(
      `synap_requests: "${permission}" asks for "${action}", which an app cannot be granted`
    );
  }
}

/** Validate a fetched document against the URL it was fetched from. */
export function validateClientMetadataDocument(
  doc: unknown,
  clientId: string
): ValidatedClientMetadataDocument {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new ClientMetadataError("the document is not a JSON object");
  }
  const d = doc as Record<string, unknown>;
  const origin = new URL(clientId).origin;

  if (d.client_id !== clientId) {
    throw new ClientMetadataError(
      "the document's client_id does not equal the URL it was served from"
    );
  }

  // ── public client only ───────────────────────────────────────────────────
  if (Object.keys(d).some((k) => k.startsWith("client_secret"))) {
    throw new ClientMetadataError(
      "the document declares a client secret; only public clients (PKCE) are supported"
    );
  }
  if (
    d.token_endpoint_auth_method !== undefined &&
    d.token_endpoint_auth_method !== "none"
  ) {
    throw new ClientMetadataError(
      'token_endpoint_auth_method must be "none" (public client + PKCE)'
    );
  }
  if (d.grant_types !== undefined) {
    if (
      !Array.isArray(d.grant_types) ||
      !d.grant_types.every(
        (g) => g === "authorization_code" || g === "refresh_token"
      ) ||
      !d.grant_types.includes("authorization_code")
    ) {
      throw new ClientMetadataError(
        "grant_types must include authorization_code and nothing but refresh_token besides"
      );
    }
  }
  if (d.response_types !== undefined) {
    if (
      !Array.isArray(d.response_types) ||
      d.response_types.some((t) => t !== "code")
    ) {
      throw new ClientMetadataError('response_types must be ["code"]');
    }
  }

  // ── redirect_uris: https, same origin as the client_id ───────────────────
  if (!Array.isArray(d.redirect_uris) || d.redirect_uris.length === 0) {
    throw new ClientMetadataError(
      "redirect_uris is required and must be a non-empty array"
    );
  }
  if (d.redirect_uris.length > CIMD_MAX_REDIRECT_URIS) {
    throw new ClientMetadataError(
      `at most ${CIMD_MAX_REDIRECT_URIS} redirect_uris are accepted`
    );
  }
  const redirectUris = d.redirect_uris.map((u) =>
    sameOriginHttpsUrl(u, origin, "redirect_uri")
  );

  // ── display + links ──────────────────────────────────────────────────────
  let clientName = new URL(clientId).host;
  if (d.client_name !== undefined) {
    if (typeof d.client_name !== "string" || d.client_name.trim() === "") {
      throw new ClientMetadataError("client_name must be a non-empty string");
    }
    if (d.client_name.trim().length > CIMD_MAX_CLIENT_NAME_LENGTH) {
      throw new ClientMetadataError(
        `client_name is longer than ${CIMD_MAX_CLIENT_NAME_LENGTH} characters`
      );
    }
    clientName = d.client_name.trim();
  }
  const clientUri =
    d.client_uri === undefined
      ? null
      : sameOriginHttpsUrl(d.client_uri, origin, "client_uri");
  const initiateLoginUri =
    d.initiate_login_uri === undefined
      ? null
      : sameOriginHttpsUrl(d.initiate_login_uri, origin, "initiate_login_uri");
  // `logo_uri` is deliberately ignored: no remote logo for unverified apps (T7).

  // ── what it may ask for ──────────────────────────────────────────────────
  if (d.scope !== undefined && typeof d.scope !== "string") {
    throw new ClientMetadataError("scope must be a space-delimited string");
  }
  const scopes = [
    ...new Set(
      normalizeRequestedScopes(
        parseScopeParam(d.scope as string | undefined)
      ).filter((s) => (OAUTH_SUPPORTED_SCOPES as readonly string[]).includes(s))
    ),
  ];

  const requestedPermissions: string[] = [];
  if (d.synap_requests !== undefined) {
    if (!Array.isArray(d.synap_requests)) {
      throw new ClientMetadataError("synap_requests must be an array");
    }
    if (d.synap_requests.length > CIMD_MAX_REQUESTS) {
      throw new ClientMetadataError(
        `at most ${CIMD_MAX_REQUESTS} synap_requests are accepted`
      );
    }
    for (const r of d.synap_requests) {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        throw new ClientMetadataError(
          "each synap_requests entry must be an object"
        );
      }
      const { permission, reason } = r as Record<string, unknown>;
      if (typeof permission !== "string") {
        throw new ClientMetadataError(
          "each synap_requests entry needs a permission string"
        );
      }
      if (
        reason !== undefined &&
        (typeof reason !== "string" || reason.length > CIMD_MAX_REASON_LENGTH)
      ) {
        throw new ClientMetadataError(
          `synap_requests reason must be a string of at most ${CIMD_MAX_REASON_LENGTH} characters`
        );
      }
      assertAppPermission(permission);
      if (!requestedPermissions.includes(permission)) {
        requestedPermissions.push(permission);
      }
    }
  }

  // ── spaces it can work in (doc 18): offered when the person has none ─────
  const requestedTemplates: string[] = [];
  if (d.synap_templates !== undefined) {
    if (!Array.isArray(d.synap_templates)) {
      throw new ClientMetadataError("synap_templates must be an array");
    }
    if (d.synap_templates.length > CIMD_MAX_TEMPLATES) {
      throw new ClientMetadataError(
        `at most ${CIMD_MAX_TEMPLATES} synap_templates are accepted`
      );
    }
    for (const slug of d.synap_templates) {
      if (typeof slug !== "string" || !TEMPLATE_SLUG_RE.test(slug)) {
        throw new ClientMetadataError(
          "each synap_templates entry must be a template slug (lowercase letters, digits, . _ / -)"
        );
      }
      if (!requestedTemplates.includes(slug)) requestedTemplates.push(slug);
    }
  }

  return {
    clientName,
    redirectUris,
    scopes,
    requestedPermissions,
    requestedTemplates,
    clientUri,
    initiateLoginUri,
  };
}

/**
 * How long a fetched document stays fresh: its `Cache-Control: max-age`,
 * floored at 5 min (so a client cannot make every /authorize a fetch) and
 * capped at 24 h (so a changed document is seen within a day). `no-store` /
 * `no-cache` and a missing header get the floor.
 */
export function cimdCacheTtlMs(cacheControl: string | undefined): number {
  const m = /(?:^|[,\s])max-age\s*=\s*"?(\d+)"?/i.exec(cacheControl ?? "");
  const seconds = m ? Number.parseInt(m[1]!, 10) : 0;
  return Math.min(
    CIMD_MAX_TTL_MS,
    Math.max(CIMD_MIN_TTL_MS, Number.isFinite(seconds) ? seconds * 1000 : 0)
  );
}

export interface FetchedClientMetadata {
  body: string;
  cacheControl: string | undefined;
}

export interface ClientMetadataDeps {
  /** DNS for `resolvePublicIssuerEndpoint` (tests inject one). */
  lookup?: IssuerDnsLookup;
  now?: () => number;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v.join(", ") : v;
}

/**
 * Fetch the document over the SSRF-safe channel. Throws a
 * `ClientMetadataFetchError` for anything that is not a 200 application/json
 * body of at most 5 KB delivered within 5 s.
 */
export async function fetchClientMetadata(
  url: URL,
  deps: ClientMetadataDeps = {}
): Promise<FetchedClientMetadata> {
  let target;
  try {
    target = await resolvePublicIssuerEndpoint(url.href, deps.lookup);
  } catch (err) {
    throw new ClientMetadataFetchError(
      `the document's host is not reachable as a public address (${(err as Error).message})`
    );
  }

  let response;
  try {
    response = await pinnedHttpsGet(target, url.pathname, {
      timeoutMs: CIMD_TIMEOUT_MS,
      maxBytes: CIMD_MAX_BYTES,
      accept: "application/json",
    });
  } catch (err) {
    throw new ClientMetadataFetchError(
      `the document could not be fetched (${(err as Error).message})`
    );
  }

  if (response.statusCode >= 300 && response.statusCode < 400) {
    throw new ClientMetadataFetchError(
      `the document URL answered a redirect (${response.statusCode}); redirects are not followed`
    );
  }
  if (response.statusCode !== 200) {
    throw new ClientMetadataFetchError(
      `the document URL answered ${response.statusCode}`
    );
  }
  const contentType = headerValue(response.headers["content-type"]) ?? "";
  if (contentType.split(";")[0]!.trim().toLowerCase() !== "application/json") {
    throw new ClientMetadataFetchError(
      "the document is not served as application/json"
    );
  }
  return {
    body: response.body,
    cacheControl: headerValue(response.headers["cache-control"]),
  };
}

/** Where the cache lives — the real `oauth_clients` table by default. */
export interface ClientMetadataStore {
  find(clientId: string): Promise<StoredClient | null>;
  upsert(input: CimdClientInput): Promise<StoredClient>;
}

const defaultStore: ClientMetadataStore = {
  find: findClient,
  upsert: upsertCimdClient,
};

/** One fetch in flight per client_id, process-wide (T11). */
const inflight = new Map<string, Promise<StoredClient>>();

async function refresh(
  url: URL,
  clientId: string,
  store: ClientMetadataStore,
  deps: ClientMetadataDeps
): Promise<StoredClient> {
  const now = deps.now?.() ?? Date.now();
  const fetched = await fetchClientMetadata(url, deps);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fetched.body);
  } catch {
    throw new ClientMetadataError("the document is not valid JSON");
  }
  const validated = validateClientMetadataDocument(parsed, clientId);
  return store.upsert({
    clientId,
    ...validated,
    metadataFetchedAt: new Date(now),
    metadataExpiresAt: new Date(now + cimdCacheTtlMs(fetched.cacheControl)),
    metadataSha256: createHash("sha256").update(fetched.body).digest("hex"),
  });
}

/**
 * The client a CIMD client_id names: the cached copy while fresh, else a new
 * fetch. A FETCH failure falls back to a copy fetched within the last 24 h; an
 * INVALID document never does (the app changed it, and the pod must not keep
 * honouring the version it replaced). Throws `ClientMetadataError`.
 */
export async function resolveCimdClient(
  clientId: string,
  issuer: string | null,
  store: ClientMetadataStore = defaultStore,
  deps: ClientMetadataDeps = {}
): Promise<StoredClient> {
  const url = assertClientMetadataUrl(clientId, issuer);
  const now = deps.now?.() ?? Date.now();

  const cachedRow = await store.find(clientId);
  const cached = cachedRow?.clientKind === "cimd" ? cachedRow : null;
  if (cached?.metadataExpiresAt && cached.metadataExpiresAt.getTime() > now) {
    return cached;
  }

  let pending = inflight.get(clientId);
  if (!pending) {
    pending = refresh(url, clientId, store, deps).finally(() =>
      inflight.delete(clientId)
    );
    inflight.set(clientId, pending);
  }
  try {
    return await pending;
  } catch (err) {
    if (
      err instanceof ClientMetadataFetchError &&
      cached?.metadataFetchedAt &&
      now - cached.metadataFetchedAt.getTime() < CIMD_STALE_GRACE_MS
    ) {
      logger.warn(
        { clientId, reason: err.message },
        "pod-oauth: client metadata refresh failed — using the cached copy"
      );
      return cached;
    }
    throw err;
  }
}
