/**
 * TRIPWIRE — every door a scoped key can reach is classified, closed by
 * default (R1, 2 Nov 2026).
 *
 * MCP: the fence (`access/grant-door-fence.ts`) lets a fenced key through a
 * read tool only when MCP_READ_TOOL_DOORS says how the grant bounds it: SEAMED
 * (read through scopedDb / the grant hooks) or READS (an aggregate door that
 * declares its subjects; the key must read each one unnarrowed). Every OTHER
 * tool is in MCP_WRITE_TOOL_DOORS: a WRITE (bounded by the gate) or, when it
 * returns rows, the read door of what it returns. A tool in neither map is
 * refused to a fenced key. Both sets are DERIVED from the live tool list
 * (`tools.list()`, `readOnlyHint`), so a new tool fails here until someone
 * classifies it, and an entry for a tool that is gone or changed sides fails
 * too.
 *
 * HUB REST ROUTE CLASSES (plan-access A3): every served Hub route is `read`,
 * `write` or `owner-wide` (`hubRouteClass`, from the fence's declarations).
 * The route set is DERIVED from the served app (`hubProtocolRestApp.routes`,
 * method + path + handler source). Checked: a route declared `read` that is
 * not a GET reaches no write gate in its handler (a write declared a read
 * would let a scoped key through as a read door), and every fence declaration
 * names a served route of the method it governs (no stale entry).
 *
 * NON-GET ROUTES NAME THEIR GATE: every served POST/PUT/PATCH/DELETE route is
 * a declared read, owner-wide, a write whose handler names a write gate, a
 * write that calls a hub tRPC mutation the fence classifies `gated`
 * (TRPC_KEY_MUTATION_DOORS), a write gated by a named helper
 * (`GATED_ELSEWHERE`, whose own source must name a gate), or in the
 * shrink-only baseline of routes nobody has classified yet
 * (`grant-door-write-baseline.ts`). A NEW route in none of them fails, a
 * baseline row that is now classified or gone fails, and the baseline's cap
 * only goes down. The fence still lets a baselined POST through at run time:
 * this check stops the class from growing, it does not prove each baselined
 * handler reaches a gate.
 *
 * GET ROUTES ARE CLASSIFIED (4 Nov 2026): every served GET route is a safe
 * read, a declared read door (`GRANT_REST_GET_READS`, REFUSED included) or
 * owner-wide, or sits in the shrink-only baseline of routes nobody has
 * classified yet (`grant-door-read-baseline.ts`). The fence refuses an
 * unclassified GET to a scoped key (closed by default), so this is not a leak
 * check: it stops a read door from shipping unusable to every scoped key
 * because nobody classified it (findings 3122ba42, cce86e6b, 7da9c21f).
 *
 * NOT COVERED (stated): whether a declared subject list is COMPLETE for its
 * door is a review question, not something this scan can see; a door that
 * reads one more subject than it declares is bounded too loosely. The
 * DECLARED subjects (`GRANT_REST_GET_READS`, `GRANT_REST_POST_READS`)
 * are checked against the read hook below. A gate named in a handler or a
 * helper is not proven to run on every branch, and that an MCP WRITE tool
 * reaches a gate is not checked.
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
  MCP_WRITE_TOOL_DOORS,
  TRPC_KEY_MUTATION_DOORS,
  hubRouteClass,
} from "../access/grant-door-fence.js";
import {
  UNCLASSIFIED_WRITE_ROUTES,
  UNCLASSIFIED_WRITE_ROUTES_CAP,
} from "./grant-door-write-baseline.js";
import {
  UNCLASSIFIED_READ_ROUTES,
  UNCLASSIFIED_READ_ROUTES_CAP,
} from "./grant-door-read-baseline.js";
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

  it("classifies every other tool, and only those (closed by default)", async () => {
    const all = await tools.list();
    const others = all
      .filter((t) => t.annotations?.readOnlyHint !== true)
      .map((t) => t.name);
    // Non-vacuity: the scan sees the write tools, and the two that return
    // rows carry a read door, not WRITE.
    expect(others.length).toBeGreaterThanOrEqual(50);
    expect(others).toEqual(
      expect.arrayContaining(["synap_wait_for_answer", "synap_get_channel"])
    );
    expect(MCP_WRITE_TOOL_DOORS.synap_wait_for_answer?.bound).toBe("reads");
    expect(MCP_WRITE_TOOL_DOORS.synap_get_channel?.bound).toBe("reads");

    const classified = Object.keys(MCP_WRITE_TOOL_DOORS);
    expect(
      others.filter((n) => !classified.includes(n)),
      "Classify the tool in MCP_WRITE_TOOL_DOORS (access/grant-door-fence.ts): " +
        "WRITE when it only writes through the gate, else the read door of what it returns."
    ).toEqual([]);
    expect(classified.filter((n) => !others.includes(n))).toEqual([]);
  });

  it("declares only subjects the read hook knows (MCP tools and Hub REST doors)", () => {
    const known = new Set([...GRANT_READ_SPECS.values()].map((s) => s.subject));
    const doors = [
      ...Object.entries(MCP_READ_TOOL_DOORS),
      ...Object.entries(MCP_WRITE_TOOL_DOORS).flatMap(([n, d]) =>
        d.bound === "write" ? [] : [[n, d] as const]
      ),
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
          : d.bound === "narrowed"
            ? // A door narrowed on a gate verb (`capability … run`, the intent
              // actions doors) is admitted by that verb, not by a read of its
              // subject; what it reads is still `full`.
              d.action === "read"
              ? [d.subject, ...d.full]
              : [...d.full]
            : [];
    const unknown = doors.flatMap(([n, d]) =>
      declared(d)
        .filter((s) => !known.has(s))
        .map((s) => `${n}:${s}`)
    );
    expect(unknown).toEqual([]);
  });
});

/**
 * The write gates a handler can name: the door's write checks, governance,
 * the gate's rung 0 itself (`grantWriteDenial`) and the channel and facet
 * write checks that run it (`assertChannelWrite`, `canWriteFacet`).
 */
const GATES = [
  "checkPermissionOrPropose",
  "assertCanWrite",
  "canWrite",
  "assertWorkspaceWrite",
  "grantWriteDenial",
  "assertChannelWrite",
  "canWriteFacet",
] as const;
type Gate = (typeof GATES)[number];

/**
 * A call of `gate` in a handler's SERVED source. The test transform rewrites a
 * statically imported call to `(0, __vi_import_n__.canWrite)(…)`, so the name
 * may be followed by `)` before the call's own `(`; a destructured dynamic
 * import keeps the bare `checkPermissionOrPropose(…)`.
 */
const callOf = (gate: string): RegExp => new RegExp(`\\b${gate}\\)?\\s*\\(`);
const WRITE_GATE = new RegExp(GATES.map((g) => callOf(g).source).join("|"));

/**
 * Write routes whose own handler names a gate, each with the door it goes
 * through (read from the code, 2026-10-27). Every row must stay served, a
 * `write`, and name its door: this is what proves the read check below sees
 * the handlers' code, statically imported calls included.
 */
const GATED_WRITE_ROUTES: Readonly<Record<string, Gate>> = {
  // rest/entities.ts — the presigned upload lane, the door's write floor.
  "POST /files/uploads": "canWrite",
  "POST /files/uploads/finalize": "canWrite",
  // rest/cells.ts — a person's define needs the write floor, an agent's the gate.
  "POST /cells/define": "canWrite",
  // rest/whiteboards.ts — a placement proposal: the write floor, then the gate.
  "POST /whiteboards/:viewId/placements/propose": "canWrite",
  // rest/capture.ts — drafting a process into a space: its write floor.
  "POST /capture/draft-process": "assertWorkspaceWrite",
  // rest/commands.ts — running a command is a governed write.
  "POST /commands/execute": "checkPermissionOrPropose",
  // rest/cell-instances.ts — create, create from HTML, reconfigure: governed.
  "POST /cell-instances": "checkPermissionOrPropose",
  "POST /cell-instances/html": "checkPermissionOrPropose",
  "PATCH /cell-instances/:id/config": "checkPermissionOrPropose",
};

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
    // The read check sees the handlers' own code, statically imported calls
    // included: every known gated write route names its door.
    const byKey = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
    const missing = Object.entries(GATED_WRITE_ROUTES)
      .filter(([key, gate]) => {
        const r = byKey.get(key);
        return !r || classOf(r) !== "write" || !callOf(gate).test(r.source);
      })
      .map(([key, gate]) => `${key} → ${gate}`);
    expect(missing).toEqual([]);
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
        // The served (transformed) form of a statically imported call.
        {
          method: "POST",
          path,
          source: "await (0, __vi_import_3__.canWrite)(p, { workspace: w })",
        },
        { method: "GET", path, source: "await canWrite(p, { workspace: w })" },
      ])
    ).toEqual([`POST ${path}`, `POST ${path}`]);
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

/**
 * Writes gated by a helper their handler calls, read from the code (R1,
 * 2 Nov 2026). Each row is checked: the handler still names `via`, and `via`'s
 * own source names a write gate. A helper that gates only through a deeper
 * call does not qualify: that route stays in the baseline until its gate is
 * named one level down.
 */
const GATED_ELSEWHERE: Readonly<
  Record<
    string,
    {
      via: string;
      load: () => Promise<Record<string, unknown>>;
      why: string;
    }
  >
> = {
  "POST /projects": {
    via: "createProjectGoverned",
    load: () => import("../services/projects/create-project.js"),
    why: "project.create through checkPermissionOrPropose",
  },
  "PATCH /projects/:id": {
    via: "updateProjectGoverned",
    load: () => import("../services/projects/update-project.js"),
    why: "project.update through checkPermissionOrPropose",
  },
  "DELETE /projects/:id": {
    via: "deleteProjectGoverned",
    load: () => import("../services/projects/delete-project.js"),
    why: "project.delete through checkPermissionOrPropose",
  },
  "POST /tracks": {
    via: "startTrack",
    load: () => import("../services/tracks/tracks-service.js"),
    why: "track.create through checkPermissionOrPropose",
  },
  "POST /shares": {
    via: "shareResource",
    load: () => import("../services/sharing/share-service.js"),
    why: "a share is a governed write",
  },
  "POST /shares/sites/:id/charts/publish": {
    via: "publishChartsToSite",
    load: () => import("../services/sharing/site-charts.js"),
    why: "share.create through checkPermissionOrPropose (an agent's batch is one proposal)",
  },
  "POST /shares/sites/:id/charts/unpublish": {
    via: "unpublishChartsFromSite",
    load: () => import("../services/sharing/site-charts.js"),
    why: "narrowing only, still within the key's grant (grantWriteDenial)",
  },
  "POST /channels/:channelId/bind": {
    via: "proposeChannelBind",
    load: () => import("../utils/propose-channel-bind.js"),
    why: "binding a channel is proposed through the gate",
  },
  "POST /focus-sessions": {
    via: "createFocusSession",
    load: () => import("../services/focus-sessions/create-session.js"),
    why: "focus_session.create through checkPermissionOrPropose",
  },
  "POST /focus-sessions/:id/complete": {
    via: "completeFocusSession",
    load: () => import("../services/focus-sessions/complete-session.js"),
    why: "closing a session passes the gate",
  },
  "POST /agent-skills": {
    via: "insertSkillGoverned",
    load: () => import("../routers/skills.js"),
    why: "skill.create through checkPermissionOrPropose",
  },
  "POST /rules": {
    via: "createRuleGoverned",
    load: () => import("../services/rules/create.js"),
    why: "rule.create through checkPermissionOrPropose",
  },
  "PATCH /rules/:id": {
    via: "updateRuleGoverned",
    load: () => import("../services/rules/update.js"),
    why: "rule.update through checkPermissionOrPropose",
  },
  "POST /messaging/conversations/:threadId/send": {
    via: "sendExternalMessage",
    load: () => import("../connectors/external-dispatch.js"),
    why: "messaging.send checked by grantWriteDenial in the conversation's space",
  },
  "POST /channels/:channelId/send": {
    via: "sendExternalMessage",
    load: () => import("../connectors/external-dispatch.js"),
    why: "the person's send: filed through the send door (grant verdict, gate), then the approve door",
  },
  "POST /proposals": {
    via: "fencedProposalVerdict",
    load: () => import("../access/fenced-proposal.js"),
    why: "the free-form proposal runs rung 0 itself (fenced-proposal.ts)",
  },
};

/** `router.procedure` names a handler calls (`caller.entities.createEntity(`). */
function trpcCallsOf(source: string): string[] {
  return [...source.matchAll(/\.([a-zA-Z]+)\.([a-zA-Z]+)\s*\(/g)].map(
    (m) => `${m[1]}.${m[2]}`
  );
}

type NonGetClass =
  | "read"
  | "owner-wide"
  | "gated"
  | "gated-trpc"
  | "gated-elsewhere"
  | "unclassified";

/** How a served non-GET route is bounded, from the fence and its own code. */
export function nonGetRouteClass(r: ServedRoute): NonGetClass {
  const cls = hubRouteClass(r.method, concrete(r.path));
  if (cls !== "write") return cls;
  if (WRITE_GATE.test(r.source)) return "gated";
  if (
    trpcCallsOf(r.source).some(
      (p) => TRPC_KEY_MUTATION_DOORS[p]?.bound === "gated"
    )
  )
    return "gated-trpc";
  const elsewhere = GATED_ELSEWHERE[`${r.method} ${r.path}`];
  if (elsewhere && callOf(elsewhere.via).test(r.source))
    return "gated-elsewhere";
  return "unclassified";
}

describe("Hub REST non-GET routes name their gate (closed by default)", () => {
  const nonGet = servedRoutes().filter(
    (r) => r.method !== "GET" && r.method !== "HEAD"
  );
  const keyOf = (r: ServedRoute) => `${r.method} ${r.path}`;
  const unclassified = nonGet
    .filter((r) => nonGetRouteClass(r) === "unclassified")
    .map(keyOf)
    .sort();

  it("sees every class (non-vacuity)", () => {
    expect(nonGet.length).toBeGreaterThan(250);
    const count = (c: NonGetClass) =>
      nonGet.filter((r) => nonGetRouteClass(r) === c).length;
    expect(count("read")).toBeGreaterThanOrEqual(15);
    expect(count("owner-wide")).toBeGreaterThanOrEqual(15);
    expect(count("gated")).toBeGreaterThanOrEqual(20);
    expect(count("gated-trpc")).toBeGreaterThanOrEqual(30);
    expect(count("gated-elsewhere")).toBe(Object.keys(GATED_ELSEWHERE).length);
  });

  it("a new non-GET route is classified: a declared read or a named gate", () => {
    const baseline = new Set(UNCLASSIFIED_WRITE_ROUTES);
    expect(
      unclassified.filter((k) => !baseline.has(k)),
      "Name the write gate in the handler (checkPermissionOrPropose, canWrite, …), " +
        "call a `gated` hub tRPC mutation, add a GATED_ELSEWHERE row (its helper " +
        "must name a gate), or declare the route a read in GRANT_REST_POST_READS " +
        "(access/grant-door-fence.ts). Never add it to the baseline."
    ).toEqual([]);
  });

  it("the baseline only shrinks: no classified, gone or duplicate row, under its cap", () => {
    const now = new Set(unclassified);
    expect(
      UNCLASSIFIED_WRITE_ROUTES.filter((k) => !now.has(k)),
      "Classified or no longer served: remove it from grant-door-write-baseline.ts " +
        "and lower UNCLASSIFIED_WRITE_ROUTES_CAP."
    ).toEqual([]);
    expect(new Set(UNCLASSIFIED_WRITE_ROUTES).size).toBe(
      UNCLASSIFIED_WRITE_ROUTES.length
    );
    expect(UNCLASSIFIED_WRITE_ROUTES.length).toBeLessThanOrEqual(
      UNCLASSIFIED_WRITE_ROUTES_CAP
    );
  });

  it("every GATED_ELSEWHERE row is served, named by its handler, and its helper names a gate", async () => {
    const byKey = new Map(nonGet.map((r) => [keyOf(r), r]));
    const broken: string[] = [];
    for (const [key, row] of Object.entries(GATED_ELSEWHERE)) {
      const r = byKey.get(key);
      if (!r || !callOf(row.via).test(r.source)) {
        broken.push(`${key}: handler does not call ${row.via}`);
        continue;
      }
      const helper = (await row.load())[row.via];
      if (typeof helper !== "function" || !WRITE_GATE.test(String(helper)))
        broken.push(`${key}: ${row.via} names no write gate`);
    }
    expect(broken).toEqual([]);
  });

  it("self-check: the classifier sees gates, gated tRPC mutations and helpers", () => {
    const write = (source: string, path = "/zz-not-a-route"): ServedRoute => ({
      method: "POST",
      path,
      source,
    });
    expect(nonGetRouteClass(write("return c.json({ ok: true })"))).toBe(
      "unclassified"
    );
    expect(
      nonGetRouteClass(write("await (0, __vi_import_2__.canWrite)(p, t)"))
    ).toBe("gated");
    expect(
      nonGetRouteClass(write("await caller.entities.createEntity(input)"))
    ).toBe("gated-trpc");
    // An owner-wide or unknown tRPC mutation is not a gate.
    expect(
      nonGetRouteClass(write("await caller.channels.ensurePersonal(input)"))
    ).toBe("unclassified");
    expect(
      nonGetRouteClass(write("await caller.entities.noSuchProcedure(input)"))
    ).toBe("unclassified");
    // A GATED_ELSEWHERE row counts only while its handler calls the helper.
    expect(
      nonGetRouteClass(write("await createProjectGoverned(input)", "/projects"))
    ).toBe("gated-elsewhere");
    expect(
      nonGetRouteClass(write("await somethingElse(input)", "/projects"))
    ).toBe("unclassified");
    // A declared read is a read, whatever its source.
    expect(nonGetRouteClass(write("", "/packages/preflight"))).toBe("read");
  });
});

/** Is a served GET route classified by the fence (any bound, REFUSED too)? */
export function getRouteClassified(path: string): boolean {
  const p = concrete(path);
  return (
    GRANT_SAFE_REST_READS.some((r) => r.test(p)) ||
    GRANT_REST_GET_READS.some(([r]) => r.test(p)) ||
    GRANT_OWNER_WIDE_REST_DOORS.some((r) => r.test(p))
  );
}

describe("Hub REST GET routes are classified (derived from the served routes)", () => {
  const gets = servedRoutes().filter((r) => r.method === "GET");
  const keyOf = (r: ServedRoute) => `${r.method} ${r.path}`;
  const unclassified = gets
    .filter((r) => !getRouteClassified(r.path))
    .map(keyOf)
    .sort();

  it("sees the served GET routes, classified and not (non-vacuity)", () => {
    expect(gets.length).toBeGreaterThan(150);
    const keys = gets.map(keyOf);
    // The doors whose missing classification cost a finding are served and
    // now classified (3122ba42, cce86e6b, 7da9c21f, and the skill doors).
    for (const k of [
      "GET /capabilities/catalog",
      "GET /discover",
      "GET /memory",
      "GET /agent-skills/by-slug/:slug",
      "GET /cells",
    ]) {
      expect(keys, k).toContain(k);
      expect(unclassified, k).not.toContain(k);
    }
    expect(gets.length - unclassified.length).toBeGreaterThanOrEqual(50);
  });

  it("a new GET route is classified: a safe read, a declared read door, or owner-wide", () => {
    const baseline = new Set(UNCLASSIFIED_READ_ROUTES);
    expect(
      unclassified.filter((k) => !baseline.has(k)),
      "Classify the route in access/grant-door-fence.ts: GRANT_SAFE_REST_READS " +
        "when it reads only through a seam, else GRANT_REST_GET_READS with the " +
        "subjects it reads (READS), the narrowing its route does (NARROWED), the " +
        "person's own rows (PERSON), or REFUSED with the reason. Never add it to " +
        "the baseline."
    ).toEqual([]);
  });

  it("the read baseline only shrinks: no classified, gone or duplicate row, under its cap", () => {
    const now = new Set(unclassified);
    expect(
      UNCLASSIFIED_READ_ROUTES.filter((k) => !now.has(k)),
      "Classified or no longer served: remove it from grant-door-read-baseline.ts " +
        "and lower UNCLASSIFIED_READ_ROUTES_CAP."
    ).toEqual([]);
    expect(new Set(UNCLASSIFIED_READ_ROUTES).size).toBe(
      UNCLASSIFIED_READ_ROUTES.length
    );
    expect(UNCLASSIFIED_READ_ROUTES.length).toBeLessThanOrEqual(
      UNCLASSIFIED_READ_ROUTES_CAP
    );
  });

  it("self-check: the classifier tells a classified GET from an unclassified one", () => {
    expect(getRouteClassified("/entities/:id")).toBe(true); // safe read
    expect(getRouteClassified("/workspaces")).toBe(true); // declared READS
    expect(getRouteClassified("/errors/:requestId")).toBe(true); // REFUSED
    expect(getRouteClassified("/calendar/feed")).toBe(true); // owner-wide
    expect(getRouteClassified("/zz-not-a-route")).toBe(false);
    expect(getRouteClassified("/agent-skills/executable")).toBe(false);
  });
});
