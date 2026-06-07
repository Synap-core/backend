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
  "userVisibleWhere",
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
];

// Per-user scoping: the row's userId pinned to the caller — `eq(t.userId,
// ctx.userId)` / `requireUserId` / `authUserId`. Precise (not a bare "ctx.userId"
// substring) so a procedure that merely *mentions* ctx.userId for logging/audit
// while leaving an input.workspaceId read unguarded is NOT falsely cleared.
const USER_SCOPE_PATTERN =
  /userId\s*,\s*(ctx\.userId|requireUserId|authUserId)/;

// Procedures the static scan can't see are safe (the scoping lives in a
// repository/helper call, not an inline WHERE). Justify each; may only shrink.
const ALLOWLIST = new Set<string>([
  // User-scoped inside eventRepository.searchEvents({ userId }) — the workspaceId
  // is only a narrowing filter on already-user-scoped events.
  "subscriptions.ts::listAll",
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

  // The cross-workspace WRITE-leak class: a mutation that loads a row to mutate
  // via `findFirst(and(eq(t.id, input.id), input.workspaceId ? eq(...) : ...))`.
  // The `input.workspaceId` term reads like a scope guard but is attacker-
  // supplied, so it gates nothing. The fix is to load by id ALONE and gate on
  // the loaded row's workspace (assertWorkspaceWrite). This guards the exact
  // pattern just removed from automations.* — it must not come back.
  const ATTACKER_KEYED =
    /input\??\.workspaceId\s*\?\s*eq\([^)]*\.workspaceId,\s*input\??\.workspaceId/;

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
