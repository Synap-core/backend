/**
 * TRIPWIRE — every MCP READ tool is classified for scoped keys.
 *
 * The fence (`access/grant-door-fence.ts`) lets a fenced key through a read
 * tool only when MCP_READ_TOOL_DOORS says how the grant bounds it: SEAMED
 * (read through scopedDb / the grant hooks) or READS (an aggregate door that
 * declares its subjects; the key must read each one unnarrowed). The set is
 * DERIVED from the live tool list (`tools.list()`, `readOnlyHint: true`), so
 * a new read tool fails here until someone classifies it — and an entry for a
 * tool that is gone or is a write fails too.
 *
 * HUB REST ROUTE CLASSES (plan-access A3): every served Hub route is `read`,
 * `write` or `owner-wide` (`hubRouteClass`, from the fence's declarations).
 * The route set is DERIVED from the served app (`hubProtocolRestApp.routes`,
 * method + path + handler source). Checked: a route declared `read` that is
 * not a GET reaches no write gate in its handler (a write declared a read
 * would let a scoped key through as a read door), and every fence declaration
 * names a served route of the method it governs (no stale entry).
 *
 * NOT COVERED (stated): whether a declared subject list is COMPLETE for its
 * door is a review question, not something this scan can see; a door that
 * reads one more subject than it declares is bounded too loosely. Hub REST
 * GET routes are not derived (the fence keeps its allow-list, fail closed);
 * their DECLARED subjects (`GRANT_REST_GET_READS`, `GRANT_REST_POST_READS`)
 * are checked against the read hook below. That a `write` route REACHES a
 * gate is not checked: measured 2026-10-26, about half of the ~300 non-GET
 * handlers name no gate in their own source (they write through a service
 * or a tRPC caller); that audit is its own wave. A gate reached only through
 * a helper outside the handler's source is invisible to the read check.
 */
import { describe, expect, it } from "vitest";
import { tools } from "../routers/mcp/tools/index.js";
import {
  GRANT_OWNER_WIDE_REST_DOORS,
  GRANT_OWNER_WIDE_REST_WRITES,
  GRANT_REST_GET_READS,
  GRANT_REST_POST_READS,
  GRANT_SAFE_REST_READS,
  MCP_READ_TOOL_DOORS,
  hubRouteClass,
} from "../access/grant-door-fence.js";
import { GRANT_READ_SPECS } from "../access/grant-read.js";
import { hubProtocolRestApp } from "../routers/hub-protocol-rest.js";

describe("MCP read-tool classification (derived from the live tool list)", () => {
  it("classifies every read tool, and only read tools", async () => {
    const all = await tools.list();
    const reads = all
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name);
    // Non-vacuity: the scan sees the tool list and the doors it must cover.
    expect(all.length).toBeGreaterThan(60);
    expect(reads).toEqual(
      expect.arrayContaining(["synap_ask", "synap_orient", "synap_get_entity"])
    );
    expect(reads.length).toBeGreaterThanOrEqual(25);

    const classified = Object.keys(MCP_READ_TOOL_DOORS);
    expect(
      reads.filter((n) => !classified.includes(n)),
      "Classify the tool in MCP_READ_TOOL_DOORS (access/grant-door-fence.ts)."
    ).toEqual([]);
    expect(classified.filter((n) => !reads.includes(n))).toEqual([]);
  });

  it("declares only subjects the read hook knows (MCP tools and Hub REST doors)", () => {
    const known = new Set([...GRANT_READ_SPECS.values()].map((s) => s.subject));
    const doors = [
      ...Object.entries(MCP_READ_TOOL_DOORS),
      ...[...GRANT_REST_GET_READS, ...GRANT_REST_POST_READS].map(
        ([r, d]) => [String(r), d] as const
      ),
    ];
    // Non-vacuity: the REST declarations are in the scanned set.
    expect(GRANT_REST_GET_READS.length).toBeGreaterThanOrEqual(5);
    expect(known.has("session")).toBe(true);
    const declared = (d: (typeof doors)[number][1]): readonly string[] =>
      d.bound === "reads"
        ? d.subjects
        : d.bound === "person"
          ? [d.subject]
          : [];
    const unknown = doors.flatMap(([n, d]) =>
      declared(d)
        .filter((s) => !known.has(s))
        .map((s) => `${n}:${s}`)
    );
    expect(unknown).toEqual([]);
  });
});

/** A write gate named in a handler: the door's write checks or governance. */
const WRITE_GATE =
  /\b(?:checkPermissionOrPropose|assertCanWrite|canWrite|assertWorkspaceWrite)\s*\(/;

const ID = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
/** `/files/:entityId/url` → a path the fence's regexes can be asked about. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, ID).replace(/\*/g, "x");
}

interface ServedRoute {
  method: string;
  path: string;
  /** Every handler registered for this method + path (validators included). */
  source: string;
}

/** The served Hub routes, one per method + path (ALL = middleware, skipped). */
function servedRoutes(): ServedRoute[] {
  const byKey = new Map<string, ServedRoute>();
  for (const r of hubProtocolRestApp.routes as Array<{
    method: string;
    path: string;
    handler: (...a: unknown[]) => unknown;
  }>) {
    if (r.method === "ALL") continue;
    const key = `${r.method} ${r.path}`;
    const prev = byKey.get(key);
    const source = String(r.handler);
    byKey.set(
      key,
      prev
        ? { ...prev, source: `${prev.source}\n${source}` }
        : { method: r.method, path: r.path, source }
    );
  }
  return [...byKey.values()];
}

/** Routes declared `read` that are not GET/HEAD but name a write gate. */
export function readsThatWrite(routes: readonly ServedRoute[]): string[] {
  return routes
    .filter(
      (r) =>
        r.method !== "GET" &&
        r.method !== "HEAD" &&
        hubRouteClass(r.method, concrete(r.path)) === "read" &&
        WRITE_GATE.test(r.source)
    )
    .map((r) => `${r.method} ${r.path}`);
}

describe("Hub REST route classes (derived from the served routes)", () => {
  const routes = servedRoutes();
  const classOf = (r: ServedRoute) => hubRouteClass(r.method, concrete(r.path));

  it("sees the served routes and every class (non-vacuity)", () => {
    expect(routes.length).toBeGreaterThan(300);
    const count = (c: string) => routes.filter((r) => classOf(r) === c).length;
    expect(count("read")).toBeGreaterThan(100);
    expect(count("write")).toBeGreaterThan(150);
    expect(count("owner-wide")).toBeGreaterThanOrEqual(5);
    // The read check sees the handlers' own code: these name the door's
    // write floor today (the attachments / uploads routes, rest/entities.ts).
    const gated = routes.filter(
      (r) => classOf(r) === "write" && WRITE_GATE.test(r.source)
    );
    expect(gated.length).toBeGreaterThanOrEqual(10);
  });

  it("a route declared `read` (a POST read) reaches no write gate", () => {
    // Non-vacuity: the POST reads are in the scanned set.
    expect(
      routes.filter((r) => r.method === "POST" && classOf(r) === "read").length
    ).toBeGreaterThanOrEqual(5);
    expect(
      readsThatWrite(routes),
      "A route that writes is declared a read in GRANT_REST_POST_READS " +
        "(access/grant-door-fence.ts): a scoped key would pass it as a read door."
    ).toEqual([]);
  });

  it("self-check: a POST read that names a write gate is flagged", () => {
    const [readPattern] = GRANT_REST_POST_READS[0]!;
    const path = routes.find(
      (r) => r.method === "POST" && readPattern.test(concrete(r.path))
    )!.path;
    expect(
      readsThatWrite([
        { method: "POST", path, source: "await canWrite(p, { workspace: w })" },
        { method: "POST", path, source: "await canRead(p, { workspace: w })" },
        { method: "GET", path, source: "await canWrite(p, { workspace: w })" },
      ])
    ).toEqual([`POST ${path}`]);
  });

  it("every fence declaration names a served route of its method (no stale entry)", () => {
    const served = (methods: string[], r: RegExp) =>
      routes.some(
        (route) =>
          methods.includes(route.method) && r.test(concrete(route.path))
      );
    const NON_GET = ["POST", "PUT", "PATCH", "DELETE"];
    const stale = [
      ...GRANT_SAFE_REST_READS.filter((r) => !served(["GET"], r)),
      ...GRANT_REST_GET_READS.map(([r]) => r).filter(
        (r) => !served(["GET"], r)
      ),
      ...GRANT_REST_POST_READS.map(([r]) => r).filter(
        (r) => !served(["POST"], r)
      ),
      ...GRANT_OWNER_WIDE_REST_DOORS.filter(
        (r) => !served(["GET", ...NON_GET], r)
      ),
      ...GRANT_OWNER_WIDE_REST_WRITES.filter((r) => !served(NON_GET, r)),
    ].map(String);
    expect(stale).toEqual([]);
  });
});
