import { describe, it, expect } from "vitest";

/**
 * `isOutputRefVisible` — the `url` arm.
 *
 * A `url` output has no backing row, so there is no visibility floor to apply
 * and the door accepted ANY string. But the string is not inert: the session
 * room renders it as a link, so `javascript:` / `data:` refs were a stored
 * script vector written by an authenticated caller and clicked by anyone who
 * can see the session.
 *
 * The scheme gate is `isHttpUrl` (@synap/shared-utils) — scheme-only, NOT
 * `validateExternalUrl` (the SSRF door): a session output URL is never
 * fetched by the pod, only rendered as a link, so a developer must be able to
 * record `http://localhost:3000/thing`. Loopback/private-host rejection is
 * deliberately NOT applied here — that's a decision for the outbound-fetch
 * guard, not this display-only reference.
 *
 * No DB is reached: this arm returns before any query.
 */

const { isOutputRefVisible } = await import("../assert-output-ref-visible.js");

const check = (refId: string) =>
  isOutputRefVisible({ userId: "user-1", kind: "url", refId });

describe("isOutputRefVisible — url scheme floor", () => {
  it("accepts http and https", async () => {
    await expect(check("https://example.com/spec")).resolves.toBe(true);
    await expect(check("http://example.com/spec")).resolves.toBe(true);
  });

  it("refuses a script-capable or non-network scheme", async () => {
    // The whole reason this arm validates at all.
    await expect(check("javascript:alert(1)")).resolves.toBe(false);
    await expect(
      check("data:text/html,<script>alert(1)</script>")
    ).resolves.toBe(false);
    await expect(check("ftp://example.com/x")).resolves.toBe(false);
  });

  it("refuses a non-url string", async () => {
    // `refId` is only `z.string().min(1)` on both doors, so this is reachable.
    await expect(check("not a url")).resolves.toBe(false);
    await expect(check("example.com")).resolves.toBe(false);
  });

  it("accepts a loopback/private host — a developer must be able to record a local URL", async () => {
    // Deliberate: nothing FETCHES a url output, it is only rendered as a link,
    // so the SSRF door's loopback/private-host rejection does not apply here.
    await expect(check("http://localhost:3000/thing")).resolves.toBe(true);
    await expect(check("http://192.168.1.10/thing")).resolves.toBe(true);
  });

  it("still accepts a cell ref, which has no backing row and no url shape", async () => {
    await expect(
      isOutputRefVisible({ userId: "user-1", kind: "cell", refId: "some-cell" })
    ).resolves.toBe(true);
  });
});
