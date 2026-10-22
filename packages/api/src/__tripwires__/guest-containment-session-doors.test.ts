/**
 * TRIPWIRE — a GUEST is refused on every Hono door that signs a person in with
 * a session middleware — `authMiddleware`, or the app session gate
 * `appSessionMiddleware` (outside tRPC, the hub and MCP, which have their
 * own guards): `/api/chat`, `/api/files`, `/api/capture`, and whatever joins
 * them.
 *
 * DERIVED, BEHAVIOURAL: the scanned set is every non-test module under
 * `routers/` whose CODE uses `authMiddleware`; each Hono app such a module
 * exports is requested on every route with a guest session. Stubbed:
 * `authMiddleware` (sets the guest's `userId`, as the real one does after a
 * Kratos lookup) and the audience probe (`AccessContext.prototype.audience` →
 * "guest"). The refusal runs before any handler.
 *
 * NOT COVERED: `apps/api` routes (their own derived scan lives in
 * `apps/api/src/session-doors-refuse-guests.tripwire.test.ts`), and a module
 * that exports its app under a non-Hono wrapper.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUEST = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

vi.mock("@synap/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set("userId", GUEST);
    await next();
  },
}));

import { AccessContext } from "../access/context.js";
import { GUEST_REFUSED_MESSAGE } from "../access/guest-containment.js";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTERS = path.resolve(HERE, "../routers");
const ID = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Source without comments, so a doc mention is not a use. The shared scanner:
 * a `// … /trpc/* …` line must not open a block comment that swallows the code
 * after it (a regex strip did, and hid `chat-stream.ts` from this scan).
 */
function codeOnly(src: string): string {
  return stripComments(src, "ts");
}

/** Top-level static imports, so that importing the name is not a use. */
const IMPORT_STMT = /^import\s[\s\S]*?\sfrom\s+["'][^"']+["'];?/gm;

/**
 * The session-auth middleware NAMES, derived from their packages' own export
 * lists: what `@synap/auth` exports from its Kratos middleware module, and
 * every `…Middleware` this package exports from its app session gate
 * (`appSessionMiddleware`, which delegates to the stubbed
 * `authMiddleware` when no device token is presented). A new alias joins the
 * scan by being exported.
 */
function exportedNames(indexFile: string, fromModule: string): string[] {
  const src = codeOnly(readFileSync(indexFile, "utf8"));
  const out: string[] = [];
  const re = /export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    if (m[2] !== fromModule) continue;
    for (const part of m[1]!.split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) out.push(name);
    }
  }
  return out;
}
const SESSION_DOORS = [
  ...exportedNames(
    path.resolve(HERE, "../../../auth/src/index.ts"),
    "./ory-middleware.js"
  ),
  ...exportedNames(
    path.resolve(HERE, "../index.ts"),
    "./middleware/app-session.js"
  ).filter((n) => n.endsWith("Middleware")),
];
const DOOR_USE = new RegExp(`\\b(?:${SESSION_DOORS.join("|")})\\b`);

const sessionModules = walk(ROUTERS).filter((f) => {
  const code = codeOnly(readFileSync(f, "utf8")).replace(IMPORT_STMT, "");
  return DOOR_USE.test(code);
});

type Route = { method: string; path: string };
type HonoLike = {
  routes: Route[];
  request: (url: string, init?: RequestInit) => Promise<Response>;
};

const isHono = (v: unknown): v is HonoLike =>
  !!v &&
  typeof v === "object" &&
  Array.isArray((v as HonoLike).routes) &&
  typeof (v as HonoLike).request === "function";

function concrete(p: string): string {
  return p.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, ID).replace(/\*/g, "x");
}

let audienceSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  audienceSpy = vi
    .spyOn(AccessContext.prototype, "audience")
    .mockResolvedValue("guest");
});
afterAll(() => audienceSpy.mockRestore());

describe("tripwire: session-authenticated Hono doors refuse a guest", () => {
  it("the scan finds the session doors (non-vacuity)", () => {
    expect(SESSION_DOORS).toEqual(
      expect.arrayContaining(["authMiddleware", "appSessionMiddleware"])
    );
    const rel = sessionModules.map((f) => path.relative(ROUTERS, f)).sort();
    // Measured 2026-09-27: these three, at least.
    expect(rel).toEqual(
      expect.arrayContaining([
        "capture-progress-stream.ts",
        "chat-stream.ts",
        "file-upload.ts",
        "media-transcribe.ts",
      ])
    );
  });

  it("every route of every exported app answers a guest with the refusal", async () => {
    const leaked: string[] = [];
    let routes = 0;
    for (const file of sessionModules) {
      const mod = (await import(file)) as Record<string, unknown>;
      const apps = Object.values(mod).filter(isHono);
      expect(apps.length, path.relative(ROUTERS, file)).toBeGreaterThan(0);
      for (const app of apps) {
        const seen = new Set<string>();
        for (const r of app.routes) {
          if (r.method === "ALL" && (r.path === "/*" || r.path === "*")) {
            continue; // the middleware registrations themselves
          }
          const method = r.method === "ALL" ? "GET" : r.method;
          const key = `${method} ${r.path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          routes++;
          const res = await app.request(concrete(r.path), {
            method,
            headers: { "content-type": "application/json" },
            body: method === "GET" || method === "HEAD" ? undefined : "{}",
          });
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          if (res.status !== 403 || body?.error !== GUEST_REFUSED_MESSAGE) {
            leaked.push(
              `${path.relative(ROUTERS, file)} ${key} → ${res.status}`
            );
          }
        }
      }
    }
    expect(leaked).toEqual([]);
    expect(routes).toBeGreaterThanOrEqual(3);
  });
});
