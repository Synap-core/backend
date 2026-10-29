/**
 * Tripwire: a URL that went through the SSRF guard is SENT through the pinned
 * door, never through the bare global `fetch`.
 *
 * `validateExternalUrl` reads the URL TEXT only. A public name that resolves to
 * `127.0.0.1`, a Docker service or cloud metadata passes it; only
 * `safePublicFetch` (`@synap/shared-utils/pinned-fetch`) resolves the name,
 * refuses a private answer and connects to the address it vetted. Measured
 * 2026-10-28 (pre-launch audit, webhooks F1 / governance F5): eight outbound
 * doors validated the text and then fetched with the hostname-only wrapper,
 * so `http://kratos.:4434/admin/identities` reached the unauthenticated Kratos
 * admin API from the backend container. That wrapper was folded into
 * `safePublicFetch`; this keeps the shape from coming back as a bare `fetch`.
 *
 * Rule, per production file of every package: an expression passed to
 * `validateExternalUrl(...)` (or the `.url` of its result) must not be the
 * URL, or a piece of the URL template, of a bare `fetch(...)` call. A fetch of
 * an operator-configured endpoint that was never put through the guard (the
 * intelligence service on the Docker network) is not a content URL and is not
 * flagged.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Every bare `fetch(...)` whose URL is an expression the file guarded. */
function guardedThenRawFetched(source: string): string[] {
  const file = ts.createSourceFile(
    "f.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const guarded = new Set<string>();
  const resultVars = new Set<string>();
  const fetchArgs: ts.Expression[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      const first = node.arguments[0];
      if (callee === "validateExternalUrl" && first) {
        guarded.add(first.getText(file));
        const parent = node.parent;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          resultVars.add(parent.name.text);
        }
      }
      if (callee === "fetch" && first) fetchArgs.push(first);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const isGuarded = (e: ts.Expression): boolean => {
    const text = e.getText(file);
    if (guarded.has(text)) return true;
    // `<check>.url`, `<check>.url.toString()`, `<check>.url.href`
    const root = /^([A-Za-z_$][\w$]*)\.url\b/.exec(text);
    return Boolean(root && resultVars.has(root[1]!));
  };

  const out: string[] = [];
  for (const arg of fetchArgs) {
    let inner: ts.Expression = arg;
    // `String(x)`, `x.toString()`
    if (
      ts.isCallExpression(inner) &&
      ts.isIdentifier(inner.expression) &&
      inner.expression.text === "String" &&
      inner.arguments[0]
    ) {
      inner = inner.arguments[0];
    }
    const pieces: ts.Expression[] = ts.isTemplateExpression(inner)
      ? inner.templateSpans.map((s) => s.expression)
      : [inner];
    if (pieces.some(isGuarded)) out.push(arg.getText(file));
  }
  return out;
}

function productionFiles(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, "src");
    let entries: string[];
    try {
      entries = readdirSync(src, { recursive: true }) as string[];
    } catch {
      continue; // a package without src/
    }
    for (const f of entries) {
      const parts = f.split(sep);
      if (
        f.endsWith(".ts") &&
        !f.endsWith(".d.ts") &&
        !/\.test\.ts$/.test(f) &&
        !parts.includes("__tests__") &&
        !parts.includes("node_modules")
      ) {
        out.push(join(src, f));
      }
    }
  }
  return out;
}

describe("outbound fetch door: a guarded URL is sent through safePublicFetch", () => {
  const files = productionFiles();
  const guarding = files.filter((f) =>
    readFileSync(f, "utf8").includes("validateExternalUrl(")
  );

  it("scans a plausible set (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(1000);
    // The doors that guard a URL today: automation fetch + webhook node,
    // webhook subscriptions' registration, vault tools, session sign-in, skill
    // sandbox, channel relay, web reader, media copy...
    expect(guarding.length).toBeGreaterThanOrEqual(8);
  });

  it("the scanner sees each shape it hunts, and passes the operator fetch", () => {
    expect(
      guardedThenRawFetched(
        "const c = validateExternalUrl(u); if (c.valid) await fetch(u);"
      )
    ).toEqual(["u"]);
    expect(
      guardedThenRawFetched(
        "const c = validateExternalUrl(svc.endpoint);\nawait fetch(`${svc.endpoint}/v1/chat`, {});"
      )
    ).toEqual(["`${svc.endpoint}/v1/chat`"]);
    expect(
      guardedThenRawFetched(
        "const check = validateExternalUrl(raw); await fetch(check.url.toString());"
      )
    ).toEqual(["check.url.toString()"]);
    expect(
      guardedThenRawFetched(
        "const c = validateExternalUrl(u); await fetch(String(u));"
      )
    ).toEqual(["String(u)"]);
    // Clean: the guarded URL goes through the pinned door; an unguarded
    // operator endpoint is fetched directly.
    expect(
      guardedThenRawFetched(
        "const c = validateExternalUrl(u); await safePublicFetch(u);\nawait fetch(`${hubUrl}/api/mcp/call`);"
      )
    ).toEqual([]);
  });

  it("no production file sends a guarded URL through the bare fetch", () => {
    const offenders = guarding
      .map((f) => ({
        file: relative(PACKAGES, f),
        fetches: guardedThenRawFetched(readFileSync(f, "utf8")),
      }))
      .filter((o) => o.fetches.length > 0);
    expect(
      offenders,
      'Send it through safePublicFetch (pass { allowedPorts: "any" } for a host a person approved by name).'
    ).toEqual([]);
  });
});
