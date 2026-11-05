/**
 * Provider-verb engine — `bodyFrom`: one call parameter whose object value IS
 * the provider's fields (a generic verb such as Stripe's `stripe_api_write`).
 *
 * `triggerProviderAction` is mocked: these assert what the engine hands the
 * dispatcher (method, path, query, body) and the governance flag, from the real
 * spec through the real request builder. The form encoding of a POST body is
 * the tool's (`form-body.vault.test.ts`); a GET's object goes into the query
 * string here, through the same encoder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../connectors/external-dispatch.js", () => ({
  triggerProviderAction: vi.fn(),
}));

import {
  buildProviderRequest,
  executeProviderVerb,
} from "./execute-provider-verb.js";
import { triggerProviderAction } from "../../connectors/external-dispatch.js";
import type { ProviderVerbSpec } from "@synap/database/schema";

const mockDispatch = vi.mocked(triggerProviderAction);

const write: ProviderVerbSpec = {
  tool: "stripe",
  method: "POST",
  pathTemplate: "{{path}}",
  bodyFrom: "params",
  paramMapping: { path: { required: true } },
};
const read: ProviderVerbSpec = { ...write, method: "GET" };

beforeEach(() => {
  vi.clearAllMocks();
  mockDispatch.mockResolvedValue({ success: true, body: { ok: 1 } } as never);
});

describe("buildProviderRequest — bodyFrom", () => {
  it("POST: the object becomes the body, nested values intact", () => {
    const parts = buildProviderRequest(write, {
      path: "/v1/tax/settings",
      params: { defaults: { tax_behavior: "exclusive" } },
    });
    expect(parts).toMatchObject({
      method: "POST",
      path: "/v1/tax/settings",
      query: "",
      body: { defaults: { tax_behavior: "exclusive" } },
    });
  });

  it("POST: a JSON-object string is parsed (callers that only send strings)", () => {
    const parts = buildProviderRequest(write, {
      path: "/v1/customers",
      params: '{"email":"a@b.fr","metadata":{"k":"v"}}',
    });
    expect(parts.body).toEqual({ email: "a@b.fr", metadata: { k: "v" } });
  });

  it("POST: merged over the spec's fixed body, the caller's fields winning", () => {
    const parts = buildProviderRequest(
      { ...write, body: { fixed: "1", mode: "spec" } },
      { path: "/v1/x", params: { mode: "caller" } }
    );
    expect(parts.body).toEqual({ fixed: "1", mode: "caller" });
  });

  it("POST: no params → no body from it (a call with no fields)", () => {
    expect(
      buildProviderRequest(write, { path: "/v1/invoices/in_1/finalize" }).body
    ).toBeUndefined();
  });

  it("GET and DELETE: the object is form-encoded into the query string, after the spec's own query", () => {
    const get = buildProviderRequest(
      { ...read, query: { limit: "{{limit}}" } },
      {
        path: "/v1/customers",
        limit: 5,
        params: { email: "a@b.fr", expand: ["data.invoice_settings"] },
      }
    );
    expect(get.body).toBeUndefined();
    expect([...new URLSearchParams(get.query)]).toEqual([
      ["limit", "5"],
      ["email", "a@b.fr"],
      ["expand[0]", "data.invoice_settings"],
    ]);
    const del = buildProviderRequest(
      { ...write, method: "DELETE" },
      { path: "/v1/coupons/c1", params: { a: "1" } }
    );
    expect(del.query).toBe("a=1");
    expect(del.body).toBeUndefined();
  });

  it("refuses a non-object value with the parameter's name, before any call", () => {
    for (const bad of [[1, 2], 42, "not json", "[1]", true]) {
      expect(() =>
        buildProviderRequest(write, { path: "/v1/x", params: bad })
      ).toThrow(/parameter "params" must be an object/);
    }
  });

  it("a spec without bodyFrom ignores a same-named parameter (unchanged behaviour)", () => {
    const parts = buildProviderRequest(
      { method: "POST", pathTemplate: "/x", body: { a: "{{a}}" } },
      { a: "1", params: { injected: true } }
    );
    expect(parts.body).toEqual({ a: "1" });
  });
});

describe("executeProviderVerb — bodyFrom governance", () => {
  it("a POST through bodyFrom is a WRITE: the tool gate runs (alreadyApproved:false)", async () => {
    await executeProviderVerb(
      write,
      {
        path: "/v1/tax/settings",
        params: { defaults: { tax_behavior: "exclusive" } },
      },
      { userId: "u1" }
    );
    const call = mockDispatch.mock.calls[0]![0] as {
      method: string;
      path: string;
      body: unknown;
      alreadyApproved: boolean;
    };
    expect(call).toMatchObject({
      method: "POST",
      path: "/v1/tax/settings",
      body: { defaults: { tax_behavior: "exclusive" } },
      alreadyApproved: false,
    });
  });

  it("a GET through bodyFrom is a READ (alreadyApproved:true), its fields in the path's query", async () => {
    await executeProviderVerb(
      read,
      { path: "/v1/tax/registrations", params: { status: "active" } },
      { userId: "u1" }
    );
    const call = mockDispatch.mock.calls[0]![0] as {
      path: string;
      alreadyApproved: boolean;
    };
    expect(call.path).toBe("/v1/tax/registrations?status=active");
    expect(call.alreadyApproved).toBe(true);
  });
});

describe('buildProviderRequest — encode: "path" (a generic verb\'s resource path)', () => {
  const generic: ProviderVerbSpec = {
    tool: "stripe",
    method: "POST",
    pathTemplate: "/v1/{{path}}",
    bodyFrom: "params",
    paramMapping: { path: { required: true, encode: "path" } },
  };

  it("keeps the slashes between segments and encodes each segment", () => {
    expect(buildProviderRequest(generic, { path: "tax/settings" }).path).toBe(
      "/v1/tax/settings"
    );
    expect(
      buildProviderRequest(generic, {
        path: "/customers/cus 1/balance_transactions/",
      }).path
    ).toBe("/v1/customers/cus%201/balance_transactions");
  });

  it("a ? # % or backslash stays inside its segment: no query, fragment or second decoding smuggled", () => {
    const p = buildProviderRequest(generic, {
      path: "customers?email=x#frag/%2e%2e/a\\b",
    }).path;
    expect(p).toBe("/v1/customers%3Femail%3Dx%23frag/%252e%252e/a%5Cb");
    expect(
      new URL(p, "https://api.stripe.com").pathname.startsWith("/v1/")
    ).toBe(true);
  });

  it('refuses an empty, "." or ".." segment before any call (it would climb out of /v1/)', () => {
    for (const bad of [
      "../v2/core/accounts",
      "customers/../../x",
      "a//b",
      ".",
      "/",
    ]) {
      expect(() => buildProviderRequest(generic, { path: bad })).toThrow(
        /parameter "path" must be a relative path of named segments/
      );
    }
  });

  it('"uri" still encodes the whole value as one segment (unchanged)', () => {
    const one = buildProviderRequest(
      { ...generic, paramMapping: { path: { required: true, encode: "uri" } } },
      { path: "tax/settings" }
    );
    expect(one.path).toBe("/v1/tax%2Fsettings");
  });
});
