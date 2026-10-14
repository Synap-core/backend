import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  isPublicAddress,
  safePublicFetch,
  type AddressResolver,
} from "./pinned-fetch.js";

/**
 * DNS rebinding: a hostname that passes `validateExternalUrl` (no private
 * pattern in the NAME) but resolves to a private address must be refused —
 * on the first hop AND on a redirect hop — and the connection must go to the
 * address that was vetted, never a second resolution.
 *
 * The server below listens on 127.0.0.1. Hostnames like `img.test` do not
 * exist in real DNS, so a request that reaches the server proves the socket
 * used the PINNED address from the stubbed resolver.
 */

let server: http.Server;
let port = 0;
const seen: Array<{ host?: string; url?: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url });
    if (req.url === "/redirect-internal") {
      res.writeHead(302, {
        location: `http://internal.test:${port}/secret`,
      });
      res.end();
      return;
    }
    if (req.url === "/redirect-ok") {
      res.writeHead(302, { location: `/final` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "image/png", "x-hop": req.url ?? "" });
    res.end("PNGBYTES");
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

/** Treat only the test server's loopback as "public" for the positive cases. */
const loopbackIsTheInternet = (a: string) => a === "127.0.0.1";

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.1.1",
    "169.254.169.254",
    "169.254.170.2",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::10.0.0.1",
  ])("refuses %s", (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"])(
    "accepts %s",
    (ip) => expect(isPublicAddress(ip)).toBe(true)
  );

  it("refuses a non-address", () => expect(isPublicAddress("evil")).toBe(false));
});

describe("safePublicFetch — DNS rebinding", () => {
  it("refuses a public-looking name that resolves to a private address", async () => {
    const before = seen.length;
    await expect(
      safePublicFetch(`http://rebind.test:${port}/x`, {}, 0, {
        resolve: table({ "rebind.test": ["127.0.0.1"] }),
      })
    ).rejects.toThrow(/^Blocked outbound request: .*private or reserved/);
    expect(seen.length).toBe(before); // never connected
  });

  it("refuses when ANY of the resolved addresses is private", async () => {
    await expect(
      safePublicFetch(`http://mixed.test:${port}/x`, {}, 0, {
        resolve: table({ "mixed.test": ["93.184.216.34", "10.0.0.5"] }),
      })
    ).rejects.toThrow(/Blocked outbound request/);
  });

  it("connects to the PINNED address (the name does not exist in real DNS)", async () => {
    const res = await safePublicFetch(`http://img.test:${port}/a.png`, {}, 0, {
      resolve: table({ "img.test": ["127.0.0.1"] }),
      isAllowedAddress: loopbackIsTheInternet,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("PNGBYTES");
    expect(seen.at(-1)).toEqual({ host: `img.test:${port}`, url: "/a.png" });
  });

  it("re-vets every redirect hop: a hop to a private address is refused", async () => {
    const before = seen.length;
    await expect(
      safePublicFetch(`http://img.test:${port}/redirect-internal`, {}, 3, {
        resolve: table({
          "img.test": ["127.0.0.1"],
          "internal.test": ["10.0.0.5"],
        }),
        isAllowedAddress: loopbackIsTheInternet,
      })
    ).rejects.toThrow(/Blocked outbound request: .*10\.0\.0\.5/);
    expect(seen.slice(before).map((s) => s.url)).toEqual(["/redirect-internal"]);
  });

  it("follows an allowed redirect within the hop budget, and refuses past it", async () => {
    const deps = {
      resolve: table({ "img.test": ["127.0.0.1"] }),
      isAllowedAddress: loopbackIsTheInternet,
    };
    const res = await safePublicFetch(
      `http://img.test:${port}/redirect-ok`,
      {},
      1,
      deps
    );
    expect(res.headers.get("x-hop")).toBe("/final");
    await expect(
      safePublicFetch(`http://img.test:${port}/redirect-ok`, {}, 0, deps)
    ).rejects.toThrow(/too many redirects/);
  });

  it("still applies the hostname guard first", async () => {
    await expect(
      safePublicFetch("http://localhost/", {}, 0, {
        resolve: table({ localhost: ["93.184.216.34"] }),
      })
    ).rejects.toThrow(/Blocked outbound request/);
  });
});
