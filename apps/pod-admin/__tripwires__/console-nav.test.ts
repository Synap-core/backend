import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveObjectNounPlural } from "@synap-core/types/vocabulary";
import {
  CONSOLE_APP_VIAS,
  CONSOLE_PAGES,
  CONSOLE_REVIEW_TYPES,
  consolePath,
  type ConsoleTarget,
} from "@synap-core/types/console";

import {
  computerHref,
  consoleRedirects,
  DIAGNOSE_DESTINATION,
  NAV_ITEMS,
  navHref,
  pendingIssuerHref,
  SEARCH_DESTINATION,
  type NavId,
} from "../lib/console-nav";
import {
  isBannedAdminPath,
  isMatcherExcluded,
  isSelfService,
  routeAccess,
} from "../lib/route-policy";
import {
  APP_VIAS,
  appHref,
} from "../app/(admin)/applications/_lib/app-inventory";
import { REVIEW_FILTERS } from "../app/(admin)/review/_lib/review-rows";

/**
 * The console's IA invariants. Each one is a defect that typechecks:
 *
 *   • an admin page under a self-service or matcher-excluded prefix renders
 *     with the wrong gate (or none) and nothing errors;
 *   • a moved page whose old URL is not redirected breaks every bookmark;
 *   • a palette category or diagnose section without a nav home links nowhere;
 *   • a nav word that forks from the vocabulary registry is the hand-written
 *     label map `.claude/rules/vocabulary.md` forbids.
 */

const NAV_IDS = new Set(NAV_ITEMS.map((i) => i.id));

describe("console nav", () => {
  it("points every nav item at a page that exists", () => {
    const adminDir = fileURLToPath(new URL("../app/(admin)", import.meta.url));
    const missing = NAV_ITEMS.filter(
      (i) => !existsSync(join(adminDir, i.href, "page.tsx"))
    ).map((i) => i.href);
    expect(missing).toEqual([]);
  });

  it("has unique ids and unique hrefs", () => {
    expect(NAV_IDS.size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
  });

  it("never puts an admin page under a self-service or banned prefix", () => {
    const bad = NAV_ITEMS.filter((i) => i.audience === "admin").flatMap((i) =>
      [i.href, ...(i.match ?? [])].filter(
        (p) => isSelfService(p) || isMatcherExcluded(p) || isBannedAdminPath(p)
      )
    );
    expect(bad).toEqual([]);
  });

  it("gives members Home and Review only", () => {
    const memberIds = NAV_ITEMS.filter((i) => i.audience === "member").map(
      (i) => i.id
    );
    expect(memberIds.every((id) => ["home", "review"].includes(id))).toBe(true);
  });

  it("turns every legacy entry into a redirect", () => {
    const rules = consoleRedirects();
    for (const item of NAV_ITEMS) {
      for (const legacy of item.legacy ?? []) {
        expect(
          rules.some(
            (r) =>
              r.source === legacy.source &&
              r.destination === (legacy.destination ?? item.href) &&
              r.permanent === false &&
              (legacy.query
                ? r.has?.[0]?.key === legacy.query.key &&
                  r.has[0].value === legacy.query.value
                : r.has === undefined)
          ),
          `${item.id} ← ${legacy.source}`
        ).toBe(true);
      }
    }
  });

  it("never redirects a live nav page away", () => {
    const hrefs = new Set(NAV_ITEMS.map((i) => i.href));
    const bareSources = consoleRedirects()
      .filter((r) => !r.has)
      .map((r) => r.source);
    expect(bareSources.filter((s) => hrefs.has(s))).toEqual([]);
  });

  it("uses the registry's plural for every kind-backed label", () => {
    const forked = NAV_ITEMS.filter(
      (i) => i.kind && resolveObjectNounPlural(i.kind) !== i.label
    ).map((i) => `${i.id}: ${i.label} ≠ ${resolveObjectNounPlural(i.kind)}`);
    expect(forked).toEqual([]);
  });
});

describe("every door has a nav home", () => {
  it("maps every search category to a nav item", () => {
    for (const [category, dest] of Object.entries(SEARCH_DESTINATION)) {
      expect(NAV_IDS.has(dest.nav), category).toBe(true);
    }
  });

  it("maps every diagnose section the server emits to a nav item", () => {
    // Read from the server's source, not a copy: a section added there must
    // be placed here before Home can route it.
    const dir = fileURLToPath(
      new URL("../../../packages/api/src/services/diagnose", import.meta.url)
    );
    const keys = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(dir, file), "utf8");
      for (const m of src.matchAll(/\bkey:\s*"([a-z_]+)"/g)) keys.add(m[1]);
    }
    expect(keys.size).toBeGreaterThan(5);
    const unplaced = [...keys].filter((k) => !(k in DIAGNOSE_DESTINATION));
    expect(unplaced).toEqual([]);
    for (const [key, nav] of Object.entries(DIAGNOSE_DESTINATION)) {
      expect(NAV_IDS.has(nav), key).toBe(true);
    }
  });
});

/**
 * `@synap-core/types/console` is the table clients (desktop, Relay, app kits)
 * build console links from. They cannot import this app, so these pins are
 * what stops a client link from naming a page that moved, a `?focus=` the page
 * ignores, or an admin page shown to a member.
 */
describe("the client link contract (@synap-core/types/console)", () => {
  const appDir = fileURLToPath(new URL("../app", import.meta.url));
  const navByHref = new Map(NAV_ITEMS.map((i) => [i.href, i]));
  const pages = Object.entries(CONSOLE_PAGES) as Array<
    [
      keyof typeof CONSOLE_PAGES,
      (typeof CONSOLE_PAGES)[keyof typeof CONSOLE_PAGES],
    ]
  >;

  /** The source directory of a console route (nav pages live in `(admin)`). */
  function routeDir(path: string): string {
    return navByHref.has(path)
      ? join(appDir, "(admin)", path)
      : join(appDir, path);
  }

  /** Every source file of a page, its sub-routes (`[id]`) excluded. */
  function pageSources(dir: string): string {
    return readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((e) => /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
      .map((e) => join(e.parentPath, e.name))
      .filter((f) => !f.slice(dir.length).includes("["))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
  }

  it("names only real console routes: a nav page or a signed-in/public one", () => {
    const unknown = pages
      .filter(
        ([, p]) =>
          !navByHref.has(p.path) &&
          !(
            routeAccess(p.path) !== "admin" &&
            existsSync(join(routeDir(p.path), "page.tsx"))
          )
      )
      .map(([id]) => id);
    expect(unknown).toEqual([]);
  });

  it("never marks a page a member would be refused as a member page", () => {
    const wrong = pages
      .filter(([, p]) => {
        const nav = navByHref.get(p.path);
        return nav
          ? nav.audience !== p.audience
          : p.audience === "admin" || routeAccess(p.path) === "admin";
      })
      .map(([id]) => id);
    expect(wrong).toEqual([]);
  });

  it("sends ?focus= only to pages that receive it, spelled like navHref", () => {
    for (const [id, p] of pages) {
      const reads = /useFocusRow\(|get\("focus"\)/.test(
        pageSources(routeDir(p.path))
      );
      expect(reads, `${id} focus`).toBe(p.focus);
      const nav = navByHref.get(p.path);
      if (p.focus && nav) {
        expect(
          consolePath({ page: id, focus: "a b/c" } as ConsoleTarget),
          id
        ).toBe(navHref(nav.id as NavId, { focus: "a b/c" }));
      }
    }
  });

  it("sends ?type= only with views Review reads", () => {
    expect(pageSources(routeDir(CONSOLE_PAGES.review.path))).toMatch(
      /get\("type"\)/
    );
    const unread = CONSOLE_REVIEW_TYPES.filter(
      (t) => !REVIEW_FILTERS.includes(t)
    );
    expect(unread).toEqual([]);
    expect(
      consolePath({ page: "review", type: "access", focus: "iss 1" })
    ).toBe(pendingIssuerHref("iss 1"));
  });

  it("addresses object pages the way the console does", () => {
    expect(consolePath({ page: "computer", id: "m 1" })).toBe(
      computerHref("m 1")
    );
    expect(consolePath({ page: "space", id: "w 1" })).toBe(
      `${navHref("spaces")}/w%201`
    );
    expect(existsSync(join(appDir, "(admin)/workspaces/[id]/page.tsx"))).toBe(
      true
    );
    expect([...CONSOLE_APP_VIAS]).toEqual([...APP_VIAS]);
    for (const via of APP_VIAS) {
      expect(consolePath({ page: "application", via, id: "a/1" })).toBe(
        appHref(via, "a/1")
      );
    }
    expect(existsSync(join(appDir, "(admin)/computers/[id]/page.tsx"))).toBe(
      true
    );
    expect(
      existsSync(join(appDir, "(admin)/applications/[via]/[id]/page.tsx"))
    ).toBe(true);
    const request = consolePath({ page: "connectionRequest", id: "r1" });
    expect(request).toBe("/connection-requests/r1");
    expect(isSelfService(request as string)).toBe(true);
    expect(
      existsSync(join(appDir, "connection-requests/[requestId]/page.tsx"))
    ).toBe(true);
  });
});
