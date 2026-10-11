/**
 * TRIPWIRE — no pod source MINTS a Kratos session through the admin API.
 *
 * WHY (FEDERATED-SIGNIN-FIX-PLAN §6, retired in W6 2026-10-11). Two doors —
 * `POST /api/federation/exchange` (`mintKratosSession`) and the hub
 * `POST /auth/exchange` — POSTed `/admin/identities/{id}/sessions` to turn a
 * CP assertion into a pod session. Kratos v1.3.1 OSS has no such route (405),
 * so neither EVER succeeded, while every client that relied on them failed
 * with a confident "sign-in failed". Kratos owns sessions; a pod session comes
 * only from a Kratos self-service flow (OIDC `cp`, password). Re-adding the
 * mint would rebuild a door that cannot work.
 *
 * HOW (derived, not hand-listed): walk every `src` / `app` / `lib` tree under
 * `apps/*` and `packages/*` (tests, dist, node_modules, .next skipped), find
 * every literal `/admin/identities/<…>/sessions` URL, and read the HTTP method
 * of the request it builds from the next ~400 characters. DELETE (revoke) and
 * GET (list, the fetch default) are legitimate; POST / PUT / PATCH, or a
 * method that is not a string literal, fail.
 *
 * NON-VACUITY: the scan must see > 300 source files AND the legitimate
 * `DELETE` in `apps/api/src/routers/account-recovery-deps.ts`
 * (`revokeIdentitySessions`). The classifier is also run on a literal sample
 * of the retired mint, which it must flag.
 *
 * WHAT IT DOES NOT SEE (stated): a URL assembled from pieces (`"/sessions"`
 * concatenated onto a variable) or split across lines, a method passed in from elsewhere beyond the
 * 400-char window, or a Kratos SDK call. Those would pass.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "__tests__",
  "__tripwires__",
]);
const SOURCE_DIRS = new Set(["src", "app", "lib"]);
const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE_FILE.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
}

/** Every source file under apps/* and packages/* (their src/app/lib trees). */
function sourceFiles(): string[] {
  const out: string[] = [];
  for (const top of ["apps", "packages"]) {
    for (const pkg of readdirSync(join(REPO, top))) {
      const pkgDir = join(REPO, top, pkg);
      if (!statSync(pkgDir).isDirectory()) continue;
      for (const sub of readdirSync(pkgDir)) {
        if (SOURCE_DIRS.has(sub) && statSync(join(pkgDir, sub)).isDirectory()) {
          walk(join(pkgDir, sub), out);
        }
      }
    }
  }
  return out;
}

// Any characters on the same line between the two segments — an id
// interpolation can itself hold quotes (`${encodeURIComponent("x")}`), which a
// quote-free class missed (found by the second negative control).
const SESSIONS_URL = /\/admin\/identities\/[^\n]{1,160}?\/sessions\b/g;

type Hit = { file: string; line: number; method: string };

/** Each admin-sessions URL in `src`, with the method of the request it builds. */
function classify(src: string, file = "<sample>"): Hit[] {
  const hits: Hit[] = [];
  for (const m of src.matchAll(SESSIONS_URL)) {
    const at = m.index ?? 0;
    const window = src.slice(at, at + 400);
    const literal = /method:\s*["'`](\w+)["'`]/.exec(window);
    const anyMethod = /method:/.test(window);
    const method = literal
      ? literal[1].toUpperCase()
      : anyMethod
        ? "NON-LITERAL"
        : "GET";
    hits.push({ file, line: src.slice(0, at).split("\n").length, method });
  }
  return hits;
}

const ALLOWED = new Set(["DELETE", "GET"]);

describe("no pod source mints a Kratos session via the admin API", () => {
  const files = sourceFiles();
  const hits = files.flatMap((f) =>
    classify(readFileSync(f, "utf8"), relative(REPO, f))
  );

  it("scans a plausible source set (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("still sees the legitimate session REVOKE in account recovery", () => {
    expect(hits).toContainEqual(
      expect.objectContaining({
        file: "apps/api/src/routers/account-recovery-deps.ts",
        method: "DELETE",
      })
    );
  });

  it("flags the retired mint shape (classifier self-check)", () => {
    const retired =
      "await fetch(`${kratosAdminUrl}/admin/identities/${identityId}/sessions`, {\n" +
      '  method: "POST",\n  headers: { "Content-Type": "application/json" },\n})';
    expect(classify(retired).map((h) => h.method)).toEqual(["POST"]);
    const indirect =
      "fetch(`${u}/admin/identities/${id}/sessions`, { method: verb })";
    expect(classify(indirect).map((h) => h.method)).toEqual(["NON-LITERAL"]);
    const quoted =
      'fetch(`${u}/admin/identities/${encodeURIComponent("x")}/sessions`, { method: "POST" })';
    expect(classify(quoted).map((h) => h.method)).toEqual(["POST"]);
  });

  it("no request to /admin/identities/{id}/sessions is a POST/PUT/PATCH", () => {
    const offenders = hits
      .filter((h) => !ALLOWED.has(h.method))
      .map((h) => `${h.file}:${h.line} ${h.method}`);
    expect(offenders).toEqual([]);
  });
});
