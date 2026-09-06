import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OPEN_CLIENT_MOBILE,
  OPEN_CLIENT_PARAM,
  TYPED_OPEN_KINDS,
} from "./open-dispatch.js";

// Frozen copy of pod-admin HOST_TYPES ∪ BOUNCE_TYPES (open-params.ts).
// Do not import that file from apps/api — tsc rootDir cannot leave src/.
// If you change either list, update both this snapshot and open-params.ts.
const POD_ADMIN_HOST_TYPES = ["entity", "view"] as const;
const POD_ADMIN_BOUNCE_TYPES = [
  "proposal",
  "document",
  "cell",
  "channel",
  "session",
  "project",
  "workspace",
  "capability",
] as const;

// Frozen copy of TYPED_DEEP_LINK_KINDS (packages/api/src/utils/deep-links.ts).
// `openTypedLink` may only emit kinds the typed route actually serves; a kind
// added there without a route is a dead link, which is worse than none.
const DEEP_LINK_EMITTED_KINDS = ["capability"] as const;

describe("open kinds lock", () => {
  it("every kind deep-links.ts emits is served by TYPED_OPEN_KINDS", () => {
    for (const kind of DEEP_LINK_EMITTED_KINDS) {
      expect(TYPED_OPEN_KINDS as readonly string[]).toContain(kind);
    }
  });

  it("pod-admin HOST ∪ BOUNCE equals TYPED_OPEN_KINDS", () => {
    const fromPodAdmin = [
      ...POD_ADMIN_HOST_TYPES,
      ...POD_ADMIN_BOUNCE_TYPES,
    ].sort();
    const fromApi = [...TYPED_OPEN_KINDS].sort();
    expect(fromPodAdmin).toEqual(fromApi);
  });
});

// Frozen copy of the PRODUCER's device flavour
// (packages/api/src/utils/deep-links.ts: `OPEN_CLIENT_PARAM` and the sole
// member of `OpenLinkClient`). apps/api cannot import packages/api here — the
// same rootDir reason the pod-admin lists above are frozen — so the producer's
// literals are pinned by value. `openLink(id, { client: "mobile" })` emits
// exactly `?<param>=<value>`; if either side is renamed, this fails.
const PRODUCER_CLIENT_QUERY = "client=mobile";

describe("open client discriminator lock", () => {
  it("producer query string matches the route's param + value", () => {
    expect(`${OPEN_CLIENT_PARAM}=${OPEN_CLIENT_MOBILE}`).toBe(
      PRODUCER_CLIENT_QUERY
    );
  });
});

// ---------------------------------------------------------------------------
// Cache-safety tripwire for the /open route.
//
// `dispatchOpen` now returns a DIFFERENT answer for the same URL depending on
// the request's User-Agent (bot vs human) — and a different answer for a
// different URL when `?client=mobile` is present. The query param varies the
// cache key by itself; the User-Agent does NOT, so `Vary: User-Agent` plus a
// private/no-store policy is the only thing stopping a CDN from serving one
// device's branch to another. That header pair is set in `applyOpenDispatch`
// (index.ts) and is unreachable from a unit test, so it is pinned by scanning
// the source — the same shape as the repo's other projection tripwires.
// ---------------------------------------------------------------------------

const INDEX_SRC = readFileSync(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
  "utf8"
);

describe("open route cache headers", () => {
  const body = INDEX_SRC.slice(
    INDEX_SRC.indexOf("function applyOpenDispatch"),
    INDEX_SRC.indexOf('app.get("/open/:type/:id"')
  );

  it("applyOpenDispatch is the single dispatch site and is present", () => {
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("dispatchOpen({");
  });

  it("still sets Vary: User-Agent", () => {
    expect(body).toContain('c.header("Vary", "User-Agent")');
  });

  it("still sets a private, no-store cache policy", () => {
    expect(body).toContain('c.header("Cache-Control", "private, no-store")');
  });

  it("passes the device discriminator through from the query string", () => {
    expect(body).toContain("client: c.req.query(OPEN_CLIENT_PARAM)");
  });
});
