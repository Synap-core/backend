import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { validateExternalUrl } from "./validate-url.js";
import { safePublicFetch, type AddressResolver } from "./pinned-fetch.js";

/**
 * The SSRF guard read the hostname with regexes only. Measured 2026-10-28
 * (pre-launch audit, governance F5): `http://kratos.:4434/` (trailing dot),
 * `http://[::ffff:127.0.0.1]/`, `http://[::]/`, any Docker service name
 * (`backend`, `pod-agent`, `realtime`) and a public name resolving to a private
 * address all passed it, and the fetching door did no resolution. From the
 * backend container that reaches the unauthenticated Kratos admin API on
 * :4434: list identities, mint the owner's recovery link.
 */
describe("validateExternalUrl: the URL text cannot name an internal target", () => {
  const anyPort = { allowedPorts: "any" as const };

  it.each([
    "http://kratos.:4434/admin/identities", // trailing dot
    "http://kratos./",
    "http://kratos../",
    "http://[::ffff:127.0.0.1]:4434/admin/identities", // IPv4-mapped
    "http://[::ffff:7f00:1]/",
    "http://[::]:4000/", // unspecified
    "http://[::ffff:a9fe:a9fe]/", // mapped cloud metadata
    "http://[64:ff9b::a00:5]/", // NAT64 of 10.0.0.5
    "http://backend:4000/", // Docker service names: any single label
    "http://pod-agent:4002/",
    "http://realtime/",
    "http://dozzle:8080/",
    "http://0x7f.1/", // shorthand IPv4 (URL normalises it to 127.0.0.1)
    "http://2130706433/",
    "http://100.100.1.1/", // CGNAT beyond 100.64.x
    "http://198.18.0.1/",
    "http://svc.internal/",
    "http://printer.local/",
    "http://a.localhost/",
  ])("refuses %s", (url) => {
    expect(validateExternalUrl(url, anyPort).valid, url).toBe(false);
  });

  it("refuses a non-web port by default and allows it when the caller lifts the limit", () => {
    expect(validateExternalUrl("https://api.vendor.com:8443/x").valid).toBe(
      false
    );
    expect(
      validateExternalUrl("https://api.vendor.com:8443/x", anyPort).valid
    ).toBe(true);
  });

  it.each([
    "https://api.vendor.com/v1",
    "http://example.com./x", // a public absolute name stays allowed
    "http://93.184.216.34/",
    "https://[2606:2800:220:1:248:1893:25c8:1946]/",
  ])("allows %s", (url) => {
    expect(validateExternalUrl(url).valid, url).toBe(true);
  });
});

describe("safePublicFetch: sends a body, and refuses a public name that resolves inside", () => {
  let server: http.Server;
  let port = 0;
  const received: Array<{ method?: string; len?: string; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({
          method: req.method,
          len: req.headers["content-length"],
          body,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const table =
    (map: Record<string, string[]>): AddressResolver =>
    async (host) =>
      (map[host] ?? []).map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }));

  it("refuses localtest.me-style names (public name, loopback answer) before connecting", async () => {
    const before = received.length;
    await expect(
      safePublicFetch(`http://localtest.me:${port}/x`, {}, 0, {
        resolve: table({ "localtest.me": ["127.0.0.1"] }),
        allowedPorts: "any",
      })
    ).rejects.toThrow(/private or reserved/);
    expect(received.length).toBe(before);
  });

  it("POSTs its body with a Content-Length to the pinned address", async () => {
    const res = await safePublicFetch(
      `http://hook.test:${port}/in`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "wörld" }),
      },
      0,
      {
        resolve: table({ "hook.test": ["127.0.0.1"] }),
        isAllowedAddress: (a) => a === "127.0.0.1",
        allowedPorts: "any",
      }
    );
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ ok: true });
    const last = received.at(-1)!;
    expect(last.method).toBe("POST");
    expect(last.body).toBe(JSON.stringify({ hello: "wörld" }));
    expect(last.len).toBe(String(Buffer.byteLength(last.body)));
  });
});
