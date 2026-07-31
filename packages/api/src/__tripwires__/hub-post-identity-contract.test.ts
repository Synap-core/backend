import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — every hub-protocol REST POST route must resolve its acting
 * identity through `resolveActingContext` (rest/_shared.ts), never trust a
 * body-supplied `userId` directly.
 *
 * THE BUG THIS GUARDS: a Hub REST POST handler that reads `body.userId`
 * (or feeds it straight into `resolveActorId`) without first running it
 * through `resolveActingContext` lets ANY caller attribute a write to an
 * arbitrary `userId` — the exact "governed agent write becomes ungoverned
 * operator write" IDOR class. `resolveActingContext` is the ONE door that
 * turns a body-supplied `userId` into a verified, membership-checked acting
 * identity (session callers can never override it; service keys may pass an
 * on-behalf-of value, but it still flows through the same door). See
 * `rest/views.identity-contract.test.ts` for the behavioral (mocked) version
 * of this contract on the `/views/*` routes — this file is the source-level,
 * hub-wide generalization: it scans every `rest/*.ts` route file for POST
 * handlers (both `app.post(path, handler)` and `app.openapi(route, handler)`
 * where `route`'s `createRoute({ method: "post" })`) and fails any handler
 * that reads `body.userId` without also calling `resolveActingContext(`.
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
 * POST /profiles + POST /property-defs). Every entry has a reason. Entries
 * marked VULN are the SAME bug class, not yet fixed — pending a follow-up
 * wave — and must never be treated as "fine, it's allowlisted".
 */

const REST_DIR = join(process.cwd(), "src/routers/hub-protocol/rest");

/**
 * SHRINK-ONLY allowlist. Key = `${file}::${label}` where `label` is the route
 * path (app.post) or the `createRoute` variable name (app.openapi). Never add
 * an entry for a route you are authoring or materially changing — fix the
 * identity flow instead. Only remove entries (as routes get fixed).
 */
const ALLOWLIST: Record<string, string> = {
  // ── SAFE — inline equivalent of resolveActingContext ──────────────────────
  // These three predate the extracted `resolveActingContext` helper and hand-rolled
  // the identical rule inline: a session caller's body.userId is checked against
  // (never allowed to override) the authenticated userId; only a service key may
  // pass it on-behalf-of. Functionally equivalent, just not routed through the
  // named function. TODO: migrate to `resolveActingContext` for consistency, but
  // not a live IDOR.
  "entities.ts::attachEntityRoute":
    "SAFE — inlines the session/service-key identity pin (authUserId + isServiceKey guard) equivalent to resolveActingContext; predates the helper.",
  "entities.ts::attachFacetRoute":
    "SAFE — inlines the same session/service-key identity pin as attachEntityRoute; predates the helper.",
  "entities.ts::/files":
    "SAFE — both the multipart and JSON branches inline the same session/service-key identity pin before use; predates the helper.",
};

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

interface Handler {
  label: string;
  bodyText: string;
}

function findPostHandlers(
  src: string,
  routeMethodMap: Map<string, string | null>
): Handler[] {
  const handlers: Handler[] = [];

  const postRe = /app\.post\(\s*(["'`])([^"'`]*)\1\s*,\s*(?:async\s*)?\(c\)/g;
  let m: RegExpExecArray | null;
  while ((m = postRe.exec(src))) {
    const body = extractHandlerBody(src, m.index);
    if (body) handlers.push({ label: m[2], bodyText: body });
  }

  const openapiRe = /app\.openapi\(\s*(\w+)\s*,\s*(?:async\s*)?\(c\)/g;
  while ((m = openapiRe.exec(src))) {
    const routeName = m[1];
    if (routeMethodMap.get(routeName) !== "post") continue;
    const body = extractHandlerBody(src, m.index);
    if (body) handlers.push({ label: routeName, bodyText: body });
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

describe("tripwire: hub REST POST routes bind identity via resolveActingContext", () => {
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
    const handlers = findPostHandlers(fixture, map);
    expect(handlers.length).toBe(1);
    expect(handlers[0].bodyText).toContain("const body = { a: 1 }");
  });

  it("the offender check actually bites (fails on an unguarded fixture)", () => {
    const fixture = `
      app.post("/danger", async (c) => {
        const body = await c.req.json();
        const userId = body.userId;
        return c.json({ userId });
      });
    `;
    const handlers = findPostHandlers(fixture, new Map());
    expect(handlers.length).toBe(1);
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
    const handlers = findPostHandlers(fixture, new Map());
    expect(handlers.length).toBe(1);
    const clean = stripComments(handlers[0].bodyText);
    expect(readsBodyUserId(clean)).toBe(true);
    expect(/resolveActingContext\s*\(/.test(clean)).toBe(false);
  });

  const files = tsRouteFiles(REST_DIR);
  const allHandlers: Array<{ file: string; label: string; bodyText: string }> =
    [];
  for (const file of files) {
    const src = readFileSync(join(REST_DIR, file), "utf8");
    const routeMap = findRouteMethodMap(src);
    for (const h of findPostHandlers(src, routeMap)) {
      allHandlers.push({ file, ...h });
    }
  }

  it("scanned a substantial number of POST handlers (regex is alive)", () => {
    // Self-guard: if the extraction regexes silently break (e.g. a Hono API
    // change), this catches the count collapsing to ~0 instead of passing
    // vacuously. There were 100+ POST handlers under rest/ at authoring time.
    expect(allHandlers.length).toBeGreaterThan(100);
  });

  it("no un-allowlisted hub REST POST handler reads body.userId without resolveActingContext", () => {
    const offenders: string[] = [];
    for (const h of allHandlers) {
      const clean = stripComments(h.bodyText);
      const hasBodyUserId = readsBodyUserId(clean);
      const hasActingContext = /resolveActingContext\s*\(/.test(clean);
      if (!hasBodyUserId || hasActingContext) continue;
      const key = `${h.file}::${h.label}`;
      if (ALLOWLIST[key]) continue;
      offenders.push(key);
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
