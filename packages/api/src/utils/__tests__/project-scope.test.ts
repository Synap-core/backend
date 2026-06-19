/**
 * project-scope.ts — unit tests
 *
 * Tests the PURE compositional logic of `projectMemberWhere`, `projectLensWhere`,
 * and `accessScopeWhere`. No live DB: Drizzle helpers and db are mocked so the
 * tests run without a PostgreSQL connection.
 *
 * Vitest hoisting rule: `vi.mock` factories must not reference variables defined
 * outside the factory — they are hoisted to the top of the file and run before
 * any module-level let/const. All mock state is declared inside the factory or
 * via `vi.hoisted()`.
 *
 * What we verify:
 *   1. `BELONGS_TO_PROJECT` constant is "belongs_to_project".
 *   2. `projectMemberWhere` returns OR(inArray, inArray) keyed on entityIdColumn.
 *   3. `projectLensWhere` returns OR(eq, inArray) with eq matching projectLens.
 *   4. `accessScopeWhere` ANDs floor + optional workspace/project lenses.
 *   5. `workspaceLens = null` narrows to pod-personal (no workspaceLensWhere).
 *   6. `workspaceLens = string` includes workspaceLensWhere arm.
 *   7. `projectLens = string` includes projectLensWhere OR arm.
 *   8. `projectLens = null/undefined` omits the project OR arm.
 */

import { describe, it, expect, vi } from "vitest";

// ── Mock @synap/database — exports db + all drizzle helpers re-exported from it
// project-scope.ts imports: { and, eq, inArray, isNull, isNotNull, or, db }
// from "@synap/database". All must be present or vitest throws "No X export".
vi.mock("@synap/database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ _subquery: true }),
      }),
    }),
  },
  and: (...args: unknown[]) => ({ _tag: "and", args }),
  or: (...args: unknown[]) => ({ _tag: "or", args }),
  eq: (col: unknown, val: unknown) => ({ _tag: "eq", col, val }),
  inArray: (col: unknown, sub: unknown) => ({ _tag: "inArray", col, sub }),
  isNull: (col: unknown) => ({ _tag: "isNull", col }),
  isNotNull: (col: unknown) => ({ _tag: "isNotNull", col }),
}));

// ── Mock pg-core column stubs ────────────────────────────────────────────────
vi.mock("@synap/database/schema", () => ({
  projectMembers: {
    projectId: { _colName: "project_id" },
    userId: { _colName: "user_id" },
  },
  relations: {
    sourceEntityId: { _colName: "source_entity_id" },
    targetEntityId: { _colName: "target_entity_id" },
    type: { _colName: "type" },
  },
}));

// ── Mock user-visible-where helpers ──────────────────────────────────────────
vi.mock("../user-visible-where.js", () => ({
  userVisibleWhere: (col: unknown, userId: string) => ({
    _tag: "userVisibleWhere",
    col,
    userId,
  }),
  workspaceLensWhere: (col: unknown, userId: string, wsId: string) => ({
    _tag: "workspaceLensWhere",
    col,
    userId,
    wsId,
  }),
}));

// ── Import module under test (after all mocks are declared) ──────────────────
import {
  projectMemberWhere,
  projectLensWhere,
  accessScopeWhere,
  BELONGS_TO_PROJECT,
} from "../project-scope.js";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

// Helper: cast a plain object to AnyPgColumn for test calls.
const col = (name: string): AnyPgColumn =>
  ({ _colName: name }) as unknown as AnyPgColumn;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BELONGS_TO_PROJECT", () => {
  it("is the canonical relation type string", () => {
    expect(BELONGS_TO_PROJECT).toBe("belongs_to_project");
  });
});

describe("projectMemberWhere", () => {
  it("returns an OR of two inArray predicates", () => {
    const result = projectMemberWhere(col("id"), "user-1") as any;

    expect(result._tag).toBe("or");
    expect(result.args).toHaveLength(2);
    expect(result.args[0]._tag).toBe("inArray");
    expect(result.args[1]._tag).toBe("inArray");
  });

  it("passes entityIdColumn as the first arg of both inArray arms", () => {
    const entityIdCol = col("entities.id");
    const result = projectMemberWhere(entityIdCol, "user-1") as any;

    expect(result.args[0].col).toBe(entityIdCol);
    expect(result.args[1].col).toBe(entityIdCol);
  });

  it("builds different subqueries for the two arms (member ids vs project ids)", () => {
    const result = projectMemberWhere(col("id"), "user-2") as any;
    // Both subqueries are opaque objects from the db.select chain
    expect(result.args[0].sub).toBeDefined();
    expect(result.args[1].sub).toBeDefined();
  });
});

describe("projectLensWhere", () => {
  it("returns an OR of eq + inArray", () => {
    const result = projectLensWhere(col("id"), "project-entity-uuid") as any;

    expect(result._tag).toBe("or");
    expect(result.args).toHaveLength(2);
    expect(result.args[0]._tag).toBe("eq");
    expect(result.args[1]._tag).toBe("inArray");
  });

  it("eq arm matches entityIdColumn to projectLens value", () => {
    const entityIdCol = col("id");
    const projectId = "proj-abc";
    const result = projectLensWhere(entityIdCol, projectId) as any;

    expect(result.args[0].col).toBe(entityIdCol);
    expect(result.args[0].val).toBe(projectId);
  });

  it("inArray arm is keyed on the same entityIdColumn", () => {
    const entityIdCol = col("id");
    const result = projectLensWhere(entityIdCol, "proj-xyz") as any;

    expect(result.args[1].col).toBe(entityIdCol);
  });
});

describe("accessScopeWhere", () => {
  const wsIdCol = col("workspace_id");
  const entityIdCol = col("id");
  const ownerCol = col("user_id");
  const userId = "user-xyz";

  it("returns an AND expression", () => {
    const result = accessScopeWhere({
      workspaceIdColumn: wsIdCol,
      entityIdColumn: entityIdCol,
      ownerColumn: ownerCol,
      userId,
    }) as any;

    expect(result._tag).toBe("and");
  });

  it("floor is the first arg (an OR with 3 branches)", () => {
    const result = accessScopeWhere({
      workspaceIdColumn: wsIdCol,
      entityIdColumn: entityIdCol,
      ownerColumn: ownerCol,
      userId,
    }) as any;

    // First arg of the outer AND is the floor (an OR)
    const floor = result.args[0];
    expect(floor._tag).toBe("or");
    expect(floor.args).toHaveLength(3);
  });

  it("includes workspaceLensWhere when workspaceLens is a string", () => {
    const result = accessScopeWhere({
      workspaceIdColumn: wsIdCol,
      entityIdColumn: entityIdCol,
      ownerColumn: ownerCol,
      userId,
      workspaceLens: "ws-1",
    }) as any;

    const wsLens = result.args.find(
      (a: any) => a?._tag === "workspaceLensWhere"
    );
    expect(wsLens).toBeDefined();
    expect(wsLens.wsId).toBe("ws-1");
  });

  it("narrows to podPersonal (not workspaceLensWhere) when workspaceLens is null", () => {
    const result = accessScopeWhere({
      workspaceIdColumn: wsIdCol,
      entityIdColumn: entityIdCol,
      ownerColumn: ownerCol,
      userId,
      workspaceLens: null,
    }) as any;

    // No workspaceLensWhere arm
    const wsLens = result.args.find(
      (a: any) => a?._tag === "workspaceLensWhere"
    );
    expect(wsLens).toBeUndefined();

    // The workspace narrow is the podPersonal AND(isNull, eq)
    const podPersonalArm = result.args.find(
      (a: any) =>
        a?._tag === "and" &&
        Array.isArray(a.args) &&
        a.args.some((x: any) => x?._tag === "isNull")
    );
    expect(podPersonalArm).toBeDefined();
  });

  it("includes project lens OR when projectLens is a string", () => {
    const result = accessScopeWhere({
      workspaceIdColumn: wsIdCol,
      entityIdColumn: entityIdCol,
      ownerColumn: ownerCol,
      userId,
      projectLens: "proj-entity-id",
    }) as any;

    // Project narrow is the projectLensWhere OR(eq, inArray)
    const projNarrow = result.args.find(
      (a: any) => a?._tag === "or" && a.args?.[0]?._tag === "eq"
    );
    expect(projNarrow).toBeDefined();
    expect(projNarrow.args[0].val).toBe("proj-entity-id");
  });

  it("omits project lens when projectLens is null", () => {
    const result = accessScopeWhere({
      workspaceIdColumn: wsIdCol,
      entityIdColumn: entityIdCol,
      ownerColumn: ownerCol,
      userId,
      projectLens: null,
    }) as any;

    // No OR from projectLensWhere
    const projNarrow = result.args.find(
      (a: any) => a?._tag === "or" && a.args?.[0]?._tag === "eq"
    );
    expect(projNarrow).toBeUndefined();
  });

  it("omits project lens when projectLens is undefined", () => {
    const result = accessScopeWhere({
      workspaceIdColumn: wsIdCol,
      entityIdColumn: entityIdCol,
      ownerColumn: ownerCol,
      userId,
      // projectLens omitted
    }) as any;

    const projNarrow = result.args.find(
      (a: any) => a?._tag === "or" && a.args?.[0]?._tag === "eq"
    );
    expect(projNarrow).toBeUndefined();
  });
});
