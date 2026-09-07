import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `linkEntityToProject` is the ONE write path for `belongs_to_project`.
 *
 * ── WHY THE EXISTENCE CHECK IS LOAD-BEARING ─────────────────────────────────
 * `relations.target_entity_id` has NO foreign key to `projects`. So a caller
 * passing a project id that does not exist — or one it cannot see — used to
 * write a GHOST membership edge: a row the project-lens read
 * (`projectLensWhere` → `exposureLensWhere`) can never resolve. `capture.ts`
 * names the consequence exactly: "a SILENT DROP reported as `✓ stored`".
 *
 * That is the measured producer of the 13 dangling `belongs_to_project` edges
 * on the live pod. A guard existed at ONE call site only; it now lives in the
 * door, so every caller inherits it.
 *
 * ── AND WHY IT IS AN ACCESS CHECK, NOT A TIDINESS CHECK ─────────────────────
 * `belongs_to_project` is a whitelisted EXPOSURE relation, ORed into the access
 * floor. Filing an entity into a project GRANTS project members access to it.
 * So the door must refuse a project the caller cannot see — otherwise a caller
 * could widen access to a project it has no business touching.
 *
 * These tests are DB-FREE on purpose: this package's DB-backed suites cannot
 * run without a migrated Postgres, so a DB-backed-only test would leave the
 * guard unproven. It was in fact unproven when written — removing the check
 * left every test in the repo green.
 */

const { ownerPrivateVisibleWhereMock } = vi.hoisted(() => ({
  ownerPrivateVisibleWhereMock: vi.fn(() => ({ __wsFloor: true })),
}));

/**
 * ⚠️ This is a TOTAL mock (no `importOriginal`), and that is load-bearing HERE
 * in a way it usually is not. Because the factory exports ONLY
 * `ownerPrivateVisibleWhere`, it doubles as an IMPORT ALLOWLIST: if someone
 * swaps the door back to the owner-blind `userVisibleWhere` — the exact defect
 * the assertion below exists to catch — the module fails to resolve that name at
 * IMPORT time and every test in this file dies before a single assertion runs.
 *
 * So the guard has TWO independent mechanisms: the specific 3-arg assertion
 * below, and this incidental allowlist. Converting this to the partial
 * `importOriginal` form (the general direction of travel in this repo, and
 * usually the right one) silently REMOVES the second and leaves only the
 * assertion. That trade is fine — the assertion is the real guard — but make it
 * knowingly, not as a drive-by cleanup.
 */
vi.mock("./user-visible-where.js", () => ({
  ownerPrivateVisibleWhere: ownerPrivateVisibleWhereMock,
}));

const { linkEntityToProject } = await import("./entity-project-membership.js");

/**
 * Minimal drizzle stand-in. `select()` resolves to `projectRows` (the existence
 * probe); `insert()` records what would have been written so a ghost edge is
 * observable rather than inferred.
 */
function makeDb(projectRows: Array<{ id: string }>) {
  const inserted: Array<Record<string, unknown>> = [];
  const onConflictDoNothing = vi.fn(async () => undefined);
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => projectRows,
        }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { onConflictDoNothing };
      },
    }),
  };
  return { db, inserted };
}

const ARGS = {
  entityId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  userId: "user-1",
  workspaceId: null,
};

beforeEach(() => ownerPrivateVisibleWhereMock.mockClear());

describe("linkEntityToProject — the ghost-edge guard", () => {
  it("REFUSES and writes NOTHING when the project does not resolve", async () => {
    const { db, inserted } = makeDb([]); // existence probe finds no row

    const result = await linkEntityToProject(db as never, ARGS as never);

    expect(result.linked).toBe(false);
    expect((result as { reason?: string }).reason).toBe("project_not_found");
    // The whole point: no edge is written. A ghost edge here would be reported
    // to the user as a successful store and then be invisible forever.
    expect(
      inserted,
      "an unresolvable project must write NO relation row — a ghost " +
        "`belongs_to_project` edge is a silent drop the project lens can " +
        "never resolve, reported to the caller as success."
    ).toEqual([]);
  });

  it("LINKS when the project resolves, stamping the project id as the target", async () => {
    const { db, inserted } = makeDb([{ id: ARGS.projectId }]);

    const result = await linkEntityToProject(db as never, ARGS as never);

    expect(result.linked).toBe(true);
    expect(inserted).toHaveLength(1);
    // `target_entity_id` holds the PROJECT TABLE id, not an entity id — the
    // thing that makes this column FK-less in the first place.
    expect(inserted[0]).toMatchObject({
      sourceEntityId: ARGS.entityId,
      targetEntityId: ARGS.projectId,
      userId: ARGS.userId,
    });
  });

  it("consults the workspace visibility floor — it is an ACCESS check", async () => {
    const { db } = makeDb([{ id: ARGS.projectId }]);
    await linkEntityToProject(db as never, ARGS as never);

    // Filing into a project GRANTS its members access, so the door must decide
    // visibility rather than existence alone. If this stops being called, the
    // door has quietly become a tidiness check.
    //
    // It must be the OWNER-GATED helper specifically: `projects` is an
    // ownerPrivate table, so the bare `userVisibleWhere` would admit every
    // user's pod-personal projects through its owner-blind `IS NULL` branch.
    expect(
      ownerPrivateVisibleWhereMock,
      "the door no longer consults `ownerPrivateVisibleWhere`, so it can link " +
        "a project the caller cannot see — which WIDENS access via the " +
        "`belongs_to_project` exposure relation."
    ).toHaveBeenCalledWith(expect.anything(), expect.anything(), ARGS.userId);
  });
});
