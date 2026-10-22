/**
 * Client ID Metadata Documents — the SSRF matrix, the document rules and the
 * cache (spec 17 §6.1, wave PB1).
 *
 * The REAL `resolvePublicIssuerEndpoint` runs with an injected DNS answer, and
 * `node:https` is mocked so every outbound request is CAPTURED: a refused URL
 * must refuse before any request is made, and an allowed one must connect to
 * the IP that was checked (pinned), never to the hostname.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ httpsRequest: vi.fn() }));
vi.mock("node:https", () => ({ request: m.httpsRequest }));
// The cache is injected per test (`memoryStore`); the real one is never reached.
vi.mock("./store.js", () => ({
  findClient: vi.fn(),
  upsertCimdClient: vi.fn(),
}));

import {
  CIMD_MAX_TTL_MS,
  CIMD_MIN_TTL_MS,
  ClientMetadataError,
  assertClientMetadataUrl,
  cimdCacheTtlMs,
  resolveCimdClient,
  validateClientMetadataDocument,
  type ClientMetadataStore,
} from "./client-metadata.js";
import type { CimdClientInput, StoredClient } from "./store.js";

const ISSUER = "https://pod.test.synap.live";
const CLIENT_ID = "https://studio.example.com/.well-known/synap-client.json";
const CALLBACK = "https://studio.example.com/api/synap/callback";
const PUBLIC_IP = "93.184.216.34";

function doc(overrides: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT_ID,
    client_name: "Content Studio",
    redirect_uris: [CALLBACK],
    scope: "mcp.read",
    synap_requests: [
      { permission: "entity.post.read", reason: "To list your drafts" },
      { permission: "entity.post.create" },
    ],
    ...overrides,
  };
}

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Never answer (a slow server). */
  hang?: boolean;
}

/** Install the next responses `https.request` gives, in order. */
function serve(...replies: Reply[]) {
  const queue = [...replies];
  m.httpsRequest.mockImplementation(((
    _options: Record<string, unknown>,
    callback: (response: unknown) => void
  ) => {
    const reply = queue.shift() ?? queue[queue.length - 1] ?? {};
    const req = {
      destroy: vi.fn(),
      end: vi.fn(),
      once: vi.fn(),
    };
    if (reply.hang) return req;
    let onData: ((chunk: Buffer) => void) | undefined;
    const response = {
      statusCode: reply.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...(reply.headers ?? {}),
      },
      destroy: vi.fn(),
      resume: vi.fn(),
      on: vi.fn((event: string, listener: (chunk: Buffer) => void) => {
        if (event === "data") onData = listener;
        return response;
      }),
      once: vi.fn((event: string, listener: () => void) => {
        if (event === "end") {
          queueMicrotask(() => {
            onData?.(Buffer.from(reply.body ?? JSON.stringify(doc())));
            listener();
          });
        }
        return response;
      }),
    };
    callback(response);
    return req;
  }) as never);
}

function memoryStore(): ClientMetadataStore & {
  rows: Map<string, StoredClient>;
} {
  const rows = new Map<string, StoredClient>();
  return {
    rows,
    find: async (id) => rows.get(id) ?? null,
    upsert: async (input: CimdClientInput) => {
      const prev = rows.get(input.clientId);
      const row: StoredClient = {
        clientKind: "cimd",
        createdAt: prev?.createdAt ?? input.metadataFetchedAt,
        ...input,
      };
      rows.set(input.clientId, row);
      return row;
    },
  };
}

const publicDns = vi.fn(async () => [{ address: PUBLIC_IP, family: 4 }]);

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ClientMetadataError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  m.httpsRequest.mockReset();
  publicDns.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("CIMD — happy path", () => {
  it("fetches the document from the CHECKED public IP and caches the validated client", async () => {
    serve({ headers: { "cache-control": "max-age=600" } });
    const store = memoryStore();
    const client = await resolveCimdClient(CLIENT_ID, ISSUER, store, {
      lookup: publicDns,
    });

    expect(client).toMatchObject({
      clientId: CLIENT_ID,
      clientKind: "cimd",
      clientName: "Content Studio",
      redirectUris: [CALLBACK],
      scopes: ["mcp.read"],
      requestedPermissions: ["entity.post.read", "entity.post.create"],
    });
    expect(store.rows.get(CLIENT_ID)?.metadataExpiresAt).toBeInstanceOf(Date);

    // Pinned: the socket goes to the IP that passed the public-address check,
    // Host + SNI keep the real name, and only the document's path is asked.
    expect(m.httpsRequest).toHaveBeenCalledTimes(1);
    const opts = m.httpsRequest.mock.calls[0]![0] as Record<string, any>;
    expect(opts.hostname).toBe(PUBLIC_IP);
    expect(opts.headers.host).toBe("studio.example.com");
    expect(opts.servername).toBe("studio.example.com");
    expect(opts.path).toBe("/.well-known/synap-client.json");
    expect(opts.method).toBe("GET");
  });

  it("serves a fresh cached copy without fetching again", async () => {
    serve({});
    const store = memoryStore();
    await resolveCimdClient(CLIENT_ID, ISSUER, store, { lookup: publicDns });
    await resolveCimdClient(CLIENT_ID, ISSUER, store, { lookup: publicDns });
    expect(m.httpsRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps one fetch in flight per client_id", async () => {
    serve({});
    const store = memoryStore();
    await Promise.all([
      resolveCimdClient(CLIENT_ID, ISSUER, store, { lookup: publicDns }),
      resolveCimdClient(CLIENT_ID, ISSUER, store, { lookup: publicDns }),
      resolveCimdClient(CLIENT_ID, ISSUER, store, { lookup: publicDns }),
    ]);
    expect(m.httpsRequest).toHaveBeenCalledTimes(1);
  });
});

// ─── The client_id URL ───────────────────────────────────────────────────────

describe("CIMD — the client_id URL rules (refused before any request)", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["http", "http://studio.example.com/c.json", /https/],
    ["userinfo", "https://user:pw@studio.example.com/c.json", /credentials/],
    ["query", "https://studio.example.com/c.json?x=1", /query/],
    ["fragment", "https://studio.example.com/c.json#x", /fragment/],
    ["dot segment", "https://studio.example.com/a/../c.json", /\. or \.\./],
    ["no path", "https://studio.example.com/", /path/],
    ["IPv4 literal", `https://${PUBLIC_IP}/c.json`, /domain name/],
    ["IPv6 literal", "https://[2606:4700::1111]/c.json", /domain name/],
    ["non-canonical", "https://Studio.Example.com/c.json", /canonical/],
    ["the pod itself", `${ISSUER}/c.json`, /this pod/],
    ["too long", `https://studio.example.com/${"a".repeat(600)}`, /512/],
  ];
  for (const [name, url, reason] of cases) {
    it(`refuses ${name}`, async () => {
      serve({});
      const message = await refusal(
        resolveCimdClient(url, ISSUER, memoryStore(), { lookup: publicDns })
      );
      expect(message).toMatch(reason);
      expect(m.httpsRequest).not.toHaveBeenCalled();
    });
  }

  it("accepts a canonical https URL with a path", () => {
    expect(assertClientMetadataUrl(CLIENT_ID, ISSUER).host).toBe(
      "studio.example.com"
    );
  });
});

// ─── SSRF ────────────────────────────────────────────────────────────────────

describe("CIMD — SSRF: private networks are never reached", () => {
  const privateAnswers: Array<[string, string, number]> = [
    ["loopback", "127.0.0.1", 4],
    ["RFC 1918", "10.0.0.5", 4],
    ["link-local metadata", "169.254.169.254", 4],
    ["IPv6 loopback", "::1", 6],
    ["IPv6 unique-local", "fd00::1", 6],
  ];
  for (const [name, address, family] of privateAnswers) {
    it(`refuses a hostname resolving to ${name} (${address})`, async () => {
      serve({});
      await refusal(
        resolveCimdClient(CLIENT_ID, ISSUER, memoryStore(), {
          lookup: async () => [{ address, family }],
        })
      );
      expect(m.httpsRequest).not.toHaveBeenCalled();
    });
  }

  it("refuses a MIXED public/private answer (DNS rebinding)", async () => {
    serve({});
    await refusal(
      resolveCimdClient(CLIENT_ID, ISSUER, memoryStore(), {
        lookup: async () => [
          { address: PUBLIC_IP, family: 4 },
          { address: "10.0.0.5", family: 4 },
        ],
      })
    );
    expect(m.httpsRequest).not.toHaveBeenCalled();
  });

  it("refuses a local hostname without resolving it", async () => {
    serve({});
    const lookup = vi.fn(publicDns);
    await refusal(
      resolveCimdClient(
        "https://metadata.google.internal/c.json",
        ISSUER,
        memoryStore(),
        { lookup }
      )
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(m.httpsRequest).not.toHaveBeenCalled();
  });

  it("does NOT follow a redirect (one request, refused)", async () => {
    serve({
      status: 302,
      headers: { location: "https://10.0.0.5/c.json" },
    });
    const message = await refusal(
      resolveCimdClient(CLIENT_ID, ISSUER, memoryStore(), {
        lookup: publicDns,
      })
    );
    expect(message).toMatch(/redirect/);
    expect(m.httpsRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses an oversized (6 KB) document", async () => {
    serve({
      body: JSON.stringify(doc({ client_name: "x".repeat(6 * 1024) })),
    });
    const message = await refusal(
      resolveCimdClient(CLIENT_ID, ISSUER, memoryStore(), {
        lookup: publicDns,
      })
    );
    expect(message).toMatch(/exceeded 5120 bytes/);
  });

  it("refuses a slow server after 5 s", async () => {
    vi.useFakeTimers();
    serve({ hang: true });
    const pending = refusal(
      resolveCimdClient(CLIENT_ID, ISSUER, memoryStore(), {
        lookup: publicDns,
      })
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatch(/timed out after 5000ms/);
  });

  it("refuses a document not served as application/json", async () => {
    serve({ headers: { "content-type": "text/html" } });
    expect(
      await refusal(
        resolveCimdClient(CLIENT_ID, ISSUER, memoryStore(), {
          lookup: publicDns,
        })
      )
    ).toMatch(/application\/json/);
  });

  it("refuses a body that is not JSON", async () => {
    serve({ body: "<html>" });
    expect(
      await refusal(
        resolveCimdClient(CLIENT_ID, ISSUER, memoryStore(), {
          lookup: publicDns,
        })
      )
    ).toMatch(/not valid JSON/);
  });
});

// ─── The document ────────────────────────────────────────────────────────────

describe("CIMD — document validation", () => {
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "client_id not equal to the URL",
      { client_id: "https://studio.example.com/other.json" },
      /does not equal/,
    ],
    ["missing redirect_uris", { redirect_uris: undefined }, /redirect_uris/],
    [
      "a cross-origin redirect_uri",
      { redirect_uris: ["https://evil.example/cb"] },
      /same origin/,
    ],
    [
      "a sibling-subdomain redirect_uri",
      { redirect_uris: ["https://evil.studio.example.com/cb"] },
      /same origin/,
    ],
    [
      "an http redirect_uri",
      { redirect_uris: ["http://studio.example.com/cb"] },
      /https/,
    ],
    ["a client_secret", { client_secret: "s3cret" }, /client secret/],
    [
      "client_secret_expires_at",
      { client_secret_expires_at: 0 },
      /client secret/,
    ],
    [
      "a confidential auth method",
      { token_endpoint_auth_method: "client_secret_basic" },
      /"none"/,
    ],
    ["implicit grant", { grant_types: ["implicit"] }, /grant_types/],
    ["a name over 100 chars", { client_name: "n".repeat(101) }, /100/],
    [
      "a cross-origin client_uri",
      { client_uri: "https://evil.example" },
      /same origin/,
    ],
    [
      "a cross-origin initiate_login_uri",
      { initiate_login_uri: "https://evil.example/start" },
      /same origin/,
    ],
    [
      "a gate verb",
      { synap_requests: [{ permission: "proposal.approve" }] },
      /cannot be granted/,
    ],
    [
      "a bare *",
      { synap_requests: [{ permission: "*" }] },
      /subject and an action/,
    ],
    [
      "a * action",
      { synap_requests: [{ permission: "entity.post.*" }] },
      /subject and an action/,
    ],
    [
      "a malformed permission",
      { synap_requests: [{ permission: "Entity Post" }] },
      /Invalid permission/,
    ],
    [
      "too many requests",
      {
        synap_requests: Array.from({ length: 33 }, () => ({
          permission: "entity.post.read",
        })),
      },
      /at most 32/,
    ],
    [
      "synap_templates that is not an array",
      { synap_templates: "content-studio" },
      /synap_templates must be an array/,
    ],
    [
      "a synap_templates entry that is not a slug",
      { synap_templates: ["Content Studio"] },
      /template slug/,
    ],
    [
      "too many synap_templates",
      { synap_templates: Array.from({ length: 9 }, (_, i) => `t${i}`) },
      /at most 8 synap_templates/,
    ],
  ];
  for (const [name, overrides, reason] of refused) {
    it(`refuses ${name}`, () => {
      let message = "";
      try {
        validateClientMetadataDocument(doc(overrides), CLIENT_ID);
      } catch (err) {
        expect(err).toBeInstanceOf(ClientMetadataError);
        message = (err as Error).message;
      }
      expect(message).toMatch(reason);
    });
  }

  it("a Synap app (and only one) may ask for the review verbs, spelled exactly", () => {
    const SYNAP =
      "https://content-studio.synap.live/.well-known/synap-client.json";
    const synapDoc = (permission: string, clientId = SYNAP) => ({
      ...doc(),
      client_id: clientId,
      redirect_uris: [`${new URL(clientId).origin}/api/synap/callback`],
      synap_requests: [{ permission }],
    });
    for (const permission of ["proposal.approve", "proposal.reject"]) {
      expect(
        validateClientMetadataDocument(synapDoc(permission), SYNAP)
          .requestedPermissions
      ).toEqual([permission]);
      // A lookalike origin is any other app: refused, as "a gate verb" above.
      const LOOKALIKE =
        "https://content-studio.synap.live.evil.com/.well-known/synap-client.json";
      expect(() =>
        validateClientMetadataDocument(
          synapDoc(permission, LOOKALIKE),
          LOOKALIKE
        )
      ).toThrow(/cannot be granted/);
    }
    // Every other gate verb stays refused, even for a Synap app.
    for (const permission of ["proposal.merge", "entity.purge", "proposal.*"]) {
      expect(() =>
        validateClientMetadataDocument(synapDoc(permission), SYNAP)
      ).toThrow(ClientMetadataError);
    }
  });

  it("keeps only the mcp.* scopes the AS supports, and a * kind is a plain read", () => {
    const v = validateClientMetadataDocument(
      doc({
        scope: "mcp.read mcp:write admin",
        synap_requests: [{ permission: "entity.*.read" }],
      }),
      CLIENT_ID
    );
    expect(v.scopes).toEqual(["mcp.read", "mcp.write"]);
    expect(v.requestedPermissions).toEqual(["entity.*.read"]);
  });

  it("keeps the declared synap_templates (deduplicated), and none when absent", () => {
    const v = validateClientMetadataDocument(
      doc({ synap_templates: ["content-studio", "crm", "content-studio"] }),
      CLIENT_ID
    );
    expect(v.requestedTemplates).toEqual(["content-studio", "crm"]);
    expect(
      validateClientMetadataDocument(doc({}), CLIENT_ID).requestedTemplates
    ).toEqual([]);
  });

  it("defaults the display name to the client_id host and ignores logo_uri", () => {
    const v = validateClientMetadataDocument(
      doc({ client_name: undefined, logo_uri: "https://cdn.evil/logo.png" }),
      CLIENT_ID
    );
    expect(v.clientName).toBe("studio.example.com");
    expect(JSON.stringify(v)).not.toContain("logo");
  });

  it("an invalid fetched document is refused and never cached", async () => {
    serve({
      body: JSON.stringify(doc({ redirect_uris: ["https://evil/cb"] })),
    });
    const store = memoryStore();
    await refusal(
      resolveCimdClient(CLIENT_ID, ISSUER, store, { lookup: publicDns })
    );
    expect(store.rows.size).toBe(0);
  });
});

// ─── Cache ───────────────────────────────────────────────────────────────────

describe("CIMD — cache freshness", () => {
  it("honours Cache-Control within [5 min, 24 h]", () => {
    expect(cimdCacheTtlMs(undefined)).toBe(CIMD_MIN_TTL_MS);
    expect(cimdCacheTtlMs("no-store")).toBe(CIMD_MIN_TTL_MS);
    expect(cimdCacheTtlMs("max-age=60")).toBe(CIMD_MIN_TTL_MS);
    expect(cimdCacheTtlMs("public, max-age=3600")).toBe(3_600_000);
    expect(cimdCacheTtlMs("max-age=9999999")).toBe(CIMD_MAX_TTL_MS);
  });

  it("refetches once the copy is stale", async () => {
    serve({}, {});
    const store = memoryStore();
    let now = Date.UTC(2026, 9, 20, 12);
    await resolveCimdClient(CLIENT_ID, ISSUER, store, {
      lookup: publicDns,
      now: () => now,
    });
    now += CIMD_MIN_TTL_MS + 1;
    await resolveCimdClient(CLIENT_ID, ISSUER, store, {
      lookup: publicDns,
      now: () => now,
    });
    expect(m.httpsRequest).toHaveBeenCalledTimes(2);
  });

  it("a FETCH failure falls back to a copy younger than 24 h", async () => {
    serve({}, { status: 503 });
    const store = memoryStore();
    let now = Date.UTC(2026, 9, 20, 12);
    await resolveCimdClient(CLIENT_ID, ISSUER, store, {
      lookup: publicDns,
      now: () => now,
    });
    now += 60 * 60 * 1000;
    const client = await resolveCimdClient(CLIENT_ID, ISSUER, store, {
      lookup: publicDns,
      now: () => now,
    });
    expect(client.redirectUris).toEqual([CALLBACK]);
  });

  it("no fallback for a copy older than 24 h", async () => {
    serve({}, { status: 503 });
    const store = memoryStore();
    let now = Date.UTC(2026, 9, 20, 12);
    await resolveCimdClient(CLIENT_ID, ISSUER, store, {
      lookup: publicDns,
      now: () => now,
    });
    now += 25 * 60 * 60 * 1000;
    await refusal(
      resolveCimdClient(CLIENT_ID, ISSUER, store, {
        lookup: publicDns,
        now: () => now,
      })
    );
  });

  it("no fallback when the refreshed document is INVALID (the app changed it)", async () => {
    serve(
      {},
      { body: JSON.stringify(doc({ redirect_uris: ["https://evil/cb"] })) }
    );
    const store = memoryStore();
    let now = Date.UTC(2026, 9, 20, 12);
    await resolveCimdClient(CLIENT_ID, ISSUER, store, {
      lookup: publicDns,
      now: () => now,
    });
    now += CIMD_MIN_TTL_MS + 1;
    await refusal(
      resolveCimdClient(CLIENT_ID, ISSUER, store, {
        lookup: publicDns,
        now: () => now,
      })
    );
  });

  it("a DCR row is never read as a document", async () => {
    serve({});
    const store = memoryStore();
    store.rows.set(CLIENT_ID, {
      clientId: CLIENT_ID,
      clientKind: "dcr",
      clientName: "squatter",
      redirectUris: ["https://evil.example/cb"],
      scopes: ["mcp.read"],
      requestedPermissions: [],
      createdAt: new Date(),
      metadataExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const client = await resolveCimdClient(CLIENT_ID, ISSUER, store, {
      lookup: publicDns,
    });
    expect(m.httpsRequest).toHaveBeenCalledTimes(1);
    expect(client.redirectUris).toEqual([CALLBACK]);
  });
});
