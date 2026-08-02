import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/**
 * Invariant: the `capabilities.blastRadius` pre-flight must never UNDERSTATE
 * what a disconnect will break.
 *
 * Two distinct ways this door can lie, both locked here:
 *
 *   (a) WRONG ACCESS FLOOR. The dependent-automation query must sit on
 *       `scopedDb(AccessContext.from(ctx)).predicate(automations)`, with any
 *       workspace filter as a NARROWING inside that AND. A bare
 *       `isNull(automations.workspaceId)` used as the floor matches only
 *       pod-wide automations and hides every workspace-scoped dependent — the
 *       dialog would say "nothing depends on this" immediately before breaking
 *       six live automations. This is the recurring defect class on this
 *       surface, which is why it gets a tripwire rather than a comment.
 *
 *   (b) A COUNT PRESENTED AS EXHAUSTIVE. The containment match sees
 *       `type:"capability"` nodes only and misses skill / sub_automation /
 *       playbook_run nodes and runtime agent tool choice. `incomplete` is
 *       therefore a hardcoded constant and must not be reachable as `false`.
 *
 * Source-level proofs: the behaviour needs a live DB, which is fragile here.
 */

const router = readFileSync(
  new URL("../routers/capabilities.ts", import.meta.url),
  "utf-8"
);

/** The shared helper both `usedInProcesses` and `blastRadius` delegate to. */
function dependentProcessHelper(): string {
  const start = router.indexOf("async function findDependentProcesses");
  expect(start).toBeGreaterThan(-1);
  const end = router.indexOf("export const capabilitiesRouter", start);
  expect(end).toBeGreaterThan(start);
  return router.slice(start, end);
}

function blastRadiusProcedure(): string {
  const start = router.indexOf("blastRadius: protectedProcedure");
  expect(start).toBeGreaterThan(-1);
  // Ends at the next sibling procedure — found STRUCTURALLY, never by naming a
  // neighbour: inserting any procedure between the two would otherwise fold an
  // unrelated body into every assertion below.
  const rest = router.slice(start + 1);
  const next = /^\s+\w+: (?:protected|workspace)Procedure/m.exec(rest);
  expect(next).not.toBeNull();
  return rest.slice(0, next!.index);
}

describe("tripwire: blastRadius never understates the blast radius", () => {
  it("the dependent-process query is floored on the access layer", () => {
    // Whitespace-normalized: the exact newlines/indentation here exist only
    // because prettier wraps at 80 columns. Asserting on them would turn this
    // guard RED on a rename or an extra nesting level — a behaviour-preserving
    // refactor — and a permanently-red guard is one everyone learns to ignore.
    const helper = dependentProcessHelper().replace(/\s+/g, " ");
    expect(helper).toContain("scopedDb(AccessContext.from(ctx)).predicate(");
    expect(helper).toContain("predicate( automations )");
    // Playbooks get the same treatment — they are reached transitively but are
    // still a separately scoped table.
    expect(helper).toContain("predicate( playbooks )");
  });

  it("no bare isNull(workspaceId) is used as the FLOOR", () => {
    const helper = dependentProcessHelper();

    // `isNull(...workspaceId)` may appear ONLY inside an `or(...)` that widens a
    // workspace narrowing to also include pod-wide rows — never as a standalone
    // conjunct of the `where`. Every occurrence must be immediately preceded by
    // an `or(` on the line above it.
    const lines = helper.split("\n");
    lines.forEach((line, i) => {
      if (!/isNull\(\s*$|isNull\(\w+\.workspaceId\)/.test(line)) return;
      const prev = (lines[i - 1] ?? "") + line;
      expect(
        /\bor\(/.test(prev),
        `isNull(workspaceId) at line ${i + 1} is not inside an or(...) — a bare ` +
          `isNull floor hides every workspace-scoped dependent:\n${line}`
      ).toBe(true);
    });

    // And the narrowing must be conditional on a workspace being supplied: no
    // workspace → no narrow at all (the user floor), not an isNull filter.
    // Whitespace-normalized for the same reason as the assertion above.
    expect(helper.replace(/\s+/g, " ")).toContain("workspaceId ? or(");
  });

  it("blastRadius delegates to the shared helper — the predicate cannot fork", () => {
    const proc = blastRadiusProcedure();
    expect(proc).toContain("findDependentProcesses(");
    // It must NOT hand-roll its own automations select.
    expect(proc).not.toMatch(/\.from\(automations\)/);
  });

  it("the tool subject is access-gated before any grant/count is reported", () => {
    const proc = blastRadiusProcedure();
    expect(proc).toContain("predicate(toolsTable)");
    expect(proc).toContain('code: "NOT_FOUND"');
  });

  it("incomplete is a hardcoded constant and is never reachable as false", () => {
    const proc = blastRadiusProcedure();
    expect(proc).toContain("incomplete: true as const");
    expect(proc).not.toMatch(/incomplete:\s*false/);
    // Not computed from anything — no ternary, no comparison, no variable.
    expect(proc).not.toMatch(/incomplete:\s*[a-z][\w.]*\s*[,;]/);
    expect(proc).not.toMatch(/incomplete:\s*[^,]*[?<>=]/);
  });

  it("the per-connection number is null when not asked, never a fake 0", () => {
    const proc = blastRadiusProcedure();
    expect(proc).toContain("let sourcedEntityCount: number | null = null");
    expect(proc).toContain("if (input.connectionId)");
  });

  /**
   * REGRESSION (M1). `CapabilityNodeDef.capabilityId` is OPTIONAL
   * (packages/database/src/schema/automations.ts) and the shipped first-party
   * report automation emits FOUR `type:"capability"` nodes carrying only
   * `verbId: "ai.generate"` (packages/database/src/utils/ensure-report-automation.ts).
   * A `{data:{capabilityId}}` containment matches none of them, so `blastRadius`
   * on the built-in `synap_core` tool reported ZERO dependents while four
   * shipped nodes depended on it.
   *
   * Source-level, like the rest of this file: it proves the query ORs a
   * per-verb containment in, not that a specific row comes back (that needs a
   * live DB). Reverting to a capabilityId-only match turns this RED.
   */
  it("a verb-only capability node is matched, not just capabilityId", () => {
    const proc = blastRadiusProcedure().replace(/\s+/g, " ");
    // The tool's own verb catalog is read...
    expect(proc).toContain("verbs: toolsTable.capabilities");
    // ...and ORed into the containment alongside the tool-id match.
    expect(proc).toContain(
      "capabilityNodeMatch({ capabilityId: input.toolId })"
    );
    expect(proc).toContain("capabilityNodeMatch({ verbId: v })");
    expect(proc).toMatch(/or\(\s*byToolId,/);
  });

  /**
   * REGRESSION (H2). `tools` is registered `nullWorkspaceMeans:"podGlobalConfig"`
   * (access/registry.ts), so every pod-wide tool row is visible to every pod
   * member. Tool VISIBILITY therefore cannot be the gate for reading grant rows
   * — `grantedTo` / `scope` / `execMode` name a principal and its authority.
   * Removing the ownership floor turns this RED.
   */
  it("grants are floored on tool ownership or being a party to the grant", () => {
    const proc = blastRadiusProcedure().replace(/\s+/g, " ");
    expect(proc).toContain("const callerOwnsTool = tool.createdBy === userId");
    expect(proc).toContain("callerOwnsTool ? undefined : or(");
    expect(proc).toContain("eq(vaultGrants.createdBy, userId)");
    expect(proc).toContain("eq(vaultGrants.grantedTo, userId)");
    // The workspace filter is a NARROWING on top, never the floor — same shape
    // as the automation query (pod-wide grants survive it).
    expect(proc).toContain(
      "input.workspaceId ? or( isNull(vaultGrants.workspaceId)"
    );
  });

  /**
   * REGRESSION (H1). `entity_external_links` has no userId/workspaceId column
   * and no VisibilityRule, so nothing scopes it structurally. An arbitrary
   * `connectionId` was therefore an enumeration primitive, and a mismatched one
   * produced a confident count for a DIFFERENT connection.
   */
  it("the per-connection count is bound to the caller AND to the tool", () => {
    const proc = blastRadiusProcedure().replace(/\s+/g, " ");
    // Bound to the tool's provider and owned by the caller, else 404.
    expect(proc).toContain("connectionProvider !== toolProvider");
    expect(proc).toContain("input.connectionId.startsWith(`${userId}:`)");
    expect(proc).toContain('message: "Connection not found for this tool"');
    // And the count itself only ever sees entities the caller can see.
    expect(proc).toContain(
      "innerJoin(entities, eq(entities.id, entityExternalLinks.entityId))"
    );
    expect(proc).toContain(
      "scopedDb(AccessContext.from(ctx)).predicate(entities)"
    );
  });

  it("no per-connection automation count is fabricated", () => {
    // CapabilityNodeDef carries no connectionId/secretId, so the connection is
    // resolved at RUN time — a per-connection process count is unbackable.
    // `connectionId` must not reach the containment match at all.
    const proc = blastRadiusProcedure();
    const containment = proc.slice(
      proc.indexOf("findDependentProcesses("),
      proc.indexOf("// Grants on the tool itself")
    );
    expect(containment).not.toContain("connectionId");
  });
});
