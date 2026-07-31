/**
 * ledger-query-scope.ts — unit tests (the SECURITY-critical visibility proof for
 * the two LEDGER source nodes, `runs_query` and `proposals_query`).
 *
 * Modelled on `entity-query-scope.test.ts`: no live DB — `@synap/database`'s
 * helpers are mocked to return tagged boolean-tree nodes, and a small
 * interpreter evaluates the REAL predicate the code builds against sample rows.
 * That makes this a ROW-LEVEL semantic proof, not just a structural one.
 *
 * `userVisibleWhere` is mocked as a tagged node and interpreted with its REAL
 * semantics — "workspace_id IS NULL (pod-wide) OR the workspace is one the user
 * is a member of / owns / is pod-visible" — against a membership fixture. The
 * point of THESE tests is the USAGE (which column, which identity, and what
 * happens with no owner); `userVisibleWhere`'s own internals are the api SSOT
 * and are exercised where they live.
 *
 * The claims:
 *   (a) an owner sees runs/proposals in a workspace they are a member of,
 *   (b) an owner sees POD-WIDE (workspace_id NULL) rows — the deliberate
 *       "pod-wide proposals get the same handling as any proposal" decision,
 *   (c) an owner NEVER sees a workspace they have no relationship to — the
 *       cross-workspace-leak guard,
 *   (d) with NO owner the predicate FAILS CLOSED to the run's own workspace and
 *       admits no pod-wide row (an un-floored ledger read would hand a run every
 *       other user's runs/proposals).
 */

import { describe, it, expect, vi } from "vitest";

// Membership fixture the mocked `userVisibleWhere` consults.
const WS_A = "ws-a";
const WS_B = "ws-b";
const OWNER = "owner-1";
const OTHER = "other-2";
/** userId → workspaces that user may see (member / owner / pod-visible union). */
const VISIBLE_WORKSPACES: Record<string, Set<string>> = {
  [OWNER]: new Set([WS_A]),
  [OTHER]: new Set([WS_B]),
};

vi.mock("@synap/database", () => ({
  eq: (col: unknown, val: unknown) => ({ _tag: "eq", col, val }),
  userVisibleWhere: (col: unknown, userId: string) => ({
    _tag: "userVisible",
    col,
    userId,
  }),
  automationRuns: { workspaceId: { _colName: "workspace_id", _t: "runs" } },
  proposals: { workspaceId: { _colName: "workspace_id", _t: "proposals" } },
}));

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runsQueryVisibilityWhere,
  proposalsQueryVisibilityWhere,
} from "../ledger-query-scope.js";

type Row = { workspace_id: string | null };
type Node = any;

function evalPredicate(node: Node, row: Row): boolean {
  switch (node._tag) {
    case "eq":
      return row[node.col._colName as keyof Row] === node.val;
    case "userVisible": {
      // The real semantics: pod-wide rows are visible to everyone with a floor,
      // workspace rows only when the caller may see that workspace.
      const ws = row[node.col._colName as keyof Row];
      if (ws === null) return true;
      return VISIBLE_WORKSPACES[node.userId]?.has(ws) === true;
    }
    default:
      throw new Error(`evalPredicate: unhandled tag ${node?._tag}`);
  }
}

const rowA: Row = { workspace_id: WS_A }; // this workspace
const rowB: Row = { workspace_id: WS_B }; // a workspace the owner can't see
const rowPodWide: Row = { workspace_id: null }; // pod-wide

for (const [name, build, table] of [
  ["runs_query", runsQueryVisibilityWhere, "runs"],
  ["proposals_query", proposalsQueryVisibilityWhere, "proposals"],
] as const) {
  describe(`${name} visibility — owner known (the user floor)`, () => {
    const where = build({ workspaceId: WS_A, ownerId: OWNER });

    it("binds the predicate to THIS table's workspace column and the OWNER's id", () => {
      // Guards against the copy-paste failure mode of a near-duplicate node:
      // proposals_query filtering automation_runs.workspace_id (or vice versa).
      expect((where as any)._tag).toBe("userVisible");
      expect((where as any).col._t).toBe(table);
      expect((where as any).userId).toBe(OWNER);
    });

    it("(a) returns rows in a workspace the owner can see", () => {
      expect(evalPredicate(where, rowA)).toBe(true);
    });

    it("(b) returns POD-WIDE rows — same handling as any other row", () => {
      expect(evalPredicate(where, rowPodWide)).toBe(true);
    });

    it("(c) NEVER returns a workspace the owner has no relationship to", () => {
      expect(evalPredicate(where, rowB)).toBe(false);
    });

    it("a DIFFERENT owner gets a different floor (identity is really threaded)", () => {
      const otherWhere = build({ workspaceId: WS_A, ownerId: OTHER });
      expect(evalPredicate(otherWhere, rowA)).toBe(false);
      expect(evalPredicate(otherWhere, rowB)).toBe(true);
    });
  });

  describe(`${name} visibility — owner UNKNOWN (fail closed)`, () => {
    const where = build({ workspaceId: WS_A });

    it("narrows to the run's own workspace", () => {
      expect(evalPredicate(where, rowA)).toBe(true);
      expect((where as any).col._t).toBe(table);
    });

    it("admits NO pod-wide row (no owner floor available → drop the branch)", () => {
      expect(evalPredicate(where, rowPodWide)).toBe(false);
    });

    it("admits no other workspace's rows", () => {
      expect(evalPredicate(where, rowB)).toBe(false);
    });
  });
}

/**
 * TRIPWIRE — `automation_step_runs` has NO visibility column of its own (no
 * `workspace_id`, no `user_id`; see schema/automations.ts). It is therefore only
 * ever safe to read as a CHILD of an already-authorized `automation_runs` row.
 *
 * `runs_query`'s `includeSteps` must fetch children BY THE IDS the visibility
 * predicate above already returned — never by a template-resolved run id. A
 * `WHERE run_id = {{trigger.payload.runId}}` would be a straight IDOR, since
 * that value is caller-supplied. The guard is STRUCTURAL (fetch parents, then
 * children by parent id), and this test pins that structure so a later "simplify"
 * cannot quietly reintroduce a caller-keyed child read.
 */
describe("runs_query includeSteps — step-runs are reachable ONLY via an authorized parent", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../automation-executor.ts"),
    "utf-8"
  );
  // The `executeRunsQueryStep` body: from its signature to the next top-level
  // `\n/**` doc block.
  const body = SRC.slice(
    SRC.indexOf("async function executeRunsQueryStep")
  ).split("\n/**")[0]!;

  it("selects step rows keyed by the ids of the runs already returned", () => {
    expect(body).toContain(".from(automationStepRuns)");
    expect(body).toContain(".where(inArray(automationStepRuns.runId, runIds))");
    // …and `runIds` is derived from the visibility-predicated `runs` result.
    expect(body).toContain("const runIds = runs.map((r) => r.id);");
  });

  it("never keys the child read off a single caller-supplied run id", () => {
    expect(body).not.toContain("eq(automationStepRuns.runId");
  });

  it("applies the ledger visibility predicate to the PARENT select", () => {
    expect(body).toContain(
      "runsQueryVisibilityWhere({ workspaceId, ownerId })"
    );
  });
});
