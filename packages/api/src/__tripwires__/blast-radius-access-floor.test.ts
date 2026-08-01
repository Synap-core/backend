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
  // Ends at the next sibling procedure in the router.
  const end = router.indexOf("checkHealth: protectedProcedure", start);
  expect(end).toBeGreaterThan(start);
  return router.slice(start, end);
}

describe("tripwire: blastRadius never understates the blast radius", () => {
  it("the dependent-process query is floored on the access layer", () => {
    const helper = dependentProcessHelper();
    expect(helper).toContain(
      "scopedDb(AccessContext.from(ctx)).predicate(\n    automations\n  )"
    );
    // Playbooks get the same treatment — they are reached transitively but are
    // still a separately scoped table.
    expect(helper).toContain("predicate(\n      playbooks\n    )");
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
    expect(helper).toContain("workspaceId\n          ? or(");
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
