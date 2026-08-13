import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";

/**
 * GUARD — a completed domain mutation reaches BOTH pipes through ONE door.
 *
 * Every first-class mutation (entity / relation / role / facet …) has to land in
 * two places: the immutable event LOG (timeline / activity feed) and the
 * side-effect FAN-OUT (search + webhooks + the automation trigger matcher). They
 * are keyed on the same `${subjectType}.${action}` vocabulary. Wired by hand at
 * every door, the two drift: a change shows in the timeline but no automation
 * ever fires, or an automation fires with no timeline row.
 *
 * `recordDomainMutation` (utils/domain-mutation.ts) collapses the pair into one
 * call. This guard has two parts:
 *
 *   Part A (runtime, real code path): call the ACTUAL door and prove it fires
 *     BOTH `auditLog({ phase: "completed" })` and `emitSideEffects`, both keyed
 *     on the same subjectType + action. Not a restatement of the check — it
 *     invokes recordDomainMutation itself.
 *
 *   Part B (drift reachability): scan the router tree for files that STILL
 *     hand-wire the pair (a raw `phase: "completed"` audit AND an
 *     `emitSideEffects`/`emitFacetSideEffects` call in the same file). Each must
 *     be on the un-unified ALLOWLIST. A NEW door that hand-wires both without
 *     being allowlisted FAILS here — forcing the author to either route through
 *     recordDomainMutation or make a conscious, reviewed exception. The
 *     allowlist does NOT fail CI; it flags the debt with a TODO.
 */

// ── Part A ───────────────────────────────────────────────────────────────────

const auditLogMock = vi.fn().mockResolvedValue({ id: "evt", type: "x" });
const emitSideEffectsMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../utils/audit-log.js", () => ({
  auditLog: (...args: unknown[]) => auditLogMock(...args),
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: (...args: unknown[]) => emitSideEffectsMock(...args),
}));

// Imported AFTER the mocks so the door binds to them.
const { recordDomainMutation } = await import("../utils/domain-mutation.js");

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("guard: recordDomainMutation fires BOTH pipes (real code path)", () => {
  beforeEach(() => {
    auditLogMock.mockClear();
    emitSideEffectsMock.mockClear();
  });

  it("appends a .completed log event AND fans out side-effects on the same subjectType.action", async () => {
    await recordDomainMutation({
      subjectType: "entity",
      action: "create",
      subjectId: "e1",
      userId: "u1",
      workspaceId: "w1",
      sessionId: "s1",
      data: { profileSlug: "person" },
      logData: { profileSlug: "person", global: false },
    });
    await tick(); // fire-and-forget fan-out

    expect(auditLogMock).toHaveBeenCalledTimes(1);
    expect(emitSideEffectsMock).toHaveBeenCalledTimes(1);

    const logArg = auditLogMock.mock.calls[0][0] as Record<string, unknown>;
    const emitArg = emitSideEffectsMock.mock.calls[0][0] as Record<
      string,
      unknown
    >;

    // Same vocabulary on both pipes — this is the anti-drift invariant.
    expect(logArg.phase).toBe("completed");
    expect(logArg.subjectType).toBe(emitArg.subjectType);
    expect(logArg.action).toBe(emitArg.action);
    expect(logArg.subjectId).toBe(emitArg.subjectId);

    // logData routes to the LOG; data routes to the FAN-OUT.
    expect(logArg.data).toEqual({ profileSlug: "person", global: false });
    expect(emitArg.data).toEqual({ profileSlug: "person" });
    // sessionId reaches the matcher pipe (F2 chain floor depends on this).
    expect(emitArg.sessionId).toBe("s1");
  });

  it("logData defaults to data when omitted (log and fan-out share one payload)", async () => {
    await recordDomainMutation({
      subjectType: "relation",
      action: "delete",
      subjectId: "r1",
      userId: "u1",
      data: { relationType: "knows" },
    });
    await tick();
    expect((auditLogMock.mock.calls[0][0] as { data: unknown }).data).toEqual({
      relationType: "knows",
    });
  });
});

// ── Part B ───────────────────────────────────────────────────────────────────

/**
 * Doors that STILL hand-wire the completed-log + side-effect pair instead of
 * routing through recordDomainMutation. Migrating them is safe but was deferred
 * to avoid colliding with concurrent work in the same files. Each is real debt —
 * remove it from this list once the file routes its completed mutations through
 * the door. Do NOT add a new file here to silence the guard: use the door.
 *
 * NOTE entities/facets.ts stays here for its FACET trio (attach/update/detach
 * via emitFacetSideEffects) + document re-index emits — its plain entity
 * create/update/delete ARE migrated. relations.ts and roles.ts are absent
 * because they are fully unified (relations' remaining `.completed` sites —
 * grant-anchor, projectMember — are audit-only, not a hand-wired pair).
 *
 * Wave 3 router-decomposition (2026-08-12) split entities.ts by domain — the
 * facet trio (the only entities.ts code that tripped this guard) now lives in
 * entities/facets.ts; the barrel + the other entities/*.ts modules route
 * their completions through recordDomainMutation and don't hand-wire the pair.
 */
const UN_UNIFIED_ALLOWLIST = new Set<string>([
  "entities/facets.ts", // TODO: facet trio (entity_facet attach/update/detach)
  "documents.ts", // TODO
  "views.ts", // TODO
  "projects.ts", // TODO
  "workspaces.ts", // TODO
  // Wave 6 router-decomposition split workspaces.ts by domain; only the
  // definition-engine cluster (createFromDefinition/applyDefinition) still
  // hand-wires the raw completed-audit + emitSideEffects pair post-split.
  "workspaces/definition-engine.ts", // TODO
  "api-keys.ts", // TODO
  "templates.ts", // TODO
  "skills.ts", // TODO
  "tools.ts", // TODO
  "sharing.ts", // TODO
  "proposals.ts", // TODO
  // Wave 1 router-decomposition split approve-executors.ts by domain; only
  // project/archive's raw completed-audit + emitSideEffects pair still lands
  // here post-split (entity.ts's merge emits have no adjacent completed-audit
  // string, so they don't trip this guard).
  "proposals/executors/project.ts", // TODO
]);

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

describe("guard: no new door hand-wires the completed-mutation pair", () => {
  it("every file with a raw completed-audit + side-effect pair is allowlisted (un-unified debt)", () => {
    // Resolve relative to THIS test file, not process.cwd() — a cwd-relative
    // path passes from packages/api but ENOENTs when CI runs from the repo root.
    const routersRoot = join(
      fileURLToPath(new URL(".", import.meta.url)),
      "..",
      "routers"
    );
    const offenders = tsFiles(routersRoot)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        const hasCompletedAudit = src.includes('phase: "completed"');
        const hasFanout =
          src.includes("emitSideEffects(") ||
          src.includes("emitFacetSideEffects(");
        return hasCompletedAudit && hasFanout;
      })
      .map((f) => relative(routersRoot, f))
      .filter((rel) => !UN_UNIFIED_ALLOWLIST.has(rel));

    expect(offenders).toEqual([]);
  });
});
