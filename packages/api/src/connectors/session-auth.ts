/**
 * "Sign in, then call" auth for `vault://` API tools — the opt-in
 * `config.auth.type: "session"` mode of the ONE vault handler
 * (`external-dispatch.ts` → `vaultHandler`).
 *
 * Some providers do not accept the stored credential on each request. They take
 * it ONCE at a sign-in endpoint and hand back a short-lived token (and sometimes
 * a per-account API host). Backblaze B2 is the first:
 *
 *   GET https://api.backblazeb2.com/b2api/v4/b2_authorize_account
 *       Authorization: Basic base64(keyId:applicationKey)
 *   → { accountId, authorizationToken, apiInfo: { storageApi: { apiUrl } } }
 *   POST {apiUrl}/b2api/v4/<op>   Authorization: <authorizationToken>
 *
 * The tool declares the dance as DATA, so a second provider of this shape is a
 * template, not code:
 *
 *   "auth": {
 *     "type": "session",
 *     "signIn":  { "url": "https://…/b2_authorize_account", "method": "GET",
 *                  "credential": "basic" },
 *     "token":   { "path": "authorizationToken", "header": "Authorization",
 *                  "prefix": "", "ttlSeconds": 86400 },
 *     "baseUrlFrom": "apiInfo.storageApi.apiUrl",
 *     "bodyFrom":    { "accountId": "accountId" },
 *     "reauthOn":    { "status": 401, "codePath": "code",
 *                      "codes": ["expired_auth_token", "bad_auth_token"] }
 *   }
 *
 * THE SECRET FORMAT (`credential: "basic"`, the only one today): the vault value
 * is `<id>:<secret>` — the HTTP Basic user-pass form (RFC 7617 §2: the user-id
 * cannot contain a colon, so the FIRST colon splits). For B2 that is
 * `<applicationKeyId>:<applicationKey>`. Validated before any network call; a
 * malformed value is refused with a message that never echoes the value.
 *
 * TOKEN CACHE: in-process memory only — never the DB, a file, or a log line.
 * Keyed by the secret id + a digest of the decrypted value (its "version": a
 * rotated key is a new entry, the old token is simply never read again) + the
 * sign-in URL. The vault policy (grant check) still runs on EVERY call, BEFORE
 * this cache is consulted — caching the token never caches the authorization.
 * Concurrent first calls share ONE in-flight sign-in.
 */
import { createHash } from "node:crypto";
import { safeExternalFetch, validateExternalUrl } from "@synap/shared-utils";

export interface SessionAuthConfig {
  type: "session";
  signIn: { url: string; method: "GET" | "POST"; credential: "basic" };
  token: { path: string; header: string; prefix: string; ttlSeconds: number };
  /** Dot-path in the sign-in response to the API base URL for later calls. */
  baseUrlFrom: string | null;
  /** Request-body fields filled from the sign-in response (body field → path). */
  bodyFrom: Record<string, string>;
  /** Which failure means "the token is dead — sign in again and retry once". */
  reauthOn: { status: number; codePath: string; codes: string[] | null };
}

export interface SessionState {
  token: string;
  baseUrl: string | null;
  /** Non-secret values the sign-in returned, resolved per `bodyFrom`. */
  bodyValues: Record<string, unknown>;
  expiresAt: number;
}

/** The provider's upper bound when a config names none (B2: "at most 24 hours"). */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
/** Refresh this long before the declared expiry so a call never races it. */
const EXPIRY_MARGIN_SECONDS = 5 * 60;
/** Distinct credentials held at once; the oldest entry is dropped past this. */
const MAX_CACHE_ENTRIES = 256;

/** True when a tool's `config.auth` opts into this mode. Anything else is legacy. */
export function isSessionAuth(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as Record<string, unknown>).type === "session"
  );
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

/** Validate a declared session config. Errors name the field, never a value. */
export function parseSessionAuthConfig(
  raw: unknown
): { ok: true; config: SessionAuthConfig } | { ok: false; error: string } {
  const bad = (field: string) => ({
    ok: false as const,
    error: `Tool config.auth (type "session") is invalid: ${field}.`,
  });
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const signIn = (cfg.signIn ?? {}) as Record<string, unknown>;
  const token = (cfg.token ?? {}) as Record<string, unknown>;
  const reauth = (cfg.reauthOn ?? {}) as Record<string, unknown>;

  if (!isNonEmptyString(signIn.url) || !/^https:\/\//i.test(signIn.url)) {
    return bad("signIn.url must be an https URL");
  }
  const method = signIn.method === undefined ? "GET" : signIn.method;
  if (method !== "GET" && method !== "POST") {
    return bad('signIn.method must be "GET" or "POST"');
  }
  if (signIn.credential !== "basic") {
    return bad('signIn.credential must be "basic"');
  }
  if (!isNonEmptyString(token.path)) return bad("token.path is required");
  if (token.header !== undefined && !isNonEmptyString(token.header)) {
    return bad("token.header must be a non-empty string");
  }
  if (token.prefix !== undefined && typeof token.prefix !== "string") {
    return bad("token.prefix must be a string");
  }
  const ttl =
    token.ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : token.ttlSeconds;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) {
    return bad("token.ttlSeconds must be a positive number");
  }
  if (cfg.baseUrlFrom !== undefined && !isNonEmptyString(cfg.baseUrlFrom)) {
    return bad("baseUrlFrom must be a non-empty string");
  }
  const bodyFromRaw = cfg.bodyFrom ?? {};
  if (
    typeof bodyFromRaw !== "object" ||
    bodyFromRaw === null ||
    Array.isArray(bodyFromRaw) ||
    !Object.values(bodyFromRaw).every(isNonEmptyString)
  ) {
    return bad("bodyFrom must map body fields to response paths");
  }
  const status = reauth.status === undefined ? 401 : reauth.status;
  if (typeof status !== "number") return bad("reauthOn.status must be a number");
  const codes = reauth.codes === undefined ? null : reauth.codes;
  if (
    codes !== null &&
    !(Array.isArray(codes) && codes.every(isNonEmptyString))
  ) {
    return bad("reauthOn.codes must be a list of strings");
  }
  if (reauth.codePath !== undefined && !isNonEmptyString(reauth.codePath)) {
    return bad("reauthOn.codePath must be a non-empty string");
  }

  return {
    ok: true,
    config: {
      type: "session",
      signIn: { url: signIn.url, method, credential: "basic" },
      token: {
        path: token.path,
        header: (token.header as string | undefined) ?? "Authorization",
        prefix: (token.prefix as string | undefined) ?? "",
        ttlSeconds: ttl,
      },
      baseUrlFrom: (cfg.baseUrlFrom as string | undefined) ?? null,
      bodyFrom: bodyFromRaw as Record<string, string>,
      reauthOn: {
        status,
        codePath: (reauth.codePath as string | undefined) ?? "code",
        codes: codes as string[] | null,
      },
    },
  };
}

/**
 * Split a `<id>:<secret>` vault value. The error never contains the value — it
 * describes the expected SHAPE only.
 */
export function parseBasicCredential(
  secret: string
): { ok: true; id: string; key: string } | { ok: false; error: string } {
  const at = secret.indexOf(":");
  const id = at > 0 ? secret.slice(0, at).trim() : "";
  const key = at > 0 ? secret.slice(at + 1).trim() : "";
  if (!id || !key) {
    return {
      ok: false,
      error:
        'The stored credential is not in the "<keyId>:<applicationKey>" form this tool signs in with. Update the secret in the vault.',
    };
  }
  return { ok: true, id, key };
}

/** Read a dot-path (`a.b.c`) out of a parsed JSON value. */
export function readPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const cache = new Map<string, SessionState>();
const inflight = new Map<string, Promise<SessionResult>>();

/** Test-only: forget every cached session. */
export function __resetSessionCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/**
 * The cache key. The decrypted value only ever enters a one-way digest, and the
 * key itself is never logged.
 */
export function sessionCacheKey(
  secretId: string,
  secret: string,
  config: SessionAuthConfig
): string {
  const version = createHash("sha256").update(secret).digest("hex");
  return createHash("sha256")
    .update(`${secretId}\u0000${version}\u0000${config.signIn.url}`)
    .digest("hex");
}

export type SessionResult =
  | { ok: true; session: SessionState }
  | { ok: false; status: number; error: string };

async function signIn(
  config: SessionAuthConfig,
  secret: string,
  now: () => number
): Promise<SessionResult> {
  const cred = parseBasicCredential(secret);
  if (!cred.ok) return { ok: false, status: 400, error: cred.error };
  const basic = Buffer.from(`${cred.id}:${cred.key}`).toString("base64");

  let res: Response;
  try {
    res = await safeExternalFetch(config.signIn.url, {
      method: config.signIn.method,
      headers: { Authorization: `Basic ${basic}` },
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Sign-in request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON sign-in response: handled by the checks below.
  }
  if (!res.ok) {
    // The provider's own code/message only — the request carried the secret in
    // a header, never in anything quoted here.
    const code = readPath(body, config.reauthOn.codePath);
    const message = readPath(body, "message");
    return {
      ok: false,
      status: res.status,
      error: `Sign-in failed (${res.status}${typeof code === "string" ? ` ${code}` : ""})${
        typeof message === "string" ? `: ${message.slice(0, 200)}` : ""
      }`,
    };
  }

  const token = readPath(body, config.token.path);
  if (!isNonEmptyString(token)) {
    return {
      ok: false,
      status: 502,
      error: `Sign-in response has no token at "${config.token.path}".`,
    };
  }
  let baseUrl: string | null = null;
  if (config.baseUrlFrom) {
    const raw = readPath(body, config.baseUrlFrom);
    const checked =
      isNonEmptyString(raw) && /^https:\/\//i.test(raw)
        ? validateExternalUrl(raw)
        : null;
    if (!checked || !checked.valid) {
      return {
        ok: false,
        status: 502,
        error: `Sign-in response has no usable https API URL at "${config.baseUrlFrom}".`,
      };
    }
    baseUrl = raw as string;
  }
  const bodyValues: Record<string, unknown> = {};
  for (const [field, path] of Object.entries(config.bodyFrom)) {
    const v = readPath(body, path);
    if (v === undefined) {
      return {
        ok: false,
        status: 502,
        error: `Sign-in response has no value at "${path}" (needed for body field "${field}").`,
      };
    }
    bodyValues[field] = v;
  }
  const lifetime = Math.max(
    60,
    config.token.ttlSeconds - EXPIRY_MARGIN_SECONDS
  );
  return {
    ok: true,
    session: { token, baseUrl, bodyValues, expiresAt: now() + lifetime * 1000 },
  };
}

/**
 * The live session for a credential: the cached one while it is fresh, else a
 * new sign-in (shared by concurrent callers). Failures are never cached.
 */
export async function getSession(
  key: string,
  config: SessionAuthConfig,
  secret: string,
  now: () => number = Date.now
): Promise<SessionResult> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return { ok: true, session: hit };
  if (hit) cache.delete(key);

  const pending = inflight.get(key);
  if (pending) return pending;
  const p = signIn(config, secret, now).then((r) => {
    if (r.ok) {
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, r.session);
    }
    return r;
  });
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

/** Drop a session the provider rejected — only if it is still the cached one. */
export function invalidateSession(key: string, token: string): void {
  if (cache.get(key)?.token === token) cache.delete(key);
}

/** Does this failed response mean the token is dead (sign in again, retry once)? */
export function shouldReauth(
  config: SessionAuthConfig,
  status: number,
  body: unknown
): boolean {
  if (status !== config.reauthOn.status) return false;
  if (config.reauthOn.codes === null) return true;
  const code = readPath(body, config.reauthOn.codePath);
  return typeof code === "string" && config.reauthOn.codes.includes(code);
}
