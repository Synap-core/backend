/**
 * The one usable-in-space rule: pod-wide everywhere, homed only at home, and
 * nothing homed outside any space. The SQL form is the same rule.
 */
import { describe, it, expect } from "vitest";
import { PgDialect, pgTable, uuid } from "drizzle-orm/pg-core";
import {
  notUsableInSpaceReason,
  usableInSpace,
  usableInSpaceWhere,
} from "./usable-in-space.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const things = pgTable("things", { workspaceId: uuid("workspace_id") });
const sqlOf = (space: string | null) =>
  new PgDialect().sqlToQuery(usableInSpaceWhere(things.workspaceId, space));

describe("usableInSpace", () => {
  it.each([
    ["pod-wide, in a space", null, B, true],
    ["pod-wide, outside any space", null, null, true],
    ["homed, at home", A, A, true],
    ["homed, elsewhere", A, B, false],
    ["homed, outside any space", A, null, false],
  ] as const)("%s", (_label, home, space, expected) => {
    expect(usableInSpace({ workspaceId: home }, space)).toBe(expected);
  });

  it("the SQL form admits pod-wide rows, and home rows only in a space", () => {
    expect(sqlOf(B)).toMatchObject({
      sql: '("things"."workspace_id" is null or "things"."workspace_id" = $1)',
      params: [B],
    });
    expect(sqlOf(null)).toMatchObject({
      sql: '"things"."workspace_id" is null',
      params: [],
    });
  });

  it("the refusal names where it lives and where to run it", () => {
    expect(
      notUsableInSpaceReason(
        "Playbook",
        { id: "pb-1", workspaceId: A, name: "Ship" },
        B
      )
    ).toBe(
      `Playbook "Ship" (pb-1) lives in space ${A}, so it is not visible in space ${B}: run it in space ${A}.`
    );
  });
});
