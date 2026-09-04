/**
 * READ-SCOPING TRIPWIRE
 *
 * Structural guarantee for the cross-workspace read-leak class (the defect that
 * existed in proposals.list / automations.* / mcp-servers.list / templates.list).
 *
 * It scans every tRPC router and flags any procedure that:
 *   - is built on a NON-workspace-gated builder (protectedProcedure / podProcedure
 *     — the builder does NOT add a membership check), AND
 *   - filters by a caller-supplied `input.workspaceId` inside a WHERE, AND
 *   - does NOT reach for any recognized scoping helper.
 *
 * `workspaceProcedure` / `workspaceMutationProcedure` / `podAdminProcedure` are
 * exempt — their middleware enforces membership at the builder level.
 *
 * A flagged procedure is a probable leak: any authenticated caller can pass any
 * workspace's id and read its rows. The allowlist below may only SHRINK — a new
 * violation fails CI. To clear one, route it through the access layer
 * (scopedDb / AccessContext) or userVisibleWhere / validateWorkspaceAccess.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as schema from "@synap/database/schema";
import { Table, getTableColumns, is } from "drizzle-orm";
// Importing the access barrel runs registry.ts's side effects, populating the
// visibility registry so `isRegistered` reflects every scoped table.
import { isRegistered } from "./index.js";

const ROUTERS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "routers"
);

// Builders whose middleware already enforces workspace membership.
const WORKSPACE_GATED_BUILDERS = [
  "workspaceProcedure",
  "workspaceMutationProcedure",
  "podAdminProcedure",
];

// Builders that do NOT gate workspace access — the body must self-scope.
// `scopedProcedure` is the builder for ALL 23 hub-protocol tRPC files
// (middleware/api-key-auth.ts:220 — `apiKeyProcedure.use(createScopedProcedure(...))`).
// It checks auth + required scopes only, NO workspace-membership check, so it is
// functionally identical to protectedProcedure/podProcedure — but its literal
// name never matched the extraction regex, leaving the whole Hub Protocol tRPC
// surface invisible to every check below. Recognizing it here (it appears as
// `name: scopedProcedure([...])`, still `name: builder`) brings those 23 files
// under the workspaceId-filter, by-id-read, listAll, and attacker-keyed checks
// with no new scanning logic.
const SELF_SCOPE_BUILDERS = [
  "protectedProcedure",
  "podProcedure",
  "scopedProcedure",
];

const ALL_BUILDERS = [
  ...WORKSPACE_GATED_BUILDERS,
  ...SELF_SCOPE_BUILDERS,
  "publicProcedure",
];

// Any of these in a procedure body means it scopes access deliberately — the
// access layer, a membership/role check, or the AI write gate.
const SCOPING_HELPERS = [
  "scopedDb",
  "AccessContext",
  "channelVisibilityWhere",
  "userVisibleWhere",
  // Thin entity/workspace wrappers OVER userVisibleWhere — equally legitimate
  // scoping (the entities/views routers self-scope through these).
  "entityVisibleWhere",
  "entityLensWhere",
  "workspaceLensWhere",
  "validateWorkspaceAccess",
  "verifyPermission",
  "getWorkspaceRole",
  "requireAdminRole",
  "getUserWorkspaceIds",
  "getUserMemberWorkspaceIds",
  "getUserAccessibleWorkspaceIds",
  "getWorkspaceMembership",
  "assertWorkspaceMember",
  "assertWorkspaceWrite",
  "checkPermissionOrPropose",
  // Project axis (project-centric-scope) — a procedure routing through the
  // unified seam or the project predicates is deliberately scoped.
  "accessScopeWhere",
  "projectMemberWhere",
  "projectLensWhere",
  "projectLens",
  // The canonical ScopeFilter door (utils/scope-filter.ts): a procedure that
  // resolves its lens via resolveScope() is floor-first by construction — the
  // floor is applied in the body, the lens only narrows. Recognized so the
  // collapsed one-door procedures aren't false-flagged.
  "resolveScope",
  "ScopeFilterShape",
  // Domain floor helpers that wrap a canonical predicate — recognized so the
  // reads that route through them aren't false-flagged (each is a sound owner/
  // visibility floor, verified at its definition):
  //   graphEntityFloor  (graph.ts) → delegates to accessScopeWhere on entities;
  //   visibleSkillsWhere (services/skills/visibility.ts) → user+workspace skill
  //     visibility SQL, the floor skills.list/get already apply.
  "graphEntityFloor",
  "visibleSkillsWhere",
  //   systemMapEntityScope (graph.ts) → module-top wrapper around
  //     accessScopeWhere, paired with assertSystemMapWorkspaceLensAccess's
  //     FORBIDDEN throw — the floor getSystemMapKindDrilldown (and the other
  //     system-map procedures) already apply.
  "systemMapEntityScope",
  // The proposal-visibility SSOT (utils/proposal-visibility.ts): loads the
  // proposal by id then throws unless the caller is an editor+ member (workspace
  // proposal) or the proposer (pod-wide). The floor proposals.get/source now
  // route through — recognized so the extraction from the old inline membership
  // check isn't false-flagged.
  "assertProposalVisibleTo",
  // The proposal LIST editor+ gate (routers/proposals.ts): `list` and `groups`
  // carried byte-identical inline `workspaceMembers.findFirst` + role checks,
  // which this scanner cleared via INLINE_MEMBERSHIP_FLOOR. The two copies were
  // consolidated into one helper, so the coverage MOVES here rather than
  // disappearing — same floor (member row required, role in owner/admin/editor,
  // FORBIDDEN otherwise), one place it can drift.
  "assertProposalWorkspaceRead",
];

// Per-user scoping: the row's userId pinned to the caller — `eq(t.userId,
// ctx.userId)` / `requireUserId` / `authUserId`. Precise (not a bare "ctx.userId"
// substring) so a procedure that merely *mentions* ctx.userId for logging/audit
// while leaving an input.workspaceId read unguarded is NOT falsely cleared.
const USER_SCOPE_PATTERN =
  /userId\s*,\s*(ctx\.userId|requireUserId|authUserId)/;

// A row-ownership floor applied OUTSIDE a WHERE: a manual `row.userId ===/!==
// ctx.userId` guard after a by-id load (the documents/whiteboards version-preview
// pattern — the version row has no owner of its own, so ownership is checked on
// its parent). Recognized as a legitimate floor so those reads aren't flagged.
const OWNER_COMPARE_PATTERN =
  /\.userId\s*(===|!==)\s*(ctx\.userId|userId)\b|\b(ctx\.userId|userId)\s*(===|!==)\s*[a-zA-Z0-9_]*\.userId/;

// Export names of every schema table carrying a `userId` owner column, resolved
// by introspecting the live schema (stays correct as tables are added). These are
// the tables whose rows belong to a single user — a by-id read of one MUST floor
// by that owner, or another user's row leaks on an id guess.
const USER_DATA_TABLES: string[] = Object.entries(schema)
  .filter(([, v]) => is(v, Table))
  .filter(([, v]) => "userId" in getTableColumns(v as Table))
  .map(([name]) => name);

// Export names of every table registered in the visibility registry
// (access/registry.ts). A by-id read of ANY of these — not only the
// userId-bearing ones — must apply a scope floor (owner column, a recognized
// scoping helper, or a membership check); otherwise a caller passing another
// workspace's row id reads it. Derived from the LIVE registry so it stays
// correct as tables are registered.
const REGISTERED_SCOPED_TABLES: string[] = Object.entries(schema)
  .filter(([, v]) => is(v, Table))
  .filter(([, v]) => isRegistered(v as object))
  .map(([name]) => name);

// The by-id read scan covers the UNION: userId-bearing tables (owner leak) AND
// every registered scoped table (cross-workspace leak). Widening the set only
// adds detection; the allowlist is still shrink-only.
const BY_ID_SCOPED_TABLES: string[] = Array.from(
  new Set([...USER_DATA_TABLES, ...REGISTERED_SCOPED_TABLES])
);

// An unfloored by-id read of a scoped table, in EITHER of two shapes:
//   - `db.query.<t>.findFirst({ where: eq(<t>.id, …) })` — a point lookup, or
//   - `db.query.<t>.findMany({ where: … inArray(<t>.id, …) })` — id-list
//     hydration (the getThreadContext-style linked-entity/document fetch).
// Both leak a scoped row when the id/id-list comes from the caller with no floor.
// A read that filters by the table's OWN `userId` column is already owner-floored
// and cleared here; every other clear (helper / owner-compare / membership) is
// applied by the caller. Returns the matched table name, or undefined.
function matchedScopedByIdRead(body: string): string | undefined {
  for (const t of BY_ID_SCOPED_TABLES) {
    const byIdFindFirst =
      new RegExp(`db\\.query\\.${t}\\.findFirst\\(`).test(body) &&
      new RegExp(`\\b${t}\\.id\\b`).test(body);
    const byIdInArray =
      new RegExp(`db\\.query\\.${t}\\.findMany\\(`).test(body) &&
      new RegExp(`inArray\\(\\s*${t}\\.id\\b`).test(body);
    if (!byIdFindFirst && !byIdInArray) continue;
    // Floored by its own owner column — safe by construction.
    if (new RegExp(`\\b${t}\\.userId\\b`).test(body)) continue;
    return t;
  }
  return undefined;
}

// ── Hono handler surface (hub-protocol/rest/*.ts + any other Hono router) ──
// The Hono REST family registers handlers via `app.get/post/patch/delete(…)`
// and `app.openapi(createRoute({…}), handler)` — NO `name: builder` marker, so
// extractProcedures() returns zero for these ~90 files, leaving the entire REST
// half of the Hub Protocol invisible. This parallel extractor keys on route
// registrations instead, mirroring extractProcedures' "slice to the next mark"
// heuristic (same decoy-string tradeoff the tRPC scanner already accepts).
interface HonoHandler {
  file: string;
  id: string; // "<method> <path>" — stable + human-readable for the allowlist
  method: string; // get | post | patch | delete | put
  body: string;
}

function extractHonoHandlers(file: string, src: string): HonoHandler[] {
  // Pre-pass: resolve `app.openapi(<routeConst>, handler)` methods. The consts
  // are `const <name> = createRoute({ method: "…", path: "…" })` in the same
  // file; method/path sit at the TOP of the literal (before the nested
  // `responses: {…}` braces), so a fixed-width window read is robust against the
  // nesting a balanced-brace parse would need.
  const routeConst = new Map<string, { method: string; path: string }>();
  const constRe = /(?:const|let)\s+(\w+)\s*=\s*createRoute\(\{/g;
  let cm: RegExpExecArray | null;
  while ((cm = constRe.exec(src))) {
    const win = src.slice(cm.index, cm.index + 400);
    const method = win.match(/method:\s*["'](\w+)["']/)?.[1];
    const path = win.match(/path:\s*["'`]([^"'`]+)["'`]/)?.[1];
    if (method) routeConst.set(cm[1]!, { method, path: path ?? "" });
  }

  const markRe = /app\.(get|post|patch|delete|put|openapi)\(/g;
  const marks: { index: number; verb: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = markRe.exec(src))) marks.push({ index: m.index, verb: m[1]! });

  return marks.map((mark, i) => {
    const body = src.slice(mark.index, marks[i + 1]?.index ?? src.length);
    let method = mark.verb;
    let path = "";
    if (mark.verb === "openapi") {
      const constMatch = body.match(/^app\.openapi\(\s*([A-Za-z_]\w*)\s*,/);
      if (constMatch) {
        // Route-const form — resolve method/path from the pre-pass map. Unknown
        // (imported/unresolved) defaults to "get" so it is SCANNED as a read
        // rather than silently skipped (over-inclusion → allowlist, not a gap).
        const resolved = routeConst.get(constMatch[1]!);
        method = resolved?.method ?? "get";
        path = resolved?.path || `openapi:${constMatch[1]!}`;
      } else {
        // Inline `createRoute({ method, path })` — first occurrences in the slice
        // are the route literal's (it precedes the handler body textually).
        method = body.match(/method:\s*["'](\w+)["']/)?.[1] ?? "get";
        path = body.match(/path:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "";
      }
    } else {
      path = body.match(/^app\.\w+\(\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "";
    }
    return { file, id: `${method} ${path}`.trim(), method, body };
  });
}

// Hono-specific scoping clears, on top of SCOPING_HELPERS. Several floored Hono
// routes hand-roll the membership check inline (workspaces.ts governance/home/
// eve-routing) or reach for helpers the tRPC surface doesn't use.
const HONO_CLEARS = [
  ...SCOPING_HELPERS,
  "verifyWorkspaceReadAccess",
  "getConfinedWorkspace",
  // A getCaller(c) delegate hands off to a now-scanned scopedProcedure (this is
  // only safe BECAUSE the scopedProcedure recognition above ships in the same
  // change — otherwise it would false-clear a delegate to an unscanned builder).
  "getCaller(c",
];

// An inline membership floor: `workspaceMembers.findFirst` co-occurring with an
// `eq(<x>.userId, <caller-id>)` — the hand-rolled form several Hono routes use
// instead of a named helper.
const INLINE_MEMBERSHIP =
  /workspaceMembers\.findFirst[\s\S]*?\.userId,\s*(userId|ctx\.userId|authUserId)\b|\.userId,\s*(userId|ctx\.userId|authUserId)\b[\s\S]*?workspaceMembers\.findFirst/;

// Procedures the static scan can't see are safe (the scoping lives in a
// repository/helper call, not an inline WHERE). Justify each; may only shrink.
const ALLOWLIST = new Set<string>([
  // User-scoped inside eventRepository.searchEvents({ userId }) — the workspaceId
  // is only a narrowing filter on already-user-scoped events.
  "subscriptions.ts::listAll",
  // events has NO workspace_id column (workspace lives in JSONB data->>'workspaceId')
  // so it cannot use scopedDb. The read is safe by construction: searchEvents
  // ALWAYS floors by userId, and input.workspaceId is membership-checked against
  // workspaceMembers before the read (events.ts:356-369). See WORKSPACE-LENS-
  // CONSOLIDATION-PLAN.md §P3 (events → justified allowlist, not scopedDb).
  "events.ts::aggregateTimeSeries",
  // views.list floors every read with viewVisibleWhere(ctx.userId) — the same
  // userVisibleWhere-based predicate entities.list uses (isNull-personal OR
  // member/owned/pod-visible workspaces) — plus an optional project-lens narrow.
  // Correctly scoped, hand-rolled rather than scopedDb (its conditional
  // project/profile filters don't fit a uniform rule), same as the entities path.
  "views.ts::list",
  // agentConfigs.get: userId-pinned single-object read. The query floors on the
  // caller's own id (`eq(agentConfigs.userId, requireUserId(ctx.userId))`), so a
  // caller can only ever read THEIR OWN config — no cross-user exposure. The
  // input.workspaceId is part of the (user, workspace, agentType) composite KEY,
  // not a visibility lens (see the source comment), so it narrows the caller's
  // own rows rather than crossing a boundary. The scan misses the floor only
  // because the userId is bound to a local before the eq(), not written inline.
  "agent-configs.ts::get",
  // W1: surfaced by bringing scopedProcedure hub files under this check. Reads
  // widgetDefinitions where `isNull(workspaceId) OR eq(workspaceId,
  // input.workspaceId)` with NO membership check on input.workspaceId — any hub
  // caller can pass another workspace's id and read its widget-def schema (UI
  // schema, not user data — low severity, but a genuine cross-workspace read).
  // Tracked debt for the floor-consolidation wave; floor via a membership check.
  "hub-protocol/widget-definitions.ts::listWidgetDefs",
]);

function collectRouterFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectRouterFiles(full));
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

interface Procedure {
  file: string;
  name: string;
  builder: string;
  body: string;
}

/** Split a router file into per-procedure chunks (name: builder … next name:). */
function extractProcedures(file: string, src: string): Procedure[] {
  const re = new RegExp(
    `(\\b[a-zA-Z0-9_]+)\\s*:\\s*(${ALL_BUILDERS.join("|")})\\b`,
    "g"
  );
  const marks: { name: string; builder: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    marks.push({ name: m[1]!, builder: m[2]!, index: m.index });
  }
  return marks.map((mark, i) => ({
    file,
    name: mark.name,
    builder: mark.builder,
    body: src.slice(mark.index, marks[i + 1]?.index ?? src.length),
  }));
}

const FILES = collectRouterFiles(ROUTERS_DIR);

describe("read-scoping tripwire — no unguarded workspace-filtered reads", () => {
  it("found router files to scan", () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it("every self-scoping READ that filters by input.workspaceId uses a scoping helper", () => {
    const violations: string[] = [];

    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const proc of extractProcedures(file, src)) {
        if (!SELF_SCOPE_BUILDERS.includes(proc.builder)) continue;
        // Reads only — the validated leak class. Writes are gated by role
        // checks / the AI write gate, a separate concern.
        const isRead = /\.query\(/.test(proc.body);
        if (!isRead) continue;

        const usesWorkspaceInput = /input\??\.workspaceId/.test(proc.body);
        const hasWhere = /\.where\(|where:\s/.test(proc.body);
        if (!usesWorkspaceInput || !hasWhere) continue;

        // Heuristic guardrail, not a proof: it clears a procedure if ANY
        // recognized scoping signal appears in its body. It can't see that a
        // signal guards a DIFFERENT branch than the workspace filter — so it
        // catches the egregious "no scoping at all" leaks (the real-world class),
        // not partial-scoping. Pair with code review for the latter.
        const hasHelper = SCOPING_HELPERS.some((h) => proc.body.includes(h));
        const hasUserScope = USER_SCOPE_PATTERN.test(proc.body);
        if (hasHelper || hasUserScope) continue;

        const id = `${file.split("/routers/")[1]}::${proc.name}`;
        if (!ALLOWLIST.has(id)) violations.push(id);
      }
    }

    expect(
      violations,
      `Unguarded workspace-filtered read(s) — route through the access layer ` +
        `(scopedDb/AccessContext) or userVisibleWhere:\n  ${violations.join("\n  ")}`
    ).toEqual([]);
  });

  // WIDENED READ-LEAK CLASS: an unfloored by-id read of a scoped table. The scan
  // above only catches reads filtered by `input.workspaceId`; it misses a raw
  // point lookup `db.query.<t>.findFirst({ where: eq(t.id, input.id) })` on a
  // table that applies NO floor — any authenticated caller passing another
  // user's / workspace's row id reads it. Now covers EVERY registered scoped
  // table (not just userId-bearing ones), so a bare by-id read of a
  // workspace-scoped table (channels, automations, proposals…) is flagged too.
  // A read is cleared if it floors ownership (own-userId WHERE, a manual
  // `row.userId === ctx.userId` guard) or reaches for a recognized scoping
  // helper / membership check (SCOPING_HELPERS — scopedDb, workspaceLensWhere,
  // assertWorkspaceMember, validateWorkspaceAccess…). The allowlist records
  // PRE-EXISTING offenders to floor later; it may only SHRINK.
  const USER_FLOOR_ALLOWLIST = new Set<string>([
    // Returns a skill row fetched by id with NO owner floor — `skills` carries a
    // `userId`, so a caller passing another user's skillId reads its row (only the
    // linked-tools lookup below is user-scoped, not the skill row itself). Real
    // gap: floor the skill read by owner, or confirm skills are pod-shared and
    // register the table via scopedDb. Pre-existing; surfaced by this tripwire.
    "skills.ts::getRequiredTools",
    // TODO(access-convergence): REAL gap surfaced by widening this scan to all
    // registered scoped tables. `db.query.mcpServers.findFirst({ where:
    // eq(mcpServers.id, input.id) })` loads an MCP server by id with NO workspace
    // floor — any authenticated caller can pass another workspace's serverId and
    // read its slug/config (then proxy a tool-list to its IS). Floor it via
    // scopedDb(mcpServers) or a membership check on the loaded server.workspaceId.
    "mcp-servers.ts::listTools",
  ]);

  it("every by-id read of a registered scoped table applies a scope floor", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const proc of extractProcedures(file, src)) {
        if (!SELF_SCOPE_BUILDERS.includes(proc.builder)) continue;
        if (!/\.query\(/.test(proc.body)) continue;

        // A by-id point lookup OR an inArray id-list hydration on a scoped table
        // that does NOT filter by that table's own userId column (unfloored).
        const table = matchedScopedByIdRead(proc.body);
        if (!table) continue;

        // Cleared if ownership is enforced by ANY recognized signal (same
        // heuristic guardrail as the scan above — see its note on partial scoping).
        const hasHelper = SCOPING_HELPERS.some((h) => proc.body.includes(h));
        const hasUserScope = USER_SCOPE_PATTERN.test(proc.body);
        const hasOwnerCompare = OWNER_COMPARE_PATTERN.test(proc.body);
        if (hasHelper || hasUserScope || hasOwnerCompare) continue;

        const id = `${file.split("/routers/")[1]}::${proc.name}`;
        if (!USER_FLOOR_ALLOWLIST.has(id)) violations.push(`${id} [${table}]`);
      }
    }

    expect(
      violations,
      `Unfloored by-id read(s) of a registered scoped table — floor by the owner ` +
        `(eq(t.userId, ctx.userId) / a row.userId===ctx.userId guard) or route ` +
        `through the access layer (scopedDb / a membership check):\n  ${violations.join(
          "\n  "
        )}`
    ).toEqual([]);
  });

  // The cross-workspace WRITE-leak class: a mutation that loads a row to mutate
  // via `findFirst(and(eq(t.id, input.id), input.workspaceId ? eq(...) : ...))`.
  // The `input.workspaceId` term reads like a scope guard but is attacker-
  // supplied, so it gates nothing. The fix is to load by id ALONE and gate on
  // the loaded row's workspace (assertWorkspaceWrite). This guards the exact
  // pattern just removed from automations.* — it must not come back.
  const ATTACKER_KEYED =
    /input\??\.workspaceId\s*\?\s*eq\([^)]*\.workspaceId,\s*input\??\.workspaceId/;

  // THE ONE-DOOR LOCK. The list/listAll two-door split was collapsed: every
  // user-data table now has ONE floor-first scope-aware `.list` door (no lens =
  // the user floor; a workspace/project lens only narrows). A `.listAll` is the
  // re-expansion of that split — the exact thing we removed. This allowlist may
  // only SHRINK; a NEW `listAll:` procedure fails CI. To add a reader, give it a
  // scope-aware `.list` (ScopeFilter + resolveScope), never a second door.
  const LISTALL_ALLOWLIST = new Set<string>([
    // events has NO workspace_id column (workspace lives in JSONB), so it can't
    // use the unified seam; searchEvents always floors by userId and the
    // workspaceId is membership-checked. Justified single door named listAll.
    "subscriptions.ts::listAll",
    // governance-rules `listAll` is the DELIBERATE "across every workspace the
    // caller can see" door (pod ∪ all visible workspaces) — a different shape
    // than `.list`'s single-workspace lens, not a re-expansion of it. Properly
    // floored by `userVisibleWhere(governanceRules.workspaceId, ctx.userId)`,
    // same predicate `.list` uses. Justified single door named listAll.
    "governance-rules.ts::listAll",
  ]);

  it("no NEW listAll procedure (the two-door split may only collapse, never re-expand)", () => {
    const offenders: string[] = [];
    const listAllMark = /\blistAll\s*:\s*(workspace|protected|pod|public)/;
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      // Match an exact `listAll:` PROCEDURE (followed by a builder), not
      // `listAllAgents:` / `listAllGrants:` (distinct, non-collapsed names).
      if (!listAllMark.test(src)) continue;
      for (const proc of extractProcedures(file, src)) {
        if (proc.name !== "listAll") continue;
        const id = `${file.split("/routers/")[1]}::${proc.name}`;
        if (!LISTALL_ALLOWLIST.has(id)) offenders.push(id);
      }
    }
    expect(
      offenders,
      `New \`listAll\` door(s) — the list/listAll split was collapsed to ONE ` +
        `floor-first \`.list\` door. Give the reader a scope-aware \`.list\` ` +
        `(ScopeFilter + resolveScope), not a second door:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });

  it("no mutation uses the attacker-keyed workspace-filter anti-pattern", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const proc of extractProcedures(file, src)) {
        if (!SELF_SCOPE_BUILDERS.includes(proc.builder)) continue;
        if (!/\.mutation\(/.test(proc.body)) continue;
        if (ATTACKER_KEYED.test(proc.body)) {
          violations.push(`${file.split("/routers/")[1]}::${proc.name}`);
        }
      }
    }
    expect(
      violations,
      `Mutation(s) gating on a caller-supplied workspaceId (gates nothing) — ` +
        `load by id alone and assertWorkspaceWrite on the row's workspace:\n  ${violations.join(
          "\n  "
        )}`
    ).toEqual([]);
  });

  // ── HONO REST SURFACE: by-id / inArray reads of a scoped table ──
  // The by-id read leak class (getThreadContext-style) also lives in the Hono
  // handlers, which extractProcedures can't see. This mirrors the tRPC by-id
  // check above — same BY_ID_SCOPED_TABLES, same clears — but over GET handler
  // bodies (reads only, the analogue of the tRPC scan's `.query`-only filter).
  // db.select().from(<t>).where(eq(<t>.id,…)) is NOT covered (the tRPC check
  // doesn't cover it either) — acknowledged non-coverage, not a silent gap.
  const HONO_BYID_ALLOWLIST = new Set<string>([
    // KNOWN LEAK (discovery §2c/2d). GET /messaging/conversations entity-mode
    // reads channels by contextObjectId with no visibility floor; linked-unread
    // reads ALL entity-linked channels pod-wide. Bounded metadata leak
    // (participantName/provider/preview). Fix: channelVisibilityWhere(userId) on
    // the channels.findMany, same as sibling GET /messaging/channels already does.
    "messaging.ts::get /messaging/conversations",
    "messaging.ts::get /messaging/linked-unread",
    // KNOWN, BOUNDED. GET /setup/agent/pending/:keyId reads an apiKeys row by
    // the path :keyId with no owner floor and returns ONLY its status
    // (active/pending/rejected). Reachable during the `synap connect` handshake
    // before the key is active (so the usual owner floor can't apply yet); any
    // authenticated caller can poll another key's status by guessing its UUID.
    // Status-enum only, no secret/scope material. Tracked debt; floor by binding
    // the poll to the authenticated key's own id once the handshake allows it.
    "hub-protocol/rest/setup.ts::get /setup/agent/pending/:keyId",
  ]);

  it("every Hono GET handler by-id/inArray read of a registered scoped table applies a scope floor", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const h of extractHonoHandlers(file, src)) {
        if (h.method !== "get") continue; // reads only, mirrors the tRPC .query filter
        const table = matchedScopedByIdRead(h.body);
        if (!table) continue;

        const hasHelper = HONO_CLEARS.some((c) => h.body.includes(c));
        const hasUserScope = USER_SCOPE_PATTERN.test(h.body);
        const hasOwnerCompare = OWNER_COMPARE_PATTERN.test(h.body);
        const hasMembership = INLINE_MEMBERSHIP.test(h.body);
        if (hasHelper || hasUserScope || hasOwnerCompare || hasMembership)
          continue;

        const id = `${file.split("/routers/")[1]}::${h.id}`;
        if (!HONO_BYID_ALLOWLIST.has(id)) violations.push(`${id} [${table}]`);
      }
    }
    expect(
      violations,
      `Unfloored by-id/inArray read(s) of a registered scoped table in a Hono GET ` +
        `handler — floor with channelVisibilityWhere / verifyWorkspaceReadAccess / ` +
        `a membership check, mirroring GET /messaging/channels:\n  ${violations.join(
          "\n  "
        )}`
    ).toEqual([]);
  });

  // ── CALLER-SUPPLIED IDENTITY AS THE ACTING IDENTITY (the W0 critical shape) ──
  // A procedure/handler that builds a caller/access context AS a caller-supplied
  // identity — `createHubProtocolCallerContext(input.userId, …)` /
  // `.createCaller(input.userId)` / a `c.req.param/query(...)` value — rather than
  // as the authenticated caller (ctx.userId / c.get("userId")). This is exactly
  // getUserContext's cross-user leak: any hub-protocol.read key could pass any
  // userId and be impersonated. Neither the workspaceId-filter nor the by-id-read
  // check catches it (no input.workspaceId WHERE; the identity is re-derived, not
  // read by id). CLEARED when an identity guard (`=== / !== ctx.userId` /
  // `authUserId`, or a membership lookup) appears in the body — the same
  // any-signal-in-body heuristic the other checks use. The W0-fixed getUserContext
  // (`if (input.userId !== ctx.userId) throw`) is cleared by that guard and is NOT
  // allowlisted — a positive test that this check doesn't false-flag a guarded
  // call; getThreadContext passes it too (its first arg is the derived local
  // `threadUserId`, not `input.threadId`). This allowlist may only SHRINK.
  const IMPERSONATION =
    /createHubProtocolCallerContext\(\s*(?:input\??\.[A-Za-z0-9_]+|c\.req\.(?:param|query)\([^)]*\))|\.createCaller\(\s*(?:input\??\.[A-Za-z0-9_]+|c\.req\.(?:param|query)\([^)]*\))/;
  const IDENTITY_GUARD =
    /(?:===|!==)\s*(?:ctx\.userId|authUserId)\b|\b(?:ctx\.userId|authUserId)\s*(?:===|!==)|assertMayActAs\(|getWorkspaceMembership\b|assertWorkspaceMember\b|workspaceMembers\.findFirst/;

  // EMPTIED by W0.5 (hub-protocol delegation impersonation fix). Every
  // hub-protocol tRPC procedure that builds a caller context from a
  // caller-supplied identity now calls `assertMayActAs(ctx, <identity>)`
  // (hub-protocol/guard.ts) — strict `identity === ctx.userId`, NO service
  // exception (a `service` key is self-mintable on this pod via /setup/service
  // Path 4, so keyType grants no impersonation right). IDENTITY_GUARD recognizes
  // that call, so all former entries clear without an allowlist. Shrink-only: a
  // NEW unguarded impersonation fails CI. Add an entry ONLY if a site genuinely
  // cannot use the helper, with a justification — aim for zero.
  const IMPERSONATION_ALLOWLIST = new Set<string>([]);

  it("no unguarded caller-supplied identity is used as the acting identity", () => {
    const violations: string[] = [];
    const units: { id: string; body: string }[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      const rel = file.split("/routers/")[1];
      for (const proc of extractProcedures(file, src)) {
        units.push({ id: `${rel}::${proc.name}`, body: proc.body });
      }
      for (const h of extractHonoHandlers(file, src)) {
        units.push({ id: `${rel}::${h.id}`, body: h.body });
      }
    }
    for (const u of units) {
      if (!IMPERSONATION.test(u.body)) continue;
      if (IDENTITY_GUARD.test(u.body)) continue;
      if (!IMPERSONATION_ALLOWLIST.has(u.id)) violations.push(u.id);
    }
    expect(
      violations,
      `Caller-supplied identity used as the acting identity with no guard — ` +
        `require input.userId === ctx.userId, or gate impersonation on an ` +
        `explicit operator/service credential:\n  ${violations.join("\n  ")}`
    ).toEqual([]);
  });

  it("check (d) positive control: the W0-guarded getUserContext/getThreadContext pass without allowlisting", () => {
    const contextFile = FILES.find((f) =>
      f.endsWith("hub-protocol/context.ts")
    );
    expect(contextFile, "context.ts must be scanned").toBeTruthy();
    const procs = extractProcedures(
      contextFile!,
      readFileSync(contextFile!, "utf8")
    );
    const getUserContext = procs.find((p) => p.name === "getUserContext");
    const getThreadContext = procs.find((p) => p.name === "getThreadContext");
    // scopedProcedure recognition (check a) must make these visible at all.
    expect(getUserContext, "getUserContext extracted").toBeTruthy();
    expect(getThreadContext, "getThreadContext extracted").toBeTruthy();

    // getUserContext DOES pass a caller-supplied `input.userId` as the acting
    // identity — the impersonation pattern MUST match it (the check sees the
    // shape) — and its `input.userId !== ctx.userId` throw MUST clear it. If a
    // future edit drops that guard, IMPERSONATION stays true / IDENTITY_GUARD
    // goes false and the check flags it (it is not allowlisted).
    expect(IMPERSONATION.test(getUserContext!.body)).toBe(true);
    expect(IDENTITY_GUARD.test(getUserContext!.body)).toBe(true);
    expect(
      IMPERSONATION_ALLOWLIST.has("hub-protocol/context.ts::getUserContext")
    ).toBe(false);
    expect(
      IMPERSONATION_ALLOWLIST.has("hub-protocol/context.ts::getThreadContext")
    ).toBe(false);

    // getThreadContext's acting identity is the derived local `threadUserId`
    // (from a channelVisibilityWhere-floored lookup), never a raw input value —
    // the impersonation pattern doesn't match it, so it is clean by construction.
    const threadClean =
      !IMPERSONATION.test(getThreadContext!.body) ||
      IDENTITY_GUARD.test(getThreadContext!.body);
    expect(threadClean).toBe(true);
  });

  // ── THE 2ND IMPERSONATION DOOR (W0.6) ──
  // The IMPERSONATION check above only sees the delegation door
  // (`createHubProtocolCallerContext(input.…)` / `.createCaller(input.…)`). But a
  // caller-supplied identity re-derives the ACTING identity through THREE other
  // sinks the same way: `checkPermissionOrPropose({ userId: input.… })` (the
  // permission owner + proposal owner), `AccessContext.agent({ userId: input.… })`
  // (the read floor identity), and direct service writes keyed on input.userId
  // (`resolveOrCreateChannel` / `setProfileRenderer` / `createAndLinkPropertyDef`
  // / the `triggerAutoRespond` message-turn). On the hub-protocol (BYOA) surface
  // `ctx.userId` is the key owner and any user can self-mint a `hub-protocol.*`
  // PAT, so an unguarded `userId: input.…` into any of these = cross-tenant
  // read/write. Every such site MUST carry a preceding `assertMayActAs(ctx, …)`
  // (recognized by IDENTITY_GUARD). Same any-signal-in-body heuristic as the
  // checks above (it can't prove the guard dominates the sink — pair with review).
  // Cross-file delegation (bindChannel → proposeChannelBind, a util) is NOT
  // visible here — acknowledged non-coverage; those procedures are guarded at the
  // door. Allowlist seeded EMPTY: every in-file site is guarded. Shrink-only.
  // SINK list is STRUCTURAL, not just a 6-name allowlist: besides the known
  // service writes it also matches ANY `AccessContext.<method>(` (a new floor
  // constructor) and any raw `.values(`/`.set(` DB write — so a future write
  // helper keyed on `userId: input.…` is caught without editing this list.
  const SECOND_DOOR_IDENTITY = /\buserId:\s*input\??\.[A-Za-z0-9_]+/;
  const SECOND_DOOR_SINK =
    /checkPermissionOrPropose\(|AccessContext\.\w+\(|resolveOrCreateChannel\(|setProfileRenderer\(|createAndLinkPropertyDef\(|triggerAutoRespond\(|\.values\(|\.set\(/;
  const SECOND_DOOR_ALLOWLIST = new Set<string>([]);

  it("no unguarded input.userId reaches a governance/write acting-identity sink (the W0.6 2nd door)", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      // The external-agent (BYOA) door — ctx.userId is the key owner and
      // input.userId is caller-supplied. (REST siblings under hub-protocol/rest
      // act via c.get("userId"), never input.userId, so they never match.)
      if (!file.includes("/hub-protocol/")) continue;
      const src = readFileSync(file, "utf8");
      const rel = file.split("/routers/")[1];
      for (const proc of extractProcedures(file, src)) {
        if (!SECOND_DOOR_IDENTITY.test(proc.body)) continue;
        if (!SECOND_DOOR_SINK.test(proc.body)) continue;
        if (IDENTITY_GUARD.test(proc.body)) continue;
        const id = `${rel}::${proc.name}`;
        if (!SECOND_DOOR_ALLOWLIST.has(id)) violations.push(id);
      }
    }
    expect(
      violations,
      `input.userId reaches an acting-identity sink (checkPermissionOrPropose / ` +
        `AccessContext.agent / a service write) with no preceding ` +
        `assertMayActAs(ctx, input.userId):\n  ${violations.join("\n  ")}`
    ).toEqual([]);
  });

  it("2nd-door positive control: a guarded governance sink matches the shape yet clears via assertMayActAs", () => {
    const channelsFile = FILES.find((f) =>
      f.endsWith("hub-protocol/channels.ts")
    );
    expect(channelsFile, "channels.ts must be scanned").toBeTruthy();
    const procs = extractProcedures(
      channelsFile!,
      readFileSync(channelsFile!, "utf8")
    );
    const createExternal = procs.find(
      (p) => p.name === "createExternalChannel"
    );
    expect(createExternal, "createExternalChannel extracted").toBeTruthy();
    // It DOES pass `userId: input.userId` into checkPermissionOrPropose (the shape
    // MUST match) and its `assertMayActAs(ctx, input.userId)` MUST clear it. Drop
    // that guard and the check flags it (not allowlisted).
    expect(SECOND_DOOR_IDENTITY.test(createExternal!.body)).toBe(true);
    expect(SECOND_DOOR_SINK.test(createExternal!.body)).toBe(true);
    expect(IDENTITY_GUARD.test(createExternal!.body)).toBe(true);
    expect(
      SECOND_DOOR_ALLOWLIST.has(
        "hub-protocol/channels.ts::createExternalChannel"
      )
    ).toBe(false);
  });

  // NON-COVERAGE (semantic, not structural — acknowledged, not promised):
  //  - provider-STRING-as-authorization (messaging linked-unread/conversations
  //    match `accountByProvider.get(provider)` as a stand-in for real ownership);
  //  - caller-supplied external id → connector call (GET
  //    /messaging/conversations/{threadId}/messages passes an unvalidated
  //    accountId straight to connector.getMessages — an IDOR-via-proxy class);
  //  - the pod-wide `channels.findMany` with NO id/workspace filter at all
  //    (linked-unread) — not a by-id read, so the by-id scan can't grab it.
  // All three need a code-review pass; no grep catches them.
});
