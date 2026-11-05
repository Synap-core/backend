/**
 * WRITE-GATE TRIPWIRE
 *
 * The AI/Hub Protocol boundary has no single structural choke point: governance
 * (`checkPermissionOrPropose`) is enforced per-route at varying depths. The
 * standing risk (per the boundary map) is a NEW hub slice that writes the DB
 * directly and silently skips the gate.
 *
 * This tripwire catches exactly that, ROUTE BY ROUTE: every route handler (and
 * tRPC procedure) under routers/hub-protocol/ that performs a raw mutation
 * (db.insert/update/delete) MUST also route through the gate — either by
 * calling `checkPermissionOrPropose` itself, or by delegating to a gated
 * regular mutation via `getCaller()` (the sanctioned hub pattern).
 *
 * Until 2026-11-04 the unit was the FILE: one gated route cleared every other
 * route in it. backend#716 gated messaging's import-history, so messaging.ts
 * left the debt list while its account sync, account disconnect, channel
 * delete and mark-read still wrote without the gate (finding 6a6bcb5f). A
 * handler is now judged on its own body.
 *
 * Every raw-writing route is one of:
 *  - gated (the body, or a same-file helper it calls, names the gate);
 *  - ungated BY DESIGN: the handler carries a
 *    `// write-gate: ungated by design — <reason>` line AND is listed in
 *    UNGATED_BY_DESIGN_ROUTES (both, so neither a lone comment nor a lone
 *    list entry can clear a route);
 *  - DEBT, listed in KNOWN_UNGATED_ROUTES (may only shrink);
 *  - in a file the whole-file ALLOWLIST / KNOWN_UNGATED below still covers.
 *
 * NOT COVERED (measured, stated): a write through `tx.` or a repository /
 * service helper in another file is invisible (RAW_WRITE reads `db.` calls in
 * hub-protocol files only), so moving a write into a service hides it from
 * this scan; the gated helpers counted are same-file helpers only; and a
 * handler that calls the gate for one thing and writes raw for another is
 * cleared, as the file was before, but now only within that one handler.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HUB_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "routers",
  "hub-protocol"
);

// Hub files that legitimately write WITHOUT the governance gate. May only
// shrink; justify each. (The gate governs proposal-gated *entity content*; the
// stores below are deliberately outside it.)
const ALLOWLIST = new Set<string>([
  // Episodic/knowledge memory is an ungoverned fast store (intelligence-rules:
  // "memory always on"), not proposal-gated content. Writes/deletes are scoped
  // to the caller's own userId (see deleteMemoryRoute) — not a gate bypass.
  "rest/memory.ts",
  // Pod bootstrap/provisioning — runs at setup time (pre-auth /setup/*), before
  // any governance context exists.
  "rest/setup.ts",
  // Signal infrastructure only (fetch history / auto-links / subscriptions —
  // system state + telemetry); creates no proposal-gated entity content.
  "signals.ts",
  // Intelligence-service self-registration — writes the pod's service registry
  // (intelligenceServices), gated by the hub-protocol.write claim. Infra config,
  // not proposal-gated entity content.
  "services.ts",
  // AI-provider credentials — workspace-level provider config (apiKeys/baseUrls),
  // gated by hub-protocol.write + workspace membership (assertWorkspaceMember on
  // the read side). Infra config, not proposal-gated entity content.
  "rest/ai-providers.ts",
  // TODO: route through checkPermissionOrPropose — acknowledged debt below.
  // Agent skills are workspace-level config (install/uninstall), not user-facing
  // entity content. Low-risk but should be proposal-gated eventually.
  "rest/agent-skills.ts",
  // Cell instances are managed via a separate installation lifecycle (not
  // proposal-gated entity mutations). TODO: add governance gate.
  "rest/cells.ts",
  // Vault entries are workspace-level secrets infra, gated by hub-protocol.write
  // + workspace membership. Not proposal-gated entity content, but should be
  // reviewed for governance coverage eventually.
  "rest/vault.ts",
  // CP→pod OIDC federation push (POST /federation/oidc-config). NO principal
  // exists to govern: the route is in the hub auth skip-list and runs before
  // any user/agent identity — its only credential is a single-use assertion
  // signed by an APPROVED Control Plane issuer (`verifyTrustedIssuerJwt`: CP
  // scope set, aud = this pod, type `oidc-config-push`, jti once), whose OIDC
  // `issuer` must equal the signer and whose podOrigin must be this pod. It
  // writes ONE key of the `pod_settings` singleton (pod infra config, secret
  // via field-crypto), never entity content. `checkPermissionOrPropose` needs
  // a userId to evaluate, so routing it through the gate is not possible —
  // the issuer verification IS its authorization. Same class as setup.ts.
  "rest/federation.ts",
]);

// NOT justified — DEBT made visible on 2026-10-19 when RAW_WRITE learned to
// see multi-line chains. Each writes directly with no governance gate; listed
// so the tripwire is green for every OTHER file while these are fixed. May
// only shrink; never move an entry to ALLOWLIST without fixing or justifying.
// (Findings per route: lane/sec-webhooks sweep report.)
const KNOWN_UNGATED = new Set<string>([
  // Scope + owner-wide fence (GRANT_OWNER_WIDE_REST_DOORS) since 2026-10-19;
  // still no gate.
  "rest/webhooks.ts",
  // /agents/sync — owner-wide fence since 2026-10-19; no gate.
  "rest/agents.ts",
  // /channel-egress/:id/ack — floored on the /pending predicate since
  // 2026-10-19 (lane/sec-w3); no gate (no principal owns an outbox row).
  "rest/channel-egress.ts",
  // CP-JWT door (one-time consent code) — likely by design; unreviewed here.
  "rest/mcp-redeem.ts",
  // Grant-bounded (grantWriteDenial) but not via the gate.
  "rest/agent-users.ts",
  // tRPC hub routers: scope-checked; context.updateThreadContext is floored
  // on channel visibility since 2026-10-19 (lane/sec-w3) but not gated.
  "context.ts",
  "compacted-states.ts",
  "sessions.ts",
]);

// Route-level DEBT: handlers in otherwise-gated files that write raw without
// the gate, made visible on 2026-11-04 when the scan went per route (the file
// scan had cleared each of them through a gated neighbour). Unreviewed unless
// a note says more. May only shrink: fix the handler (gate it, or classify it
// by design with a reason in the code), then remove its line.
const KNOWN_UNGATED_ROUTES = new Map<string, string>([
  [
    "channels.ts procedure sendExternalMessage",
    "records the sent message and bumps the channel after the dispatch",
  ],
  [
    "channels.ts procedure triggerAI",
    "writes the prompt message into the channel before the agent turn",
  ],
  [
    "rest/calendar-feed.ts POST /calendar/feed",
    "the person's feed token (persistToken); owner-wide fenced door",
  ],
  [
    "rest/calendar-feed.ts POST /calendar/feed/rotate",
    "rotates the feed token (persistToken); owner-wide fenced door",
  ],
  [
    "rest/calendar-feed.ts DELETE /calendar/feed",
    "revokes the feed token; owner-wide fenced door",
  ],
  [
    "rest/calendar-feed.ts GET /calendar/feed/:token",
    "stamps the token's last use on a public read",
  ],
  ["rest/channels.ts POST /channels", "updates the channel row it resolved"],
  [
    "rest/discord.ts POST /discord/ingest",
    "bridge sensor; corrects a DM channel (correctDmChannel)",
  ],
  [
    "rest/discord.ts POST /discord/agent-turn",
    "bridge turn; corrects a DM channel (correctDmChannel)",
  ],
  [
    "rest/discord.ts POST /discord/reconcile-podwide",
    "re-points bridge channels pod-wide",
  ],
  ["rest/threads.ts POST /threads", "inserts the thread's channel row"],
  [
    "rest/threads.ts POST /threads/{threadId}/messages",
    "posts a chat message (outside the gate like every channel message)",
  ],
  [
    "rest/workspaces.ts POST /workspaces/provision-agent",
    "adds the provisioned agent as a workspace member",
  ],
]);

// Handlers that write raw WITHOUT the gate by design. Each also carries a
// `// write-gate: ungated by design — <reason>` line in its body, where the
// reason lives next to the code it excuses.
const UNGATED_BY_DESIGN_ROUTES = new Set<string>([
  "rest/messaging.ts GET /messaging/accounts",
  "rest/messaging.ts POST /messaging/accounts/sync",
  "rest/messaging.ts POST /messaging/channels/{channelId}/mark-read",
]);

/**
 * Tolerates whitespace around the dot: prettier breaks a long chain as
 * `db\n  .insert(table)`, and the previous `\bdb\.(insert|…)` never saw that
 * shape — it was blind to nine files (webhooks.ts among them, whose ungated
 * insert let a read-only key subscribe to every event of the owner) and to the
 * allowlisted memory.ts it claimed to watch. A self-check below pins the
 * multi-line sample. Still blind to `tx.` / repository writes.
 */
const RAW_WRITE = /\bdb\s*\.\s*(insert|update|delete)\s*\(/;
const GATE = /checkPermissionOrPropose|getCaller/;
const BY_DESIGN = /\/\/\s*write-gate: ungated by design\s*[—-]+\s*(.*)$/m;

/** A route registration, anywhere (the unit count must match it). */
const REGISTRATION_ANYWHERE =
  /\bapp\s*\.\s*(?:openapi|get|post|put|patch|delete|all)\s*\(/g;
/** Unit starts, read line by line. */
const ROUTE_START =
  /^\s*app\s*\.\s*(openapi|get|post|put|patch|delete|all)\s*\(/;
const PROCEDURE_START = /^\s*(\w+)\s*:\s*\w*[pP]rocedure\b/;
const DOC_START = /^\s*registerOpenApi\s*\(/;
/** A top-level function or const: a helper, judged through its callers. */
const HELPER_START =
  /^(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)|const\s+(\w+)\s*=)/;

type UnitKind = "module" | "route" | "doc" | "helper";
interface Unit {
  kind: UnitKind;
  name: string;
  text: string;
  /** Writes raw, itself or through a same-file helper it calls. */
  writes: boolean;
  /** Names the gate, itself or through a same-file helper it calls. */
  gated: boolean;
  /** For a helper: called by another unit (then its callers are judged). */
  called: boolean;
}

function routeName(
  src: string,
  lines: string[],
  i: number,
  verb: string
): string {
  const line = lines[i]!;
  if (verb === "openapi") {
    // Inline `createRoute({...})`, or a route const declared in the file.
    let text = lines.slice(i, i + 10).join("\n");
    const ref = /openapi\(\s*(\w+)\s*,/.exec(line);
    if (ref) {
      const at = src.search(
        new RegExp(`const\\s+${ref[1]}\\s*=\\s*createRoute\\(`)
      );
      if (at >= 0) text = src.slice(at, at + 800);
    }
    const method = /method:\s*["'](\w+)["']/.exec(text);
    const path = /path:\s*["'`]([^"'`]+)["'`]/.exec(text);
    if (method && path) return `${method[1]!.toUpperCase()} ${path[1]}`;
    return `openapi line ${i + 1}`;
  }
  const lit = /\(\s*["'`]([^"'`]+)["'`]/.exec(line);
  return lit ? `${verb.toUpperCase()} ${lit[1]}` : `${verb} line ${i + 1}`;
}

/** Split a hub file into its route handlers, procedures and helpers. */
function splitUnits(src: string): Unit[] {
  const lines = src.split("\n");
  const raw: Array<{ kind: UnitKind; name: string; lines: string[] }> = [];
  let cur: (typeof raw)[number] = {
    kind: "module",
    name: "(module)",
    lines: [],
  };
  lines.forEach((line, i) => {
    let next: { kind: UnitKind; name: string } | null = null;
    let m: RegExpExecArray | null;
    if ((m = ROUTE_START.exec(line)))
      next = { kind: "route", name: routeName(src, lines, i, m[1]!) };
    else if (DOC_START.test(line))
      next = { kind: "doc", name: `(openapi doc, line ${i + 1})` };
    else if ((m = PROCEDURE_START.exec(line)))
      next = { kind: "route", name: `procedure ${m[1]}` };
    else if ((m = HELPER_START.exec(line)))
      next = { kind: "helper", name: (m[1] ?? m[2])! };
    if (next) {
      raw.push(cur);
      cur = { ...next, lines: [] };
    }
    cur.lines.push(line);
  });
  raw.push(cur);

  const units: Unit[] = raw.map((u) => {
    const text = u.lines.join("\n");
    return {
      kind: u.kind,
      name: u.name,
      text,
      writes: RAW_WRITE.test(text),
      gated: GATE.test(text),
      called: false,
    };
  });
  const helpers = units.filter((u) => u.kind === "helper");
  const calls = (u: Unit, h: Unit) =>
    u !== h && new RegExp(`\\b${h.name}\\s*\\(`).test(u.text);
  // A same-file helper's write or gate counts for its callers (to a fixpoint).
  for (let changed = true; changed;) {
    changed = false;
    for (const u of units)
      for (const h of helpers) {
        if (!calls(u, h)) continue;
        if (h.writes && !u.writes) changed = u.writes = true;
        if (h.gated && !u.gated) changed = u.gated = true;
      }
  }
  for (const h of helpers) h.called = units.some((u) => calls(u, h));
  return units;
}

/** The units judged on their own: routes, the module, uncalled helpers. */
function judged(units: Unit[]): Unit[] {
  return units.filter(
    (u) => u.kind === "route" || u.kind === "module" || !u.called
  );
}

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".test.ts")
    )
      out.push(full);
  }
  return out;
}

const FILES = collect(HUB_DIR);
const idOf = (file: string) => file.split("/hub-protocol/")[1] ?? file;
const fileOf = (id: string) => FILES.find((f) => idOf(f) === id);

/** Every judged unit of every route-judged file (not whole-file listed). */
const UNITS = FILES.filter(
  (f) => !ALLOWLIST.has(idOf(f)) && !KNOWN_UNGATED.has(idOf(f))
).flatMap((file) =>
  judged(splitUnits(readFileSync(file, "utf8"))).map((u) => ({
    ...u,
    key: `${idOf(file)} ${u.name}`,
  }))
);
const unitByKey = new Map(UNITS.map((u) => [u.key, u]));

describe("write-gate tripwire — no hub raw write bypasses governance", () => {
  it("found hub-protocol files to scan", () => {
    expect(FILES.length).toBeGreaterThan(3);
  });

  it("RAW_WRITE sees the prettier-broken chain shape (self-check)", () => {
    expect(
      RAW_WRITE.test("await db\n        .insert(webhookSubscriptions)")
    ).toBe(true);
    expect(RAW_WRITE.test("db.update(x)")).toBe(true);
    expect(RAW_WRITE.test("db.query.x.findMany(")).toBe(false);
  });

  it("judges each handler on its own body (self-check on a sample file)", () => {
    const sample = [
      `import { db } from "x";`,
      `async function gatedHelper() { await checkPermissionOrPropose({}); }`,
      `export function registerX(app) {`,
      `  app.openapi(`,
      `    createRoute({ method: "post", path: "/x/gated" }),`,
      `    async (c) => { await checkPermissionOrPropose({}); await db.insert(t).values({}); }`,
      `  );`,
      `  app.post("/x/open", async (c) => {`,
      `    await db`,
      `      .delete(t);`,
      `  });`,
      `  app.patch("/x/helper", async (c) => { await gatedHelper(); await db.update(t); });`,
      `  app.delete("/x/marked", async (c) => {`,
      `    // write-gate: ungated by design — the caller's own flag, nothing to ask`,
      `    await db.update(t);`,
      `  });`,
      `}`,
    ].join("\n");
    const units = judged(splitUnits(sample));
    const open = units
      .filter((u) => u.writes && !u.gated)
      .map((u) => u.name)
      .sort();
    // The gated neighbour does NOT clear /x/open (the old file-granular hole).
    expect(open).toEqual(["DELETE /x/marked", "POST /x/open"]);
    expect(
      BY_DESIGN.exec(
        units.find((u) => u.name === "DELETE /x/marked")!.text
      )?.[1]
    ).toBe("the caller's own flag, nothing to ask");
    expect(units.map((u) => u.name)).toContain("POST /x/gated");
    expect(units.map((u) => u.name)).toContain("PATCH /x/helper");
  });

  it("every route registration starts its own unit (no handler merges into a neighbour)", () => {
    const merged: string[] = [];
    let routes = 0;
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      const units = splitUnits(src);
      const routeUnits = units.filter(
        (u) => u.kind === "route" && !u.name.startsWith("procedure ")
      ).length;
      routes += routeUnits;
      // Comments name `app.openapi(...)` in prose; code is what counts. A
      // block comment is stripped only where it opens a line: a path string
      // like "/setup/*" is not a comment.
      const code = src
        .replace(/^\s*\/\*[\s\S]*?\*\//gm, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const registrations = (code.match(REGISTRATION_ANYWHERE) ?? []).length;
      if (registrations !== routeUnits)
        merged.push(`${idOf(file)}: ${registrations} vs ${routeUnits}`);
      for (const u of units)
        if ((u.text.match(/\.mutation\s*\(/g) ?? []).length > 1)
          merged.push(`${idOf(file)} ${u.name}: two .mutation( handlers`);
    }
    expect(merged).toEqual([]);
    // Non-vacuity: the hub serves hundreds of REST routes.
    expect(routes).toBeGreaterThan(200);
  });

  it("splits messaging.ts into its routes (non-vacuity on the file that hid four)", () => {
    const names = UNITS.filter((u) =>
      u.key.startsWith("rest/messaging.ts ")
    ).map((u) => u.name);
    expect(names.length).toBeGreaterThan(14);
    expect(names).toEqual(
      expect.arrayContaining([
        "POST /messaging/accounts/sync",
        "DELETE /messaging/accounts/{accountId}",
        "DELETE /messaging/channels/{channelId}",
        "POST /messaging/channels/{channelId}/mark-read",
      ])
    );
  });

  it("judged unit names are unique per file (a list entry names one handler)", () => {
    const seen = new Set<string>();
    const dupes = UNITS.filter((u) => u.writes)
      .map((u) => u.key)
      .filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    expect(dupes).toEqual([]);
  });

  it("every hub handler with a raw db write also routes through the gate", () => {
    const violations = UNITS.filter(
      (u) =>
        u.writes &&
        !u.gated &&
        !KNOWN_UNGATED_ROUTES.has(u.key) &&
        !UNGATED_BY_DESIGN_ROUTES.has(u.key)
    ).map((u) => u.key);
    expect(
      violations,
      `Hub handler(s) writing the DB directly without checkPermissionOrPropose ` +
        `or getCaller — governance bypass risk:\n  ${violations.join("\n  ")}`
    ).toEqual([]);
  });

  it("an ungated-by-design handler is both marked in its code (with a reason) and listed", () => {
    const marked = UNITS.filter((u) => BY_DESIGN.test(u.text));
    for (const u of marked)
      expect(
        (BY_DESIGN.exec(u.text)?.[1] ?? "").trim().length,
        `${u.key}: the by-design line needs its reason`
      ).toBeGreaterThan(20);
    expect(marked.map((u) => u.key).sort()).toEqual(
      [...UNGATED_BY_DESIGN_ROUTES].sort()
    );
    // A listed handler that no longer writes raw, or now passes the gate, is
    // stale: remove it.
    const stale = [...UNGATED_BY_DESIGN_ROUTES].filter((k) => {
      const u = unitByKey.get(k);
      return !u || !u.writes || u.gated;
    });
    expect(stale).toEqual([]);
  });

  it("every KNOWN_UNGATED_ROUTES entry still writes raw and skips the gate", () => {
    // A fixed handler must leave the debt list (it may only shrink).
    const stale = [...KNOWN_UNGATED_ROUTES.keys()].filter((k) => {
      const u = unitByKey.get(k);
      return !u || !u.writes || u.gated || UNGATED_BY_DESIGN_ROUTES.has(k);
    });
    expect(stale).toEqual([]);
  });

  it("every KNOWN_UNGATED file still writes raw and skips the gate", () => {
    // A fixed file must leave the debt list (it may only shrink).
    const stale = [...KNOWN_UNGATED].filter((id) => {
      const file = fileOf(id);
      if (!file) return true;
      const src = readFileSync(file, "utf8");
      return !RAW_WRITE.test(src) || GATE.test(src);
    });
    expect(stale).toEqual([]);
  });

  it("every hub FILE with a raw write is judged route by route or listed whole", () => {
    // A raw-writing file with no gate anywhere is either listed whole, or each
    // of its raw-writing handlers is listed above (none is cleared silently).
    const unlisted = FILES.filter((f) => {
      const id = idOf(f);
      if (ALLOWLIST.has(id) || KNOWN_UNGATED.has(id)) return false;
      return RAW_WRITE.test(readFileSync(f, "utf8"));
    }).filter(
      (f) => !UNITS.some((u) => u.key.startsWith(`${idOf(f)} `) && u.writes)
    );
    // A file whose raw write sits in no judged unit (e.g. only inside a helper
    // a route calls) still has that write attributed to the route: so a
    // raw-writing file always shows at least one writing unit.
    expect(unlisted.map(idOf)).toEqual([]);
  });
});
