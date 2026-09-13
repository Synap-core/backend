import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — every hub-protocol REST mutating route (POST/PATCH/PUT/DELETE)
 * must resolve its acting identity through `resolveActingContext`
 * (rest/_shared.ts), never trust a body-supplied `userId` directly.
 *
 * THE BUG THIS GUARDS: a Hub REST mutating handler that reads `body.userId`
 * (or feeds it straight into `resolveActorId`) without first running it
 * through `resolveActingContext` lets ANY caller attribute a write to an
 * arbitrary `userId` — the exact "governed agent write becomes ungoverned
 * operator write" IDOR class. `resolveActingContext` is the ONE door that
 * turns a body-supplied `userId` into a verified, membership-checked acting
 * identity (session callers can never override it; service keys may pass an
 * on-behalf-of value, but it still flows through the same door). See
 * `rest/views.identity-contract.test.ts` for the behavioral (mocked) version
 * of this contract on the `/views/*` routes — this file is the source-level,
 * hub-wide generalization: it scans every `rest/*.ts` route file for
 * POST/PATCH/PUT/DELETE handlers (both `app.<method>(path, handler)` and
 * `app.openapi(route, handler)` where `route`'s `createRoute({ method: ... })`
 * is one of post/patch/put/delete) and fails any handler that reads
 * `body.userId` without also calling `resolveActingContext(`.
 *
 * COVERAGE HISTORY: originally POST-only (2026-07-31). Generalized to also
 * scan PATCH/PUT/DELETE (2026-08-01) after review flagged that the same IDOR
 * class can live in an update/delete handler just as easily as a create
 * handler — a scanner limited to POST let those evade entirely.
 *
 * If this fails on a NEW route: call `resolveActingContext(c, { userId:
 * body.userId, workspaceId })` and use the returned `acting.userId` /
 * `acting.workspaceId` instead of the raw body fields (see `rest/profiles.ts`
 * POST /profiles and POST /property-defs for the reference shape, or
 * `rest/views.ts` POST /views).
 *
 * If this fails on an EXISTING route you are touching for an unrelated
 * reason: do NOT add it to the allowlist as a workaround — fix it the same
 * way. The allowlist below is SHRINK-ONLY pre-existing debt inventoried at
 * the time this tripwire was added (2026-07-31 security wave that fixed
 * POST /profiles + POST /property-defs) and extended (2026-08-01 PATCH/PUT/
 * DELETE coverage wave). Every entry has a reason. Entries marked VULN are
 * the SAME bug class, not yet fixed — pending a follow-up wave — and must
 * never be treated as "fine, it's allowlisted".
 */

const REST_DIR = join(process.cwd(), "src/routers/hub-protocol/rest");

/**
 * SHRINK-ONLY allowlist. Key = `${file}::${label}` where `label` is the route
 * path (app.post) or the `createRoute` variable name (app.openapi). Never add
 * an entry for a route you are authoring or materially changing — fix the
 * identity flow instead. Only remove entries (as routes get fixed).
 */
const ALLOWLIST: Record<string, string> = {
  // (empty) The five entities.ts "SAFE — inline equivalent" entries were retired
  // on 2026-09-13: their inline `!!c.get("apiKeyId")` check was NOT equivalent —
  // it let every bearer key (agent keys included) name any user. They now route
  // through `mayActAsUser`, the predicate `resolveActingContext` itself uses.
};

/**
 * A handler binds identity through the ONE rule if it calls the full door
 * (`resolveActingContext`) or the predicate that door delegates to
 * (`mayActAsUser`). Both live in `rest/_shared.ts`.
 */
function bindsIdentity(clean: string): boolean {
  return /\b(?:resolveActingContext|mayActAsUser)\s*\(/.test(clean);
}

/** An identity decision keyed on "has an api key id" — the retired defect shape. */
const INLINE_APIKEY_IDENTITY_RE =
  /!!\s*c\.get\(\s*["']apiKeyId["']\s*\)|\bisServiceKey\b/;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (
      e.isFile() &&
      e.name.endsWith(".ts") &&
      !e.name.endsWith(".test.ts") &&
      !e.name.endsWith(".d.ts")
    )
      out.push(p);
  }
  return out;
}

function balancedEnd(
  src: string,
  openIdx: number,
  openCh: string,
  closeCh: string
): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * True if a (comment-stripped) handler body reads `userId` off the request
 * body — via member access (`body.userId`) OR destructuring
 * (`const { userId } = body`). The destructuring form is a real evasion the
 * member-access-only regex missed (POST /events/broadcast).
 */
function readsBodyUserId(clean: string): boolean {
  return (
    /\bbody(?:\?)?\.\s*userId\b/.test(clean) ||
    /(?:const|let|var)\s*\{[^}]*\buserId\b[^}]*\}\s*=\s*(?:await\s+)?[\w.]*\bbody\b/.test(
      clean
    )
  );
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Map of `createRoute` variable name → its `method` string (or null). */
function findRouteMethodMap(src: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const re = /const\s+(\w+)\s*=\s*createRoute\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const openParen = src.indexOf("(", re.lastIndex - 1);
    const end = balancedEnd(src, openParen, "(", ")");
    if (end === -1) continue;
    const block = src.slice(openParen, end);
    const methodMatch = /method\s*:\s*["'](\w+)["']/.exec(block);
    map.set(m[1], methodMatch ? methodMatch[1] : null);
  }
  return map;
}

/** Mutating HTTP methods this tripwire scans. GET/HEAD never mutate identity. */
const MUTATING_METHODS = ["post", "patch", "put", "delete"] as const;
type MutatingMethod = (typeof MUTATING_METHODS)[number];

interface Handler {
  method: MutatingMethod;
  label: string;
  bodyText: string;
}

/**
 * Finds every POST/PATCH/PUT/DELETE handler in a route file: direct
 * `app.<method>(path, handler)` calls, and `app.openapi(routeVar, handler)`
 * calls where `routeVar`'s `createRoute({ method })` is one of the mutating
 * methods (resolved via `routeMethodMap`).
 */
function findMutatingHandlers(
  src: string,
  routeMethodMap: Map<string, string | null>
): Handler[] {
  const handlers: Handler[] = [];

  const directRe =
    /app\.(post|patch|put|delete)\(\s*(["'`])([^"'`]*)\2\s*,\s*(?:async\s*)?\(c(?:\s*:\s*[A-Za-z0-9_.<>[\]| ]+)?\)/g;
  let m: RegExpExecArray | null;
  while ((m = directRe.exec(src))) {
    const method = m[1] as MutatingMethod;
    const body = extractHandlerBody(src, m.index);
    if (body) handlers.push({ method, label: m[3], bodyText: body });
  }

  const openapiRe = /app\.openapi\(\s*(\w+)\s*,\s*(?:async\s*)?\(c\)/g;
  while ((m = openapiRe.exec(src))) {
    const routeName = m[1];
    const method = routeMethodMap.get(routeName);
    if (!method || !MUTATING_METHODS.includes(method as MutatingMethod)) {
      continue;
    }
    const body = extractHandlerBody(src, m.index);
    if (body) {
      handlers.push({ method: method as MutatingMethod, label: routeName, bodyText: body });
    }
  }

  return handlers;
}

function extractHandlerBody(src: string, idx: number): string | null {
  const arrowIdx = src.indexOf("=>", idx);
  if (arrowIdx === -1) return null;
  const openBrace = src.indexOf("{", arrowIdx);
  if (openBrace === -1) return null;
  const end = balancedEnd(src, openBrace, "{", "}");
  if (end === -1) return null;
  return src.slice(openBrace, end + 1);
}

function tsRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".ts") &&
        !e.name.endsWith(".test.ts") &&
        !e.name.endsWith(".d.ts")
    )
    .map((e) => e.name);
}

describe("tripwire: hub REST mutating routes bind identity via resolveActingContext", () => {
  it("extractHandlerBody / findRouteMethodMap are alive (fixture sanity)", () => {
    const fixture = `
      const fooRoute = createRoute({ method: "post", path: "/foo" });
      app.openapi(fooRoute, async (c) => {
        const body = { a: 1 };
        return c.json(body);
      });
    `;
    const map = findRouteMethodMap(fixture);
    expect(map.get("fooRoute")).toBe("post");
    const handlers = findMutatingHandlers(fixture, map);
    expect(handlers.length).toBe(1);
    expect(handlers[0].bodyText).toContain("const body = { a: 1 }");
  });

  it("the offender check actually bites (fails on an unguarded POST fixture)", () => {
    const fixture = `
      app.post("/danger", async (c) => {
        const body = await c.req.json();
        const userId = body.userId;
        return c.json({ userId });
      });
    `;
    const handlers = findMutatingHandlers(fixture, new Map());
    expect(handlers.length).toBe(1);
    expect(handlers[0].method).toBe("post");
    const clean = stripComments(handlers[0].bodyText);
    expect(readsBodyUserId(clean)).toBe(true);
    expect(/resolveActingContext\s*\(/.test(clean)).toBe(false);
  });

  it("the offender check also bites on DESTRUCTURED body.userId (evasion class)", () => {
    // POST /events/broadcast evaded the member-access regex by destructuring
    // `const { userId } = body`; the detector must catch that shape too.
    const fixture = `
      app.post("/danger2", async (c) => {
        const body = await c.req.json();
        const { event, userId, workspaceId } = body as { userId?: string };
        return c.json({ userId });
      });
    `;
    const handlers = findMutatingHandlers(fixture, new Map());
    expect(handlers.length).toBe(1);
    const clean = stripComments(handlers[0].bodyText);
    expect(readsBodyUserId(clean)).toBe(true);
    expect(/resolveActingContext\s*\(/.test(clean)).toBe(false);
  });

  it("the offender check bites on non-POST methods too (PATCH/PUT/DELETE evasion class)", () => {
    // The gap this coverage wave closed: a scanner limited to app.post(...)
    // let an identical body.userId trust bug live in app.patch/put/delete
    // (and in an app.openapi(route) whose createRoute method is one of
    // those) evade detection entirely.
    const directFixture = `
      app.patch("/danger3/:id", async (c) => {
        const body = await c.req.json();
        const userId = body.userId;
        return c.json({ userId });
      });
    `;
    const directHandlers = findMutatingHandlers(directFixture, new Map());
    expect(directHandlers.length).toBe(1);
    expect(directHandlers[0].method).toBe("patch");
    const directClean = stripComments(directHandlers[0].bodyText);
    expect(readsBodyUserId(directClean)).toBe(true);
    expect(/resolveActingContext\s*\(/.test(directClean)).toBe(false);

    const openapiFixture = `
      const deleteThingRoute = createRoute({ method: "delete", path: "/things/{id}" });
      app.openapi(deleteThingRoute, async (c) => {
        const body = await c.req.json();
        const { userId } = body;
        return c.json({ userId });
      });
    `;
    const map = findRouteMethodMap(openapiFixture);
    expect(map.get("deleteThingRoute")).toBe("delete");
    const openapiHandlers = findMutatingHandlers(openapiFixture, map);
    expect(openapiHandlers.length).toBe(1);
    expect(openapiHandlers[0].method).toBe("delete");
    const openapiClean = stripComments(openapiHandlers[0].bodyText);
    expect(readsBodyUserId(openapiClean)).toBe(true);
    expect(/resolveActingContext\s*\(/.test(openapiClean)).toBe(false);
  });

  it("the offender check also bites on a TYPED handler param, e.g. `(c: Context)` (typed-param evasion class)", () => {
    // The gap this fix closed: the direct-handler regex only matched an
    // untyped arrow param `(c) =>`. A handler written `async (c: Context) =>`
    // (see rest/routing.ts POST /routing/resolve) was invisible to the
    // scanner — a future PATCH/PUT/DELETE handler typed that way and reading
    // body.userId would have evaded detection entirely.
    const fixture = `
      app.put("/danger4/:id", async (c: Context) => {
        const body = await c.req.json();
        const userId = body.userId;
        return c.json({ userId });
      });
    `;
    const handlers = findMutatingHandlers(fixture, new Map());
    expect(handlers.length).toBe(1);
    expect(handlers[0].method).toBe("put");
    const clean = stripComments(handlers[0].bodyText);
    expect(readsBodyUserId(clean)).toBe(true);
    expect(/resolveActingContext\s*\(/.test(clean)).toBe(false);
  });

  it("a GET/HEAD handler is never scanned (mutating-methods-only guard)", () => {
    const fixture = `
      app.get("/safe", async (c) => {
        const body = await c.req.json();
        const userId = body.userId;
        return c.json({ userId });
      });
    `;
    expect(findMutatingHandlers(fixture, new Map()).length).toBe(0);
  });

  const files = tsRouteFiles(REST_DIR);
  const allHandlers: Array<{
    file: string;
    method: MutatingMethod;
    label: string;
    bodyText: string;
  }> = [];
  for (const file of files) {
    const src = readFileSync(join(REST_DIR, file), "utf8");
    const routeMap = findRouteMethodMap(src);
    for (const h of findMutatingHandlers(src, routeMap)) {
      allHandlers.push({ file, ...h });
    }
  }
  const postHandlers = allHandlers.filter((h) => h.method === "post");
  const nonPostHandlers = allHandlers.filter((h) => h.method !== "post");

  it("scanned a substantial number of POST handlers (regex is alive)", () => {
    // Self-guard: if the extraction regexes silently break (e.g. a Hono API
    // change), this catches the count collapsing to ~0 instead of passing
    // vacuously. There were 100+ POST handlers under rest/ at authoring time.
    expect(postHandlers.length).toBeGreaterThan(100);
  });

  it("scanned a substantial number of PATCH/PUT/DELETE handlers (regex is alive)", () => {
    // Self-guard for the 2026-08-01 coverage-gap fix: if the non-POST
    // extraction silently breaks, this catches the count collapsing to ~0
    // instead of passing vacuously. There were 30+ PATCH/PUT/DELETE handlers
    // under rest/ at the time this coverage was added.
    expect(nonPostHandlers.length).toBeGreaterThan(30);
  });

  it("no un-allowlisted hub REST mutating handler reads body.userId without resolveActingContext / mayActAsUser", () => {
    const offenders: string[] = [];
    for (const h of allHandlers) {
      const clean = stripComments(h.bodyText);
      const hasBodyUserId = readsBodyUserId(clean);
      const hasActingContext = bindsIdentity(clean);
      if (!hasBodyUserId || hasActingContext) continue;
      const key = `${h.file}::${h.label}`;
      if (ALLOWLIST[key]) continue;
      offenders.push(`${key} (${h.method})`);
    }
    expect(offenders).toEqual([]);
  });

  it("every allowlist entry still matches a real scanned handler (shrink-only, no stale entries)", () => {
    const scannedKeys = new Set(
      allHandlers.map((h) => `${h.file}::${h.label}`)
    );
    const stale = Object.keys(ALLOWLIST).filter((k) => !scannedKeys.has(k));
    expect(stale).toEqual([]);
  });
});

/**
 * TRIPWIRE — no hub-protocol router may decide identity on "the caller has an
 * api key id". The auth middleware sets `apiKeyId` for EVERY bearer key, so that
 * check silently made every agent key a trusted on-behalf-of service: ten inline
 * copies (entities.ts ×9, relations.ts ×1) plus the shared helper did exactly
 * that until 2026-09-13. The rule now lives ONLY in `mayActAsUser` (rest/_shared.ts).
 *
 * Scans every non-test `.ts` under routers/hub-protocol (recursive, derived — a
 * new file joins by existing). It does NOT see a differently-spelled equivalent
 * (e.g. `c.get("apiKeyId") !== undefined`, or reading apiKeyId into a variable
 * first); the doc-comment in _shared.ts that names the pattern is excluded by
 * comment stripping.
 *
 * BLIND SPOT — READ doors (measured 2026-09-13, not guarded here): a GET handler
 * that reads `?userId` (`query.userId`, `c.req.query("userId")`) and feeds it to
 * a visibility predicate is NOT scanned. It could not be derived honestly: most
 * such reads only forward the value into a tRPC procedure that floors on
 * `ctx.userId` or strict `assertMayActAs`, and a regex cannot tell that
 * forwarding from a direct predicate. `GET /threads` (threads.ts
 * `channelVisibilityWhere(query.userId)`) was the live instance.
 */
describe("tripwire: no inline apiKeyId identity decision outside mayActAsUser", () => {
  const HUB_DIR = join(process.cwd(), "src/routers/hub-protocol");
  const sources = walkTs(HUB_DIR).map((p) => ({
    rel: p.slice(HUB_DIR.length + 1),
    clean: stripComments(readFileSync(p, "utf8")),
  }));

  it("the scan is alive: the regex bites on literal samples and the file set is plausible", () => {
    expect(
      INLINE_APIKEY_IDENTITY_RE.test(`const isServiceKey = !!c.get("apiKeyId");`)
    ).toBe(true);
    expect(INLINE_APIKEY_IDENTITY_RE.test(`!!c.get( 'apiKeyId' )`)).toBe(true);
    expect(
      INLINE_APIKEY_IDENTITY_RE.test(`checkHubRateLimit(c.get("apiKeyId"), "x")`)
    ).toBe(false);
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.some((s) => s.rel === "rest/entities.ts")).toBe(true);
  });

  it("the predicate is actually in use (non-vacuity: the retired sites route through it)", () => {
    const calls = (rel: string) =>
      (sources.find((s) => s.rel === rel)?.clean.match(/\bmayActAsUser\s*\(/g) ??
        []).length;
    expect(calls("rest/entities.ts")).toBeGreaterThanOrEqual(9);
    expect(calls("rest/relations.ts")).toBeGreaterThanOrEqual(1);
  });

  it("no router decides identity on !!c.get(\"apiKeyId\") / isServiceKey", () => {
    const offenders = sources
      .filter((s) => INLINE_APIKEY_IDENTITY_RE.test(s.clean))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });
});
