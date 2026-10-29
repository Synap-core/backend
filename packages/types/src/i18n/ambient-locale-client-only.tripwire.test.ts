/**
 * TRIPWIRE — the server never sets the ambient catalog locale.
 *
 * WHY (decision D1, plan 915cc937, 2026-10-29). The vocabulary answers in the
 * ambient catalog locale when it is given none, so pod, MCP, CLI and agent
 * text stay English only because no server code sets it. One server call of
 * `setAmbientCatalogLocale("fr")` would turn every proposal title, stored
 * summary and tool reply French for every person of the pod, from then on:
 * module state is per process, not per request. A server writing for a person
 * passes that person's locale explicitly (`createT(recipient.locale, …)`).
 *
 * HOW (derived, never a hand list): walk every source file of this repo's
 * server code, `packages/*` and each `apps/*` that is not a client host (an
 * app whose package.json depends on `react-dom` is one: `apps/pod-admin`),
 * strip comments, and fail on any mention of the setter outside its own
 * definition and the i18n door's re-export. A mention, not only a call: an
 * aliased import is caught where it is imported. The intelligence service is
 * walked too when its checkout sits beside this one.
 *
 * WHAT IT DOES NOT SEE (stated): the intelligence service in CI (CI checks
 * this repo out alone, so that half runs only where the sibling exists, and
 * says so when skipped); a setter reached through a computed property
 * (`i18n["set" + name]`); tests (they set it and reset it).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "../../../../scripts/strip-comments.mjs";
import {
  siblingCheckout,
  siblingSkipReason,
} from "../../../../scripts/sibling-checkout.mjs";

/** `src/i18n` → src → types → packages → synap-backend. */
const BACKEND_ROOT = join(import.meta.dirname, "../../../..");
const SETTER = "setAmbientCatalogLocale";
const MENTION = new RegExp(`\\b${SETTER}\\b`);
/** The definition and the door's re-export: the only server files that may name it. */
const ALLOWED = new Set([
  "packages/types/src/i18n/ambient.ts",
  "packages/types/src/i18n/index.ts",
]);
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "__tests__",
  "__fixtures__",
]);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** A client host: an app that renders into a DOM. */
function isClientHost(appDir: string): boolean {
  const pkg = join(appDir, "package.json");
  if (!existsSync(pkg)) return false;
  const json = JSON.parse(readFileSync(pkg, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Boolean(
    json.dependencies?.["react-dom"] ?? json.devDependencies?.["react-dom"]
  );
}

/** The server roots of this repo: every package, every app that is not a client host. */
function serverRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["packages", "apps"]) {
    const base = join(BACKEND_ROOT, group);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      if (group === "apps" && isClientHost(dir)) continue;
      roots.push(dir);
    }
  }
  return roots;
}

function mentions(file: string): boolean {
  const text = readFileSync(file, "utf8");
  if (!text.includes(SETTER)) return false;
  return MENTION.test(stripComments(text, "ts"));
}

describe("the ambient catalog locale is set by client hosts only", () => {
  const roots = serverRoots();
  const files = roots.flatMap((root) => walk(root, []));

  it("walks a real tree (non-vacuity)", () => {
    expect(roots.map((r) => relative(BACKEND_ROOT, r))).toEqual(
      expect.arrayContaining(["packages/api", "packages/types", "apps/api"])
    );
    expect(
      roots.map((r) => relative(BACKEND_ROOT, r)),
      "apps/pod-admin is a client host (react-dom): the scan must leave it out"
    ).not.toContain("apps/pod-admin");
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain(
      join(BACKEND_ROOT, "packages/types/src/i18n/ambient.ts")
    );
  });

  it("sees a mention when there is one, and none in a comment", () => {
    expect(MENTION.test(stripComments(`${SETTER}("fr");`, "ts"))).toBe(true);
    expect(
      MENTION.test(stripComments(`import { ${SETTER} as s } from "x";`, "ts"))
    ).toBe(true);
    expect(
      MENTION.test(stripComments(`// never call ${SETTER} here`, "ts"))
    ).toBe(false);
    expect(
      mentions(join(BACKEND_ROOT, "packages/types/src/i18n/ambient.ts"))
    ).toBe(true);
  });

  it("no server file of this repo names the setter", () => {
    const found = files
      .filter(mentions)
      .map((f) => relative(BACKEND_ROOT, f))
      .filter((f) => !ALLOWED.has(f));
    expect(found).toEqual([]);
  });

  const is = siblingCheckout("synap-intelligence-service");
  it.skipIf(is === null)(
    "no file of the intelligence service names the setter",
    () => {
      const isFiles = walk(is!, []);
      expect(isFiles.length).toBeGreaterThan(100);
      expect(isFiles.filter(mentions).map((f) => relative(is!, f))).toEqual([]);
    }
  );
  if (is === null) {
    console.warn(
      siblingSkipReason("synap-intelligence-service", "ambient-locale")
    );
  }
});
