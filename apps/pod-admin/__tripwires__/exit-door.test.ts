import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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
    const hits = FILES.filter((f) => /["'`]\/studio\//.test(f.body));
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("never links to /openclaw, which this app does not serve", () => {
    const hits = FILES.filter((f) => /["'`]\/openclaw/.test(f.body));
    expect(hits.map((h) => h.path)).toEqual([]);
  });

  it("mints synap:// links only inside the one door", () => {
    // A raw synap:// at a call site is a link whose receiver nobody checked,
    // and which carries no fallback when the app isn't installed.
    const allowed = new Set(["lib/open-in.ts", "app/open/open-params.ts"]);
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

  it("uses the shared confirm modal, never the OS dialog", () => {
    const hits = FILES.filter((f) => /window\.confirm/.test(f.body));
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
    const hits = FILES.filter((f) =>
      /\b\w*(?:status|type|kind|action|state)\w*\s*\.charAt\(0\)\.toUpperCase\(\)/i.test(
        f.body
      )
    );
    expect(hits.map((h) => h.path)).toEqual([]);
  });
});
