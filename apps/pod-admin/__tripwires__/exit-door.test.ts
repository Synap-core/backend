import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT_PAGES } from "../lib/open-in";

/**
 * The exit-door invariants, enforced by scanning SOURCE.
 *
 * Every one of these was a live defect on 2026-09-05, and every one of them is
 * the kind that typechecks perfectly: a 404 href, a link to a deprecated app, a
 * `synap://` that silently does nothing. Only a source scan catches them.
 *
 * This walks the tree RECURSIVELY on purpose. A tripwire scoped to a
 * hand-written list of files stops covering the codebase the moment someone
 * adds a file, which is precisely when it was needed.
 */

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCAN_DIRS = ["app", "lib"];
const SKIP_DIRS = new Set(["node_modules", ".next", "__tripwires__"]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry)) continue;
      if (/\.d\.ts$/.test(entry)) continue;
      out.push(full);
    }
  };
  for (const dir of SCAN_DIRS) walk(join(APP_ROOT, dir));
  return out;
}

/** Strip comments so an explanatory note about a banned pattern isn't a hit. */
function code(text: string): string {
  // Block comments are stripped ONLY when `/*` opens a line. The naive form
  // treats a `/*` inside a STRING LITERAL as a comment opener and erases
  // everything to the next `*` + `/` — swallowing any real violation in
  // between and turning this file green. Every doc comment in this app starts
  // its own line (JSX comments as `{/* … */}`, hence the optional brace), so
  // anchoring costs nothing. A string literal is always preceded by a quote,
  // so it still cannot open a comment.
  return text
    .replace(/^[ \t]*\{?[ \t]*\/\*[\s\S]*?\*\//gm, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const FILES = sourceFiles().map((path) => ({
  path: relative(APP_ROOT, path),
  body: code(readFileSync(path, "utf8")),
}));

describe("pod-admin exit door", () => {
  it("scans a non-trivial number of files (guards against a broken walker)", () => {
    // A tripwire that silently scans nothing is worse than no tripwire.
    expect(FILES.length).toBeGreaterThan(40);
  });

  it("never links to the deprecated fluid web app", () => {
    // hub.synap.live is live but 307s to a second login, and never read the
    // ?ws param four CTAs sent it. Retargeted to browser + landing.
    const hits = FILES.filter((f) =>
      /hub\.synap\.live|NEXT_PUBLIC_SYNAP_HUB_URL/.test(f.body)
    );
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("never links to a /studio route this app does not serve", () => {
    // `/studio/settings/vault` and `/studio/settings/integrations` were
    // relative hrefs on pod-admin's own origin: hard 404s.
    // No leading-quote requirement: `${base}/studio/x` is the same defect.
    const hits = FILES.filter((f) => /\/studio(?:\/|["'`])/.test(f.body));
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("never links to /openclaw, which this app does not serve", () => {
    const hits = FILES.filter((f) => /["'`]\/openclaw/.test(f.body));
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("mints synap:// links only inside the one door", () => {
    // A raw synap:// at a call site is a link whose receiver nobody checked,
    // and which carries no fallback when the app isn't installed.
    // Exactly ONE file may mint a synap:// link. `open-params.ts` was in this
    // set until its `openInAppHref` was deleted — an allowlist entry that
    // exempted a second minter from the rule the guard exists to enforce is a
    // hole shaped like the defect.
    const allowed = new Set(["lib/open-in.ts"]);
    const hits = FILES.filter(
      (f) => /synap:\/\//.test(f.body) && !allowed.has(f.path)
    );
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("has no permanently-disabled control standing in for a missing procedure", () => {
    // Five surfaces rendered `isDisabled` buttons whose tooltip named a tRPC
    // procedure nobody had written. Those are handoffs now.
    const hits = FILES.filter((f) => /Pending:\s*[a-zA-Z]+\./.test(f.body));
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("renders an exit's fallback only through the shared component", () => {
    // The rule "a desktop link always carries a web fallback" was enforced by
    // SEVEN independent re-implementations, which is to say not enforced: four
    // different opacities (two below 2.5:1 contrast), a focus ring on one of
    // four, target="_blank" on pod-admin's own routes, and one list repeating
    // it per row. `lib/exit-link.tsx` is now the only place that reads it.
    const allowed = new Set(["lib/exit-link.tsx"]);
    const hits = FILES.filter(
      (f) =>
        /\bexit\.fallback\b|\bfallback\.href\b/.test(f.body) &&
        !allowed.has(f.path)
    );
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("uses the shared confirm modal, never the OS dialog", () => {
    // `confirm(...)` is the MORE idiomatic spelling than `window.confirm`, so
    // a guard that only knows the qualified form misses the likely regression.
    const hits = FILES.filter((f) =>
      /(?:window\.|globalThis\.)?\bconfirm\s*\(/.test(f.body)
    );
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("never upper-cases a DOMAIN token by hand", () => {
    // `charAt(0).toUpperCase()` is how six incompatible humanizers happened.
    //
    // Matched on the RECEIVER rather than the call, because the call itself is
    // not always wrong: taking an initial from a person's email for an avatar
    // is legitimate and has nothing to do with vocabulary. What is never
    // legitimate is hand-casing a status / type / kind / action / state — the
    // values that also exist in the database, which is exactly the line the
    // vocabulary rule draws.
    //
    // Deliberately NOT an allowlist of exempt files: a file-scoped exemption
    // stops covering that file forever, including the next domain token
    // someone adds to it.
    // `\s*` around EVERY link in the chain. Prettier wraps this expression at
    // the ~80-col width this app uses, producing
    //     row.status\n  .charAt(0)\n  .toUpperCase()
    // which an unspaced pattern misses — the single most likely way the
    // removed defect comes back. `[0]` indexing is the other spelling.
    const hits = FILES.filter((f) =>
      /\b\w*(?:status|type|kind|action|state)\w*\s*(?:\.\s*charAt\s*\(\s*0\s*\)|\[\s*0\s*\])\s*\.\s*toUpperCase\s*\(\s*\)/i.test(
        f.body
      )
    );
    expect(hits.map((h) => h.path)).toEqual([]);
  });
});

/**
 * The guards, tested against the ways they were ACTUALLY defeated.
 *
 * A code review defeated the first version of every regex above with strings a
 * normal contributor would write — not adversarial ones. The worst was
 * Prettier's own wrap of `row.status.charAt(0).toUpperCase()` at this app's
 * column width, which the unspaced pattern sailed straight past: the guard
 * passed for the single most likely spelling of the defect it existed to stop.
 *
 * So the guards are now pinned against their own evasions. A future
 * "simplification" of one of these regexes fails here.
 */
/**
 * Every destination `openIn` can emit must EXIST on the landing site.
 *
 * This is the rule the whole plan came from: four CTAs pointed at a receiver
 * nobody had read, and one of them silently dropped the param it carried. A
 * link is only worth emitting if its far end is real — so the far end is
 * checked here rather than trusted.
 *
 * Skipped (not failed) when the landing repo is not checked out beside this
 * one, so the suite still runs in a backend-only clone.
 */
describe("landing destinations exist", () => {
  const LANDING = join(APP_ROOT, "../../../synap-landing/app");
  const present = existsSync(LANDING);

  const routes = [
    ...ACCOUNT_PAGES.map((page) => `account/${page}`),
    "download/browser",
    "guides/quickstart",
  ];

  it.skipIf(!present).each(routes)("synap.live/%s is a real route", (route) => {
    expect(existsSync(join(LANDING, route, "page.tsx"))).toBe(true);
  });
});

describe("the guards catch their own evasions", () => {
  const STUDIO = /\/studio(?:\/|["'`])/;
  const CONFIRM = /(?:window\.|globalThis\.)?\bconfirm\s*\(/;
  const CHAR_AT =
    /\b\w*(?:status|type|kind|action|state)\w*\s*(?:\.\s*charAt\s*\(\s*0\s*\)|\[\s*0\s*\])\s*\.\s*toUpperCase\s*\(\s*\)/i;

  it.each([
    [
      "Prettier's line wrap",
      "const l = row.status\n  .charAt(0)\n  .toUpperCase();",
    ],
    ["index-0 spelling", "const l = row.status[0].toUpperCase();"],
    ["extra whitespace", "row.kind . charAt( 0 ) . toUpperCase ( )"],
  ])("hand-cased domain token — %s", (_label, input) => {
    expect(CHAR_AT.test(input)).toBe(true);
  });

  it.each([
    ["bare confirm", 'if (!confirm("Revoke?")) return;'],
    ["globalThis", 'globalThis.confirm("x")'],
    ["window", 'window.confirm("x")'],
  ])("OS confirm dialog — %s", (_label, input) => {
    expect(CONFIRM.test(input)).toBe(true);
  });

  it.each([
    ["template literal", "const h = `${base}/studio/x`;"],
    ["no trailing slash", 'href="/studio"'],
  ])("dead /studio route — %s", (_label, input) => {
    expect(STUDIO.test(input)).toBe(true);
  });

  it("does not let a string literal containing /* blind the scanner", () => {
    // The naive stripper treats `/*` in a string as a comment opener and
    // erases everything to the next `*` + `/`, swallowing real violations.
    const sneaky =
      'const g = "/*"; const h = "https://hub.synap.live"; const e = "*' +
      '/";';
    expect(code(sneaky)).toContain("hub.synap.live");
  });
});
