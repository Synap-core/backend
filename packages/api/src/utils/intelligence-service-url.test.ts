/**
 * `fetchIntelligenceService`: the one door a resolved intelligence-service URL
 * is called through (finding e90aa057, decision d8bf5f0e).
 *
 * A registered service URL is checked as TEXT when it is written; the name is
 * resolved at every call. Before this door, `intelligence.ts` and
 * `capabilities.ts` called it with the bare global `fetch` carrying the
 * service key, so a public name re-pointed at cloud metadata or a private
 * address (DNS rebinding), or a row a sync peer wrote unchecked, received the
 * key inside the pod's network.
 *
 * Real: the pinned door `safePublicFetch` (an injected resolver stands in for
 * DNS), the env rung `envIntelligenceEndpoint`. Stubbed: the global `fetch`
 * (a recorder), so the operator branch is observed without a network.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { isBlockedOutboundError } from "@synap/shared-utils";
import { fetchIntelligenceService } from "./intelligence-service-url.js";

const globalFetch = vi.fn(async () => new Response("operator-ok"));

const savedEnv = process.env.INTELLIGENCE_HUB_URL;
afterEach(() => {
  globalFetch.mockClear();
  vi.unstubAllGlobals();
  if (savedEnv === undefined) delete process.env.INTELLIGENCE_HUB_URL;
  else process.env.INTELLIGENCE_HUB_URL = savedEnv;
});

const stubFetch = () => vi.stubGlobal("fetch", globalFetch);

async function refusal(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as Error
  );
  expect(err, "the request was expected to be refused").not.toBeNull();
  return err!;
}

describe("fetchIntelligenceService: a registered service goes through the pinned door", () => {
  it("cloud metadata as a registered URL is refused, and the bare fetch is never used", async () => {
    stubFetch();
    process.env.INTELLIGENCE_HUB_URL = "http://10.10.0.20:3001";
    const err = await refusal(
      fetchIntelligenceService("http://169.254.169.254/latest/meta-data", {
        headers: { "X-API-Key": "svc-key" },
      })
    );
    expect(isBlockedOutboundError(err)).toBe(true);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("a public name that RESOLVES to a private address is refused (DNS rebinding)", async () => {
    stubFetch();
    const err = await refusal(
      fetchIntelligenceService(
        "https://is.rebind.example/api/hub/memory",
        { headers: { "X-API-Key": "svc-key" } },
        { resolve: async () => [{ address: "10.0.0.5", family: 4 }] }
      )
    );
    expect(isBlockedOutboundError(err)).toBe(true);
    expect(err.message).toMatch(/private or reserved address \(10\.0\.0\.5\)/);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("a dotted Docker name resolving to the bridge network is refused", async () => {
    stubFetch();
    const err = await refusal(
      fetchIntelligenceService(
        "http://kratos.internal:4434/admin/identities",
        {},
        { resolve: async () => [{ address: "172.18.0.4", family: 4 }] }
      )
    );
    expect(isBlockedOutboundError(err)).toBe(true);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("the operator's host on ANOTHER port is not the operator's endpoint", async () => {
    stubFetch();
    process.env.INTELLIGENCE_HUB_URL = "http://10.10.0.20:3001";
    const err = await refusal(
      fetchIntelligenceService("http://10.10.0.20:5432/")
    );
    expect(isBlockedOutboundError(err)).toBe(true);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe("fetchIntelligenceService: the operator's configured endpoint still works", () => {
  it("INTELLIGENCE_HUB_URL on a private address is called as configured", async () => {
    stubFetch();
    process.env.INTELLIGENCE_HUB_URL = "http://10.10.0.20:3001";
    const res = await fetchIntelligenceService(
      "http://10.10.0.20:3001/api/manifest",
      { method: "GET", headers: { Authorization: "Bearer k" } }
    );
    expect(await res.text()).toBe("operator-ok");
    expect(globalFetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://10.10.0.20:3001/api/manifest");
    expect(init.headers).toEqual({ Authorization: "Bearer k" });
  });

  it("a Docker service name as INTELLIGENCE_HUB_URL is called as configured", async () => {
    stubFetch();
    process.env.INTELLIGENCE_HUB_URL = "http://intelligence-hub:3001/";
    await fetchIntelligenceService("http://intelligence-hub:3001/api/skills");
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});

describe("fetchIntelligenceService: a public registered service is reached, key in the header", () => {
  let server: http.Server;
  let port = 0;
  const seen: Array<{ url?: string; key?: string | string[] }> = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, key: req.headers["x-api-key"] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("goes through the pinned door (its resolver is consulted) and returns the answer", async () => {
    stubFetch();
    const resolve = vi.fn(async () => [
      { address: "127.0.0.1", family: 4 as const },
    ]);
    const res = await fetchIntelligenceService(
      `http://is.vendor.example:${port}/api/hub/memory`,
      { headers: { "X-API-Key": "svc-key" } },
      // The test server is on loopback; the address rule is lifted for it
      // only, the resolver is the evidence the pinned door ran.
      { resolve, isAllowedAddress: () => true }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(resolve).toHaveBeenCalledWith("is.vendor.example");
    expect(seen.at(-1)).toEqual({ url: "/api/hub/memory", key: "svc-key" });
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
