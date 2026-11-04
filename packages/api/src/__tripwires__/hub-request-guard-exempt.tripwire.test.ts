/**
 * TRIPWIRE: the Hub request guard never times out a streaming, long-poll or
 * upload route (`middleware/hub-request-guard.ts`), and its exempt list names
 * only routes that exist.
 *
 * The scanned sets are DERIVED from the source, never hand-listed:
 *  - Hub REST: every route handler in `routers/hub-protocol/rest/*.ts` whose
 *    body streams (`streamSSE(` / `text/event-stream`), waits
 *    (`waitForSession…(` / `waitForConversation…(`) or reads a multipart body
 *    (`parseBody(` / `formData()` / `multipart/form-data`) must be exempt with
 *    the matching kind.
 *  - MCP: every tool handler that waits is a long poll; every tool that
 *    declares `openWorldHint: true` is never timed; the guard runs only in the
 *    POST door, never on the GET SSE stream.
 *  - The guard is mounted on Hub REST after auth and before the session and
 *    idempotency middleware, and its env keys reach a deployed pod.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  classifyHubRestRequest,
  classifyMcpToolCall,
  guardPolicy,
  HUB_REQUEST_GUARD_ENV,
  HUB_REST_EXEMPT_ROUTES,
  type HubGuardExemption,
} from "../middleware/hub-request-guard.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const REST_DIR = join(SRC, "routers/hub-protocol/rest");
const MCP_DIR = join(SRC, "routers/mcp");
const REPO = join(SRC, "../../..");

/** Source with comments removed, so a marker in prose never counts. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

interface Route {
  file: string;
  method: string;
  path: string;
  /** The handler's source, up to the next registration. */
  body: string;
}

/** Every route registered in one rest file, with its handler's source. */
function routesOf(file: string): Route[] {
  const src = code(readFileSync(join(REST_DIR, file), "utf8"));
  const regs: Array<{ at: number; method: string; path: string }> = [];
  for (const m of src.matchAll(
    /\bapp\.(get|post|put|patch|delete|all)\(\s*"([^"]+)"/g
  ))
    regs.push({ at: m.index!, method: m[1].toUpperCase(), path: m[2] });
  for (const m of src.matchAll(/\bapp\.openapi\(\s*(\w+)?/g)) {
    let def = src.slice(m.index!, m.index! + 800);
    if (m[1] && m[1] !== "createRoute") {
      const at = src.search(new RegExp(`const ${m[1]}\\s*=\\s*createRoute\\(`));
      if (at < 0) continue;
      def = src.slice(at, at + 800);
    }
    const method = /method:\s*"(\w+)"/.exec(def)?.[1];
    const path = /path:\s*"([^"]+)"/.exec(def)?.[1];
    if (method && path)
      regs.push({
        at: m.index!,
        method: method.toUpperCase(),
        path: path.replace(/\{(\w+)\}/g, ":$1"),
      });
  }
  regs.sort((a, b) => a.at - b.at);
  return regs.map((r, i) => ({
    file,
    method: r.method,
    path: r.path,
    body: src.slice(r.at, regs[i + 1]?.at ?? src.length),
  }));
}

const restFiles = readdirSync(REST_DIR).filter(
  (f) => f.endsWith(".ts") && !f.includes(".test.") && !f.startsWith("_")
);
const routes = restFiles.flatMap(routesOf);

const MARKERS: Array<[HubGuardExemption, RegExp]> = [
  ["stream", /streamSSE\(|text\/event-stream/],
  ["long_poll", /\bwaitFor(?:Session|Conversation)\w*\(/],
  ["upload", /\.parseBody\(|\.formData\(\)|multipart\/form-data/],
];

/**
 * A marker that is not what it looks like. Each entry says why.
 */
const NOT_LONG: Record<string, string> = {
  // RFC 8628 token poll: an `application/x-www-form-urlencoded` body of three
  // short fields, read with parseBody. Not an upload.
  "POST /setup/device/token": "form-urlencoded device-flow poll",
};

describe("tripwire: the Hub request guard never times out a long route", () => {
  it("finds the route registrations it scans (non-vacuity)", () => {
    expect(routes.length).toBeGreaterThan(200);
  });

  for (const [kind, marker] of MARKERS) {
    const hits = routes.filter(
      (r) => marker.test(r.body) && !NOT_LONG[`${r.method} ${r.path}`]
    );
    it(`every Hub REST route whose handler is a ${kind} is exempt as ${kind}`, () => {
      // Non-vacuity: the scan sees the routes it exists to hold.
      expect(hits.length).toBeGreaterThan(0);
      const wrong = hits
        .filter(
          (r) => classifyHubRestRequest(r.method, `/api/hub${r.path}`) !== kind
        )
        .map((r) => `${r.file}: ${r.method} ${r.path}`);
      expect(wrong).toEqual([]);
    });
  }

  it("a stream or a long poll is neither timed nor counted", () => {
    expect(guardPolicy("stream")).toEqual({ timed: false, counted: false });
    expect(guardPolicy("long_poll")).toEqual({ timed: false, counted: false });
    expect(guardPolicy("upload").timed).toBe(false);
    expect(guardPolicy("model").timed).toBe(false);
  });

  it("every exempt entry names a route that exists", () => {
    const stale = HUB_REST_EXEMPT_ROUTES.filter(
      (e) =>
        !routes.some(
          (r) =>
            (e.method === "*" || e.method === r.method) &&
            e.pattern.test(r.path)
        )
    ).map((e) => `${e.method} ${e.path}`);
    expect(stale).toEqual([]);
  });

  it("MCP: every tool handler that waits is a long poll", () => {
    const waiting: string[] = [];
    for (const f of readdirSync(join(MCP_DIR, "handlers")).filter(
      (n) => n.endsWith(".ts") && !n.includes(".test.")
    )) {
      const src = code(readFileSync(join(MCP_DIR, "handlers", f), "utf8"));
      const heads = [...src.matchAll(/^\s+(synap_\w+):\s*async\b/gm)];
      heads.forEach((h, i) => {
        const body = src.slice(h.index!, heads[i + 1]?.index ?? src.length);
        if (MARKERS[1][1].test(body)) waiting.push(h[1]);
      });
    }
    expect(waiting.length).toBeGreaterThan(0);
    expect(
      waiting.filter((t) => classifyMcpToolCall(t, new Set()) !== "long_poll")
    ).toEqual([]);
  });

  it("MCP: every tool that declares openWorldHint is never timed", () => {
    const src = readFileSync(join(MCP_DIR, "tools/index.ts"), "utf8");
    const openWorld = [
      ...src.matchAll(
        /name:\s*"(synap_\w+)",\s*annotations:\s*\{[^}]*openWorldHint:\s*true/g
      ),
    ].map((m) => m[1]);
    expect(openWorld.length).toBeGreaterThan(0);
    // The handler reads them from the tools' own metadata
    // (`openWorldToolNames`); the classification honours that set.
    expect(
      openWorld.filter(
        (t) => guardPolicy(classifyMcpToolCall(t, new Set(openWorld))).timed
      )
    ).toEqual([]);
    const handler = readFileSync(join(MCP_DIR, "http-handler.ts"), "utf8");
    expect(handler).toMatch(/openWorldToolNames\(\)/);
  });

  it("MCP: the guard runs in the POST door only, never on the GET SSE stream", () => {
    const src = code(readFileSync(join(MCP_DIR, "http-handler.ts"), "utf8"));
    const get = src.indexOf('mcpHttpApp.get("/"');
    const post = src.indexOf('mcpHttpApp.post("/"');
    const del = src.indexOf('mcpHttpApp.delete("/"');
    expect(get).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(get);
    expect(del).toBeGreaterThan(post);
    const calls = [...src.matchAll(/\brunGuarded\(/g)].map((m) => m.index!);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBeGreaterThan(post);
    expect(calls[0]).toBeLessThan(del);
  });

  it("Hub REST mounts the guard after auth, before session and idempotency", () => {
    const src = code(
      readFileSync(join(SRC, "routers/hub-protocol-rest.ts"), "utf8")
    );
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const guard = at('app.use("/*", hubRequestGuardMiddleware)');
    expect(guard).toBeGreaterThan(at('app.use("/*", hubAuthMiddleware)'));
    expect(guard).toBeLessThan(at('app.use("*", sessionMiddleware)'));
    expect(guard).toBeLessThan(at("idempotencyMiddleware({"));
    expect(guard).toBeLessThan(at("registerAuthRoutes(app)"));
  });

  it("a deployed pod receives its env keys: compose passes them, env.schema accepts them", () => {
    const compose = readFileSync(
      join(REPO, "deploy/docker-compose.yml"),
      "utf8"
    );
    const schema = new Set(
      readFileSync(join(REPO, "deploy/env.schema"), "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.trimStart().startsWith("#"))
        .map((l) => l.trim().split(/\s+/)[0])
    );
    for (const k of Object.values(HUB_REQUEST_GUARD_ENV)) {
      expect(compose, k).toContain(`${k}: \${${k}:-}`);
      expect(schema.has(k), k).toBe(true);
    }
  });
});
