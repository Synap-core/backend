/**
 * `http.get_json` — read a public JSON API with no key, on the hosts the person
 * allows (agent report 25a60263; founder answer 12, 21 Nov 2026).
 *
 * THE GAP: `web.read` reads PAGES (it blocks a JSON answer as a "file"), and a
 * verb needs an installed, credited tool, so an agent had no door onto a free
 * open-data API (recherche-entreprises.api.gouv.fr, BODACC) and paid a third
 * party to wrap it.
 *
 * THE GUARDS, all on the shared remote-bytes door (`fetchGuardedBytes` over
 * `safePublicFetch`):
 *   - the host must be on the pod's allow-list, on the first URL AND on every
 *     redirect (`isAllowedHost`, checked before a hop is resolved);
 *   - https only, on every hop (`httpsOnly`);
 *   - every hop's name resolved and refused when any address is private,
 *     loopback, link-local or metadata, the socket pinned to the vetted
 *     address, at most `PUBLIC_FETCH_REDIRECT_HOPS` redirects;
 *   - GET only, no credentials: no cookie, no Authorization, no user:password
 *     in the URL; the only headers a caller may set are Accept and
 *     Accept-Language;
 *   - a size cap (refused past it) and a timeout;
 *   - the body must parse as JSON; the parsed value is returned, cut with a
 *     marker past `RETURN_BUDGET_CHARS`.
 *
 * THE ALLOW-LIST is pod-wide config: one `config_settings` row per host
 * (key `HTTP_ALLOWED_HOST_KEY`, no workspace, no capability row: the verb is
 * Synap Core's and pod-wide). It is written ONLY by `allowHost`, which the
 * `http.allow_host` verb calls; that verb declares `proposeOnly`, so an
 * agent's run is always a proposal the person approves, and its handler asks
 * for a pod admin. A pod admin removes a host with `govConfig.revoke`
 * (`store: "config_settings"`, the row id).
 */

import { db, and, eq, isNull, configSettings } from "@synap/database";
import {
  safePublicFetch,
  validateExternalUrl,
  type SafePublicFetchDeps,
  type SafePublicFetchInit,
} from "@synap/shared-utils";
import {
  fetchGuardedBytes,
  type RemoteFetchFailure,
} from "../media-copy/remote-fetch.js";

/** The `config_settings.key` of one allowed host (value `{ host }`). */
export const HTTP_ALLOWED_HOST_KEY = "http.get_json.allowed_host";

/** A body past this is refused, never read whole. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
/** The parsed JSON handed back is cut, with a marker, past this many characters. */
export const RETURN_BUDGET_CHARS = 60_000;
/** One string value is cut past this many characters. */
const STRING_CAP = 4_000;

/** The request headers a caller may set (lower case). */
const ALLOWED_HEADERS = new Set(["accept", "accept-language"]);

const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/**
 * A host as the allow-list stores it: lower case, punycode, no scheme, port,
 * path or credentials, a public name. Null when it is not one.
 */
export function normalizeHost(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text || /[\s/:@?#\\]/.test(text)) return null;
  let host: string;
  try {
    host = new URL(`https://${text}/`).hostname;
  } catch {
    return null;
  }
  if (!HOST_RE.test(host)) return null;
  if (!validateExternalUrl(`https://${host}/`).valid) return null;
  return host;
}

/** The hosts the pod allows, sorted. */
export async function listAllowedHosts(): Promise<string[]> {
  const rows = await db
    .select({ value: configSettings.value })
    .from(configSettings)
    .where(
      and(
        eq(configSettings.key, HTTP_ALLOWED_HOST_KEY),
        isNull(configSettings.revokedAt),
        isNull(configSettings.workspaceId)
      )
    );
  const hosts = new Set<string>();
  for (const r of rows) {
    const h = (r.value as { host?: unknown } | null)?.host;
    if (typeof h === "string") hosts.add(h);
  }
  return [...hosts].sort();
}

/**
 * Add a host to the pod's allow-list. The caller decided who may: the
 * `http.allow_host` handler (a pod admin's own run, or a person's approval of
 * an agent's proposal). Idempotent.
 */
export async function allowHost(
  host: string,
  createdBy: string
): Promise<{ host: string; alreadyAllowed: boolean }> {
  if ((await listAllowedHosts()).includes(host)) {
    return { host, alreadyAllowed: true };
  }
  await db.insert(configSettings).values({
    key: HTTP_ALLOWED_HOST_KEY,
    value: { host },
    scopeKind: "default",
    scopeRef: null,
    capabilityId: null,
    workspaceId: null,
    source: "user",
    createdBy,
  });
  return { host, alreadyAllowed: false };
}

/** The sentence an agent reads when a host is not on the list. */
export function hostNotAllowedMessage(host: string): string {
  return (
    `${host} is not on this pod's list of hosts http.get_json may read. ` +
    `To ask for it, run http.allow_host with { host: "${host}" }: that files a proposal the person approves. ` +
    "An agent never adds a host itself."
  );
}

export interface HttpGetJsonInput {
  url: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
}

export type HttpGetJsonResult =
  | {
      status: "ok";
      url: string;
      contentType: string | null;
      bytes: number;
      truncated: boolean;
      json: unknown;
    }
  | {
      status: "refused";
      reason:
        | "invalid_url"
        | "credentials_in_url"
        | "host_not_allowed"
        | "redirect_host_not_allowed"
        | "header_not_allowed"
        | "not_json"
        | RemoteFetchFailure;
      message: string;
      allowedHosts?: string[];
    };

const FAILURE_WORDS: Record<RemoteFetchFailure, string> = {
  blocked:
    "the URL is not allowed: only public https addresses, on every redirect too",
  expired: "the server answered 403, 404 or 410",
  http_4xx: "the server refused the request (4xx)",
  http_retry_later: "the server asked to try later (408 or 429)",
  http_5xx: "the server failed (5xx)",
  too_large: `the answer is larger than ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB`,
  empty: "the server answered no bytes",
  timeout: "the server took too long",
  fetch_failed: "the request failed",
};

/** Test seam: the pinned door's deps (a resolver, ports). The host check and https stay. */
export interface HttpGetJsonDeps {
  fetchDeps?: Omit<SafePublicFetchDeps, "isAllowedHost">;
}

export async function httpGetJson(
  input: HttpGetJsonInput,
  deps: HttpGetJsonDeps = {}
): Promise<HttpGetJsonResult> {
  const read = await readAllowedJson(input, { maxBytes: MAX_RESPONSE_BYTES }, deps);
  if (read.status !== "ok") return read;
  const cut = truncateJson(read.json);
  return { ...read, truncated: cut.truncated, json: cut.value };
}

/**
 * The guarded read behind `http.get_json`, WHOLE: every guard above (allow-list
 * on every hop, https, public addresses, no credentials, a size cap and a
 * timeout), and the parsed JSON handed back uncut. For a pod door that needs
 * the whole document (the storybook sync reads a Storybook's index.json and
 * components manifest); an agent's `http.get_json` gets the cut copy.
 */
export async function readAllowedJson(
  input: HttpGetJsonInput,
  opts: { maxBytes: number },
  deps: HttpGetJsonDeps = {}
): Promise<
  | {
      status: "ok";
      url: string;
      contentType: string | null;
      bytes: number;
      json: unknown;
    }
  | Extract<HttpGetJsonResult, { status: "refused" }>
> {
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    return {
      status: "refused",
      reason: "invalid_url",
      message: "url is not a valid URL.",
    };
  }
  if (url.username || url.password) {
    return {
      status: "refused",
      reason: "credentials_in_url",
      message:
        "url carries a user name or password; http.get_json sends no credentials.",
    };
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const lower = name.trim().toLowerCase();
    if (!ALLOWED_HEADERS.has(lower)) {
      return {
        status: "refused",
        reason: "header_not_allowed",
        message: `Header "${name}" is not allowed: http.get_json sends only Accept and Accept-Language.`,
      };
    }
    headers[lower] = value;
  }

  const allowed = new Set(await listAllowedHosts());
  const host = url.hostname.toLowerCase();
  if (!allowed.has(host)) {
    return {
      status: "refused",
      reason: "host_not_allowed",
      message: hostNotAllowedMessage(host),
      allowedHosts: [...allowed].sort(),
    };
  }

  for (const [k, v] of Object.entries(input.query ?? {})) {
    url.searchParams.set(k, String(v));
  }

  // The host a redirect named that is not on the list, to say so precisely.
  let refusedHost: string | null = null;
  const isAllowedHost = (h: string) => {
    const ok = allowed.has(h.toLowerCase());
    if (!ok) refusedHost = h.toLowerCase();
    return ok;
  };
  const fetchDeps: SafePublicFetchDeps = {
    httpsOnly: true,
    ...deps.fetchDeps,
    isAllowedHost,
  };
  const fetch = (
    u: string,
    init?: SafePublicFetchInit,
    maxRedirects?: number
  ): Promise<Response> =>
    safePublicFetch(
      u,
      {
        ...init,
        method: "GET",
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(headers["accept-language"]
            ? { "Accept-Language": headers["accept-language"] }
            : {}),
          "User-Agent": "SynapHttpGetJson/1.0",
        },
      },
      maxRedirects,
      fetchDeps
    );

  const got = await fetchGuardedBytes(url.toString(), {
    maxBytes: opts.maxBytes,
    timeoutMs: TIMEOUT_MS,
    accept: headers.accept ?? "application/json",
    fetch,
    validate: (raw) =>
      validateExternalUrl(raw, {
        ...(fetchDeps.allowedPorts
          ? { allowedPorts: fetchDeps.allowedPorts }
          : {}),
      }),
  });
  if (!got.ok) {
    if (got.reason === "blocked" && refusedHost) {
      return {
        status: "refused",
        reason: "redirect_host_not_allowed",
        message: `${host} redirected to ${refusedHost}, which is not on this pod's list of allowed hosts. ${hostNotAllowedMessage(refusedHost)}`,
        allowedHosts: [...allowed].sort(),
      };
    }
    return {
      status: "refused",
      reason: got.reason,
      message: `Nothing was read from ${host}: ${
        got.reason === "too_large"
          ? `the answer is larger than ${Math.round(opts.maxBytes / (1024 * 1024))} MB`
          : FAILURE_WORDS[got.reason]
      }.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(got.bytes.toString("utf8"));
  } catch {
    return {
      status: "refused",
      reason: "not_json",
      message: `${host} did not answer JSON (it served ${got.contentType ?? "no content type"}). To read a web page, use web.read.`,
    };
  }

  return {
    status: "ok",
    url: url.toString(),
    contentType: got.contentType,
    bytes: got.bytes.byteLength,
    json: parsed,
  };
}

/**
 * The parsed JSON, cut to about `budget` serialized characters: an array keeps
 * its first items and ends with a "…[truncated: N more items]" marker, an
 * object its first keys and a "…truncated" key, a long string its first
 * `STRING_CAP` characters and a marker. The shape stays JSON an agent can read.
 */
export function truncateJson(
  value: unknown,
  budget = RETURN_BUDGET_CHARS
): { value: unknown; truncated: boolean } {
  let left = budget;
  let truncated = false;
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") {
      if (typeof v === "string" && v.length > STRING_CAP) {
        truncated = true;
        left -= STRING_CAP;
        return `${v.slice(0, STRING_CAP)}…[truncated: ${v.length - STRING_CAP} more characters]`;
      }
      left -= (JSON.stringify(v) ?? "null").length;
      return v;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        if (left <= 0) {
          truncated = true;
          out.push(`…[truncated: ${v.length - i} more items]`);
          break;
        }
        out.push(walk(v[i]));
        left -= 1;
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    const keys = Object.keys(v as Record<string, unknown>);
    for (let i = 0; i < keys.length; i++) {
      if (left <= 0) {
        truncated = true;
        out["…truncated"] = `${keys.length - i} more keys`;
        break;
      }
      const k = keys[i]!;
      left -= k.length + 4;
      out[k] = walk((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  const out = walk(value);
  return { value: out, truncated };
}
