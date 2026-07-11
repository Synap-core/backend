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
const SELF_SCOPE_BUILDERS = ["protectedProcedure", "podProcedure"];

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
    // TODO(access-convergence): FALSE POSITIVE (not a leak) — the scan can't see
    // the floor. `proposals.get` loads by id then EXPLICITLY gates: for a
    // workspace proposal it checks owner/admin/editor membership via an inline
    // `db.query.workspaceMembers.findFirst(eq(...userId, userId))`; for a pod-wide
    // proposal it checks `proposalData.sourceId === userId`. Neither the inline
    // membership query (local-var userId) nor the `sourceId` compare matches a
    // recognized signal, so the heuristic mis-flags it. Kept here (shrink-only)
    // until it routes through scopedDb / getWorkspaceMembership so the scan sees it.
    "proposals.ts::get",
  ]);

  it("every by-id read of a registered scoped table applies a scope floor", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const proc of extractProcedures(file, src)) {
        if (!SELF_SCOPE_BUILDERS.includes(proc.builder)) continue;
        if (!/\.query\(/.test(proc.body)) continue;

        // A by-id point lookup on a scoped table that does NOT filter by that
        // table's own userId column (the read itself is unfloored).
        let table: string | undefined;
        for (const t of BY_ID_SCOPED_TABLES) {
          if (!new RegExp(`db\\.query\\.${t}\\.findFirst\\(`).test(proc.body))
            continue;
          if (!new RegExp(`\\b${t}\\.id\\b`).test(proc.body)) continue;
          if (new RegExp(`\\b${t}\\.userId\\b`).test(proc.body)) continue;
          table = t;
          break;
        }
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
});
