/**
 * THE OFFER DOOR AND THE VALIDATE DOOR RESOLVE PLAYBOOKS THE SAME WAY.
 *
 * Found in dogfood: the browser rule editor's THEN picker offered 22 playbooks
 * at pod altitude and saving ANY of them failed with `playbook_run_unknown_ref`
 * — "references a playbook (id …) that does not exist" — about a playbook that
 * plainly does. Two doors, two answers to one question:
 *
 *   OFFER    `availableActionsFor` → `scopedDb(access).findMany(playbooks, …)`
 *            → the registered `playbooks` VisibilityRule: every workspace the
 *              caller belongs to, plus pod-wide.
 *   VALIDATE `loadFlowValidationResolvers` → a RAW select narrowed to
 *            `isNull(playbooks.workspaceId)` whenever no workspace was set.
 *
 * The pod has ZERO pod-wide playbooks, so the validator accepted none of them.
 *
 * ── HOW THIS IS TESTED, AND WHAT IT DOES NOT PROVE ──────────────────────────
 * Predicate-level, no seeded DB — the technique the sibling access suites use
 * and justify (`pod-wide-opt-in.test.ts`, `two-user-floor.test.ts`): compile
 * each predicate to SQL + bound params with `PgDialect` and inspect the emitted
 * WHERE. A narrow that REQUIRES `workspace_id is null` structurally cannot
 * match a workspace-scoped row; a floor that binds the caller's id cannot match
 * a workspace the caller has no membership in.
 *
 * Two halves, deliberately:
 *
 *   1. SHAPE assertions (the correctness half). Each of the three cases the
 *      defect turns on, asserted against the emitted SQL on its own.
 *   2. A CONVERGENCE assertion (the backstop). The two doors compile to the
 *      same predicate at both altitudes. A convergence guard proves SAMENESS,
 *      never CORRECTNESS — two doors could agree on a wrong rule — which is
 *      exactly why half 1 exists and is listed first.
 *
 * What it does NOT prove: that a seeded row is actually returned. No test in
 * this package seeds Postgres, and inventing that harness here would be a
 * bigger change than the fix. The row-level behaviour is covered by the
 * dogfood walk (create the rule, reopen, THEN persists).
 */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { and, or, eq, ne, isNull, playbooks } from "@synap/database";
import { AccessContext, scopedDb } from "../access/index.js";
import { playbookValidationAccess } from "./automations.js";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);

const USER = "user-A";
const WS = "11111111-1111-4111-8111-111111111111";

/** The predicate the VALIDATE door runs, at a given altitude. */
const validatePredicate = (workspaceId: string | null | undefined) =>
  compile(
    scopedDb(playbookValidationAccess(USER, workspaceId)).predicate(playbooks)!
  );

/** The predicate the OFFER door runs — `availableActionsFor`'s own read. */
const offerPredicate = (workspaceId: string | null | undefined) => {
  const access = workspaceId
    ? AccessContext.operator({ userId: USER }).withLens(workspaceId)
    : AccessContext.operator({ userId: USER });
  return compile(scopedDb(access).predicate(playbooks)!);
};

describe("playbook reference resolution — validate matches offer", () => {
  it("the scan can still see what it hunts (non-vacuity)", () => {
    // If `predicate` ever returns undefined for `playbooks` (the rule dropped
    // out of the registry, the table renamed), every assertion below would be
    // reading `compile(undefined!)` and this file would prove nothing.
    expect(
      scopedDb(AccessContext.operator({ userId: USER })).predicate(playbooks)
    ).toBeTruthy();
    expect(validatePredicate(undefined).sql.length).toBeGreaterThan(20);
  });

  it("AT POD ALTITUDE a workspace-scoped playbook is NOT excluded", () => {
    // THE DEFECT. The old code emitted `workspace_id is null` as the whole
    // narrow here, which can never match a workspace-scoped row — and every
    // playbook on this pod is workspace-scoped.
    const q = validatePredicate(undefined);
    expect(q.sql).not.toBe('"playbooks"."workspace_id" is null');
    // The floor is still applied: the caller's identity is bound.
    expect(q.params).toContain(USER);
  });

  it("a workspace the caller cannot see is still excluded (the floor holds)", () => {
    // Alignment, not widening: the membership/user floor is what excludes an
    // unseeable workspace, and it survives. If this predicate ever stopped
    // binding the caller, any authenticated user could reference any playbook.
    const q = validatePredicate(undefined);
    expect(q.params).toContain(USER);
    expect(q.sql).toMatch(/\$\d/);
  });

  it("UNDER A WORKSPACE LENS the lens narrows and globals stay admitted", () => {
    const q = validatePredicate(WS);
    expect(q.params).toContain(WS);
    expect(q.params).toContain(USER);
  });

  it("the `null` lens is NOT what the validator uses", () => {
    // `null` means globals-only — the very narrowing that caused the defect.
    // Pinned so nobody "simplifies" the helper back into it.
    const globalsOnly = compile(
      scopedDb(
        AccessContext.operator({ userId: USER }).withLens(null)
      ).predicate(playbooks)!
    );
    expect(validatePredicate(undefined).sql).not.toBe(globalsOnly.sql);
    expect(validatePredicate(null).sql).not.toBe(globalsOnly.sql);
  });

  it("ARCHIVED is excluded by the conjunct the validator ANDs on", () => {
    // The status filter is not part of the visibility rule — it is the
    // reference conjunct, mirrored from the offer door's own `ne(...)`.
    const q = compile(ne(playbooks.status, "archived"));
    expect(q.sql).toContain('"playbooks"."status" <> ');
    expect(q.params).toContain("archived");
  });

  it("CONVERGENCE (backstop): both doors compile to the same predicate", () => {
    for (const lens of [undefined, WS]) {
      const v = validatePredicate(lens);
      const o = offerPredicate(lens);
      expect(v.sql).toBe(o.sql);
      expect(v.params).toEqual(o.params);
    }
  });

  it("the OLD narrow is provably different from the new one", () => {
    // The literal predicate the code used to emit at pod altitude. Keeping it
    // here makes the regression legible: if someone reverts the helper, the
    // pod-altitude assertion above goes red and this row says what it became.
    const oldPodAltitude = compile(
      and(
        isNull(playbooks.workspaceId),
        or(eq(playbooks.workspaceId, WS), isNull(playbooks.workspaceId))
      )!
    );
    expect(validatePredicate(undefined).sql).not.toBe(oldPodAltitude.sql);
  });
});
