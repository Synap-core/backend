import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A vault:// tool whose API takes form bodies (`config.bodyEncoding: "form"`,
 * Stripe v1) sends `application/x-www-form-urlencoded` with bracket nesting;
 * every other tool keeps sending JSON, byte for byte.
 *
 * SEAM: the real `vaultHandler` (`__vaultHandlerForTests`), with the secret row
 * as the database returns it, and the pinned door (`safePublicFetch`) recorded.
 * The assertion is the request on the wire: URL, headers, body.
 *
 * NOT covered here: the capability gate before the handler (a write is proposed
 * there; the approved replay reaches this same handler with the same tool row,
 * which is why the encoding lives on the tool), and the encoder's own cases
 * (`form-encode.test.ts`).
 */

const h = vi.hoisted(() => ({
  mockResolveVaultSecret: vi.fn(),
  mockFindFirst: vi.fn(),
  sent: [] as Array<{ url: string; init: RequestInit }>,
}));

vi.mock("@synap/shared-utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safePublicFetch: async (url: string, init: RequestInit = {}) => {
    h.sent.push({ url, init });
    return new Response(JSON.stringify({ object: "tax.settings" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

vi.mock("../utils/vault-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveVaultSecret: h.mockResolveVaultSecret,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([]),
  };
  return {
    ...actual,
    db: {
      query: { secrets: { findFirst: h.mockFindFirst } },
      select: () => chain,
    },
  };
});

const { __vaultHandlerForTests: vaultHandler } =
  await import("./external-dispatch.js");

const STRIPE = {
  baseUrl: "https://api.stripe.com",
  auth: { in: "header", name: "Authorization", prefix: "Bearer " },
};

function run(
  config: Record<string, unknown>,
  call: { method: string; path: string; body?: Record<string, unknown> }
) {
  return vaultHandler({
    input: {
      userId: "owner-1",
      provider: "vault://secret-1",
      method: call.method,
      path: call.path,
      body: call.body,
      headers: { "Content-Type": "text/plain", "x-v": "1" },
    },
    tool: {
      id: "tool-stripe",
      name: "stripe",
      kind: "provider",
      credentialRef: "vault://secret-1",
      config,
    },
  } as never);
}

const headersOf = (i: number) =>
  h.sent[i]!.init.headers as Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  h.sent.length = 0;
  h.mockFindFirst.mockResolvedValue({
    userId: "owner-1",
    providerIntegrationId: null,
    accountHint: null,
    isPodWide: false,
    capabilityId: null,
  });
  h.mockResolveVaultSecret.mockResolvedValue("rk_test_123");
});

describe("vault:// body encoding", () => {
  it("a form tool sends a bracket-nested form body, auth and Content-Type winning over caller headers", async () => {
    const r = await run(
      { ...STRIPE, bodyEncoding: "form" },
      {
        method: "POST",
        path: "/v1/tax/settings",
        body: {
          defaults: { tax_behavior: "exclusive" },
          head_office: { address: { country: "FR" } },
        },
      }
    );
    expect(r).toMatchObject({ success: true, status: 200 });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.url).toBe("https://api.stripe.com/v1/tax/settings");
    expect(h.sent[0]!.init.method).toBe("POST");
    expect(headersOf(0)).toEqual({
      "x-v": "1",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Bearer rk_test_123",
    });
    expect(h.sent[0]!.init.body).toBe(
      "defaults%5Btax_behavior%5D=exclusive&head_office%5Baddress%5D%5Bcountry%5D=FR"
    );
    expect(
      Object.fromEntries(new URLSearchParams(String(h.sent[0]!.init.body)))
    ).toEqual({
      "defaults[tax_behavior]": "exclusive",
      "head_office[address][country]": "FR",
    });
  });

  it("a tool without bodyEncoding still sends JSON, unchanged", async () => {
    await run(STRIPE, {
      method: "POST",
      path: "/v1/things",
      body: { a: { b: 1 } },
    });
    expect(headersOf(0)["Content-Type"]).toBe("application/json");
    expect(h.sent[0]!.init.body).toBe('{"a":{"b":1}}');
  });

  it('any other bodyEncoding value is JSON (only "form" switches)', async () => {
    await run(
      { ...STRIPE, bodyEncoding: "FORM" },
      { method: "POST", path: "/v1/things", body: { a: 1 } }
    );
    expect(headersOf(0)["Content-Type"]).toBe("application/json");
    expect(h.sent[0]!.init.body).toBe('{"a":1}');
  });

  it("a form tool with no body sends no body and no Content-Type (a GET)", async () => {
    await run(
      { ...STRIPE, bodyEncoding: "form" },
      { method: "GET", path: "/v1/tax/settings" }
    );
    expect(h.sent[0]!.init.body).toBeUndefined();
    expect(headersOf(0)["Content-Type"]).toBe("text/plain");
    expect(headersOf(0).Authorization).toBe("Bearer rk_test_123");
  });
});
