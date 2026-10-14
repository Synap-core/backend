import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OPEN_CLIENT_MOBILE,
  OPEN_CLIENT_PARAM,
  TYPED_OPEN_KINDS,
} from "./open-dispatch.js";
import { stripComments } from "../../../scripts/strip-comments.mjs";

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
  "settings",
  "skill",
  "tool",
  "playbook",
  "automation",
  "agent",
  "run",
] as const;

// Frozen copy of TYPED_DEEP_LINK_KINDS (packages/api/src/utils/deep-links.ts).
// `openTypedLink` may only emit kinds the typed route actually serves; a kind
// added there without a route is a dead link, which is worse than none.
const DEEP_LINK_EMITTED_KINDS = ["capability", "settings"] as const;

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

// ---------------------------------------------------------------------------
// TYPED_OPEN_KINDS ⊇ the canonical resolver's routable labels.
//
// `GET /api/hub/resolve/:id` (packages/api) names an id's kind with a label from
// `EMITTABLE_LABELS` (resolve-browser-route.ts) — every one an `object-nav.ts`
// arm. A typed link `/open/<label>/<id>` for any of them must be SERVED here,
// or it is a 400 "Invalid deep link" for a kind the app can open (the skill /
// playbook / automation dead links of 2026-10-12).
//
// DERIVED, never a third hand list: apps/api cannot import packages/api (tsc
// rootDir, see above), so the labels are PARSED off the projection's own
// source — every `label: "<word>"` in code (comments stripped). WHAT THIS CANNOT
// SEE: a label built any other way (a variable, a template string, a spread
// from another module). The non-vacuity checks below pin that the parse still
// finds the table and a literal sample of it.
// ---------------------------------------------------------------------------

const ROUTE_PROJECTION_PATH = fileURLToPath(
  new URL(
    "../../../packages/api/src/routers/hub-protocol/rest/resolve-browser-route.ts",
    import.meta.url
  )
);

const LABEL_LITERAL = /\blabel:\s*"([a-z_-]+)"/g;

function parseEmittableLabels(source: string): Set<string> {
  const labels = new Set<string>();
  for (const m of stripComments(source, "ts").matchAll(LABEL_LITERAL)) {
    labels.add(m[1]!);
  }
  return labels;
}

describe("typed open route serves every label the resolver emits", () => {
  const source = readFileSync(ROUTE_PROJECTION_PATH, "utf8");
  const labels = parseEmittableLabels(source);

  it("the parser sees labels in code and ignores them in comments (fixture)", () => {
    const fixture = [
      "const T = {",
      '  a: { label: "alpha" },',
      '  b: { label: "beta", params: { x: "y" } },',
      '  // c: { label: "gamma" },',
      '  /* d: { label: "delta" } */',
      "};",
    ].join("\n");
    expect([...parseEmittableLabels(fixture)].sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("finds a non-trivial projection table (non-vacuity)", () => {
    // `entity` and `skill` are literal samples of the two tables
    // (ROUTE_BY_KIND / ROUTE_BY_SUBKIND); if either disappears from the parse,
    // the regex or the file moved and the superset check below proves nothing.
    expect(labels.has("entity")).toBe(true);
    expect(labels.has("skill")).toBe(true);
    expect(labels.size).toBeGreaterThan(10);
  });

  it("TYPED_OPEN_KINDS ⊇ EMITTABLE_LABELS", () => {
    const served = new Set<string>(TYPED_OPEN_KINDS);
    const unserved = [...labels].filter((l) => !served.has(l)).sort();
    expect(
      unserved,
      "resolve-browser-route.ts can name a kind that `/open/:type/:id` rejects " +
        "with 400. Add it to TYPED_OPEN_KINDS (open-dispatch.ts) and to " +
        "pod-admin BOUNCE_TYPES (apps/pod-admin/app/open/open-params.ts)."
    ).toEqual([]);
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
