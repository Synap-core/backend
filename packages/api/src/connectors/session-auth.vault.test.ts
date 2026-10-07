import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The vault:// handler's HTTP behaviour, pinned at the handler seam with the
 * global `fetch` mocked (`safeExternalFetch` calls it; nothing here reaches a
 * network). Two halves:
 *
 *  1. LEGACY static-key tools (no `config.auth.type`) — every assertion records
 *     the EXACT outbound request and the EXACT result. These were run against
 *     the pre-change handler (HEAD) as well and are green there: they describe
 *     the old behaviour, so a green run on the new handler is the
 *     "byte-identical" claim, not an assumption.
 *  2. `config.auth.type: "session"` ("sign in, then call", Backblaze B2 shape) —
 *     sign-in once + cache, token reuse, the per-account apiUrl, accountId from
 *     the sign-in, re-sign-in + ONE retry on a dead token, no retry on a
 *     permission 401, expiry, rotation, and the secret never leaving the
 *     process in a log line, an error, or a result.
 *
 * NOT covered here: the grant policy (`vault-credential-policy.test.ts`) and
 * the capability gate in `triggerProviderAction` (its own suites).
 */

const SECRET_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "0051f00dkeyid000000000001";
const APP_KEY = "K005SuperSecretApplicationKeyValue";
const B2_SECRET = `${KEY_ID}:${APP_KEY}`;
const BASIC = Buffer.from(B2_SECRET).toString("base64");
const TOKEN_1 = "4_tokenONE_abcdef";
const TOKEN_2 = "4_tokenTWO_ghijkl";
const API_URL = "https://api005.backblazeb2.com";
const AUTH_URL = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account";

const { mockResolveVaultSecret, mockFindFirst, logCalls } = vi.hoisted(() => ({
  mockResolveVaultSecret: vi.fn(),
  mockFindFirst: vi.fn(),
  logCalls: [] as unknown[],
}));

vi.mock("../utils/vault-resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/vault-resolver.js")>();
  return { ...actual, resolveVaultSecret: mockResolveVaultSecret };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { query: { secrets: { findFirst: mockFindFirst } } },
  };
});

// Every logger the dispatcher (or anything it imports) creates records into
// `logCalls`, so "the secret is never logged" is checked against real calls.
vi.mock("@synap-core/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap-core/core")>();
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      logCalls.push([level, ...args]);
    };
  const fake = () => {
    const l: Record<string, unknown> = {
      trace: record("trace"),
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      fatal: record("fatal"),
    };
    l.child = () => l;
    return l;
  };
  return { ...actual, createLogger: fake };
});

import { __vaultHandlerForTests as vaultHandler } from "./external-dispatch.js";
import { __resetSessionCacheForTests } from "./session-auth.js";

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];
let responder: (url: string, init: RequestInit) => Response;
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  logCalls.length = 0;
  calls = [];
  __resetSessionCacheForTests();
  mockFindFirst.mockResolvedValue({
    userId: "owner-1",
    providerIntegrationId: null,
    accountHint: null,
    isPodWide: false,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return responder(String(url), init);
    })
  );
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logCalls.push([`console.${m}`, ...args]);
      })
    );
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const s of consoleSpies.splice(0)) s.mockRestore();
});

function tool(config: Record<string, unknown>) {
  return {
    id: "tool-1",
    name: "t",
    kind: "api",
    credentialRef: `vault://${SECRET_ID}`,
    config,
  } as never;
}

function run(
  config: Record<string, unknown>,
  call: {
    method?: string;
    path: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  }
) {
  return vaultHandler({
    input: {
      userId: "owner-1",
      provider: `vault://${SECRET_ID}`,
      method: call.method ?? "GET",
      path: call.path,
      body: call.body,
      headers: call.headers,
    } as never,
    tool: tool(config),
  });
}

const headersOf = (c: FetchCall) => c.init.headers as Record<string, string>;

// ─────────────────────────────────────────────────────────────────────────────
describe("legacy static-key tools (no auth.type) — unchanged", () => {
  beforeEach(() => {
    mockResolveVaultSecret.mockResolvedValue("s3cret-static");
    responder = () => json(200, { ok: true });
  });

  it("default auth: Bearer in Authorization, baseUrl + path, JSON body", async () => {
    const r = await run(
      { baseUrl: "https://api.example.com/v2/" },
      { method: "post", path: "/things", body: { a: 1 }, headers: { "x-v": "1" } }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.com/v2/things");
    expect(calls[0]!.init).toEqual({
      method: "POST",
      headers: {
        "x-v": "1",
        "Content-Type": "application/json",
        Authorization: "Bearer s3cret-static",
      },
      body: JSON.stringify({ a: 1 }),
      redirect: "manual",
    });
    expect(r).toEqual({
      success: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    });
  });

  it("custom header + prefix; a caller header can never override auth", async () => {
    await run(
      {
        baseUrl: "https://api.exa.ai",
        auth: { in: "header", name: "x-api-key", prefix: "" },
      },
      { path: "search", headers: { "x-api-key": "attacker" } }
    );
    expect(calls[0]!.url).toBe("https://api.exa.ai/search");
    expect(calls[0]!.init).toEqual({
      method: "GET",
      headers: { "x-api-key": "s3cret-static" },
      body: undefined,
      redirect: "manual",
    });
  });

  it("query auth puts the key in the query string", async () => {
    await run(
      { baseUrl: "https://api.example.com", auth: { in: "query", name: "key" } },
      { path: "/q?x=1" }
    );
    expect(calls[0]!.url).toBe("https://api.example.com/q?x=1&key=s3cret-static");
    expect(headersOf(calls[0]!)).toEqual({});
  });

  it("baseUrl pins the host: an absolute path cannot smuggle another host", async () => {
    await run(
      { baseUrl: "https://api.example.com" },
      { path: "https://evil.example.org/steal" }
    );
    expect(calls[0]!.url).toBe("https://api.example.com/steal");
  });

  it("no baseUrl: an absolute path is honoured; a relative one is refused", async () => {
    await run({}, { path: "https://api.other.com/x" });
    expect(calls[0]!.url).toBe("https://api.other.com/x");
    const r = await run({}, { path: "/relative" });
    expect(r).toEqual({
      success: false,
      status: 400,
      errorCode: "bad_request",
      error:
        'vault:// tool requires either an absolute path or `config.baseUrl`. Set tool.config.baseUrl (e.g. "https://api.example.com").',
    });
    expect(calls).toHaveLength(1);
  });

  it("SSRF guard refuses a private host", async () => {
    const r = await run({ baseUrl: "http://127.0.0.1:8080" }, { path: "/x" });
    expect(r).toMatchObject({ success: false, status: 400, errorCode: "bad_request" });
    expect(String(r.error)).toMatch(/^Outbound URL rejected: /);
    expect(calls).toHaveLength(0);
  });

  it("non-2xx carries errorCode + the provider's message; a 401 is NOT retried", async () => {
    responder = () => json(401, { error: { message: "Invalid API token" } });
    const r = await run({ baseUrl: "https://api.example.com" }, { path: "/x" });
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({
      success: false,
      status: 401,
      body: { error: { message: "Invalid API token" } },
    });
    expect(r.errorCode).toBeDefined();
    expect(r.error).toBeDefined();
  });

  it("a fetch throw is a 502 unavailable", async () => {
    responder = () => {
      throw new Error("ECONNRESET");
    };
    const r = await run({ baseUrl: "https://api.example.com" }, { path: "/x" });
    expect(r).toEqual({
      success: false,
      status: 502,
      errorCode: "unavailable",
      error: "Outbound request failed: ECONNRESET",
    });
  });

  it("a tool whose auth has an UNKNOWN type stays on the legacy path", async () => {
    // Only `type: "session"` opts in; anything else must not change behaviour.
    await run(
      { baseUrl: "https://api.example.com", auth: { type: "other", name: "x-k", prefix: "" } },
      { path: "/x" }
    );
    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0]!)).toEqual({ "x-k": "s3cret-static" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const B2_AUTH = {
  type: "session",
  signIn: { url: AUTH_URL, method: "GET", credential: "basic" },
  token: { path: "authorizationToken", header: "Authorization", prefix: "", ttlSeconds: 86400 },
  baseUrlFrom: "apiInfo.storageApi.apiUrl",
  bodyFrom: { accountId: "accountId" },
  reauthOn: { status: 401, codePath: "code", codes: ["expired_auth_token", "bad_auth_token"] },
};
const B2_CONFIG = { auth: B2_AUTH };

/** A B2 fake: authorize hands out TOKEN_1, then TOKEN_2, …; ops answer per `op`. */
function b2Fake(
  op: (url: string, init: RequestInit, token: string) => Response = () =>
    json(200, { buckets: [] })
) {
  const tokens = [TOKEN_1, TOKEN_2, "4_tokenTHREE"];
  let issued = 0;
  return (url: string, init: RequestInit) => {
    if (url === AUTH_URL) {
      return json(200, {
        accountId: "acct-123",
        authorizationToken: tokens[issued++],
        apiInfo: { storageApi: { apiUrl: API_URL, s3ApiUrl: "https://s3.x" } },
      });
    }
    return op(url, init, (init.headers as Record<string, string>).Authorization!);
  };
}

const authCalls = () => calls.filter((c) => c.url === AUTH_URL);
const opCalls = () => calls.filter((c) => c.url !== AUTH_URL);

describe('auth.type "session" — sign in, then call (B2 shape)', () => {
  beforeEach(() => {
    mockResolveVaultSecret.mockResolvedValue(B2_SECRET);
    responder = b2Fake();
  });

  it("signs in ONCE with HTTP Basic keyId:applicationKey, then reuses the token", async () => {
    const r1 = await run(B2_CONFIG, {
      method: "POST",
      path: "/b2api/v4/b2_list_buckets",
      body: {},
    });
    const r2 = await run(B2_CONFIG, {
      method: "POST",
      path: "/b2api/v4/b2_list_keys",
      body: { maxKeyCount: 10 },
    });
    expect(r1.success && r2.success).toBe(true);
    expect(authCalls()).toHaveLength(1);
    expect(authCalls()[0]!.init.method).toBe("GET");
    expect(headersOf(authCalls()[0]!)).toEqual({ Authorization: `Basic ${BASIC}` });
    expect(opCalls().map((c) => headersOf(c).Authorization)).toEqual([TOKEN_1, TOKEN_1]);
  });

  it("calls the per-account apiUrl, never the sign-in host, and fills accountId", async () => {
    await run(B2_CONFIG, {
      method: "POST",
      path: "/b2api/v4/b2_list_buckets",
      body: { bucketName: "synap-backups", accountId: "spoofed" },
    });
    const op = opCalls()[0]!;
    expect(op.url).toBe(`${API_URL}/b2api/v4/b2_list_buckets`);
    expect(op.init.method).toBe("POST");
    expect(JSON.parse(String(op.init.body))).toEqual({
      bucketName: "synap-backups",
      accountId: "acct-123",
    });
    expect(headersOf(op)["Content-Type"]).toBe("application/json");
  });

  it("a caller path cannot redirect the token to another host", async () => {
    await run(B2_CONFIG, {
      method: "POST",
      path: "https://evil.example.org/b2api/v4/b2_list_buckets",
      body: {},
    });
    expect(opCalls()[0]!.url).toBe(`${API_URL}/b2api/v4/b2_list_buckets`);
  });

  it("401 expired_auth_token → forget the token, sign in again, retry ONCE", async () => {
    responder = b2Fake((_u, _i, token) =>
      token === TOKEN_1
        ? json(401, { status: 401, code: "expired_auth_token", message: "Authorization token has expired" })
        : json(200, { buckets: [{ bucketName: "b" }] })
    );
    const r = await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} });
    expect(r).toMatchObject({ success: true, body: { buckets: [{ bucketName: "b" }] } });
    expect(authCalls()).toHaveLength(2);
    expect(opCalls().map((c) => headersOf(c).Authorization)).toEqual([TOKEN_1, TOKEN_2]);

    // The fresh token is what the cache holds now.
    await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_keys", body: {} });
    expect(authCalls()).toHaveLength(2);
    expect(headersOf(opCalls()[2]!).Authorization).toBe(TOKEN_2);
  });

  it("a second dead-token 401 is surfaced as-is — exactly one retry, never a loop", async () => {
    responder = b2Fake(() =>
      json(401, { status: 401, code: "bad_auth_token", message: "Invalid authorization token" })
    );
    const r = await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} });
    expect(r).toMatchObject({ success: false, status: 401 });
    expect(String(r.error)).toContain("Invalid authorization token");
    expect(authCalls()).toHaveLength(2);
    expect(opCalls()).toHaveLength(2);
  });

  it("401 unauthorized (missing capability) is NOT a dead token — no re-sign-in", async () => {
    responder = b2Fake(() =>
      json(401, { status: 401, code: "unauthorized", message: "not entitled" })
    );
    const r = await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_keys", body: {} });
    expect(r).toMatchObject({ success: false, status: 401 });
    expect(authCalls()).toHaveLength(1);
    expect(opCalls()).toHaveLength(1);
  });

  it("an expired cached session signs in again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T00:00:00Z"));
    await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} });
    vi.setSystemTime(new Date("2026-10-07T23:00:00Z")); // < 24h - 5min margin
    await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} });
    expect(authCalls()).toHaveLength(1);
    vi.setSystemTime(new Date("2026-10-07T23:56:00Z")); // inside the margin
    await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} });
    expect(authCalls()).toHaveLength(2);
    expect(headersOf(opCalls()[2]!).Authorization).toBe(TOKEN_2);
  });

  it("a rotated secret (new value, same id) is a new cache entry", async () => {
    await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} });
    mockResolveVaultSecret.mockResolvedValue(`${KEY_ID}:K005RotatedKey`);
    await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} });
    expect(authCalls()).toHaveLength(2);
  });

  it("concurrent first calls share ONE sign-in", async () => {
    await Promise.all(
      [1, 2, 3].map(() =>
        run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} })
      )
    );
    expect(authCalls()).toHaveLength(1);
    expect(opCalls()).toHaveLength(3);
  });

  it("a malformed secret is refused before any network call, without echoing it", async () => {
    mockResolveVaultSecret.mockResolvedValue("no-colon-just-a-key-K005xyz");
    const r = await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} });
    expect(r).toMatchObject({ success: false, status: 400 });
    expect(String(r.error)).toContain("<keyId>:<applicationKey>");
    expect(JSON.stringify(r)).not.toContain("K005xyz");
    expect(calls).toHaveLength(0);
  });

  it("an invalid session config is a 400 naming the field", async () => {
    const r = await run(
      { auth: { ...B2_AUTH, signIn: { url: "http://insecure.example.com", credential: "basic" } } },
      { method: "POST", path: "/x", body: {} }
    );
    expect(r).toMatchObject({ success: false, status: 400 });
    expect(String(r.error)).toContain("signIn.url");
    expect(calls).toHaveLength(0);
  });

  it("a failed sign-in is not cached, and never leaks the secret", async () => {
    let fail = true;
    responder = (url, init) => {
      if (url === AUTH_URL && fail) {
        return json(401, { status: 401, code: "bad_auth_token", message: "Invalid accountId or applicationKeyId" });
      }
      return b2Fake()(url, init);
    };
    const r = await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} });
    expect(r).toMatchObject({ success: false, status: 401 });
    expect(String(r.error)).toBe(
      "Sign-in failed (401 bad_auth_token): Invalid accountId or applicationKeyId"
    );
    fail = false;
    const r2 = await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} });
    expect(r2.success).toBe(true);
  });

  it("the secret, its Basic form and the token never appear in logs, errors or results", async () => {
    // Drive every branch that produces text: success, dead-token retry, a
    // surfaced failure, a failed sign-in, a thrown fetch.
    const results: unknown[] = [];
    responder = b2Fake((_u, _i, token) =>
      token === TOKEN_1
        ? json(401, { code: "expired_auth_token", message: "expired" })
        : json(500, { code: "internal_error", message: "boom" })
    );
    results.push(await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} }));
    __resetSessionCacheForTests();
    responder = () => {
      throw new Error("network down");
    };
    results.push(await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} }));
    __resetSessionCacheForTests();
    responder = (url) =>
      url === AUTH_URL ? json(401, { code: "bad_auth_token", message: "nope" }) : json(200, {});
    results.push(await run(B2_CONFIG, { method: "POST", path: "/b2api/v4/b2_list_buckets", body: {} }));

    const haystack = JSON.stringify({ results, logCalls });
    for (const needle of [APP_KEY, B2_SECRET, BASIC, TOKEN_1, TOKEN_2]) {
      expect(haystack, `leaked ${needle.slice(0, 6)}…`).not.toContain(needle);
    }
    // Non-vacuity: the results really are the failure envelopes we think.
    expect(results).toHaveLength(3);
    expect((results[0] as { status: number }).status).toBe(500);
  });
});
