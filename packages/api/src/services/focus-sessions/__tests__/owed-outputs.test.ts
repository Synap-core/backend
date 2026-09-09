/**
 * The owed-slot read — its predicate, its twin, and its retirement stamp.
 *
 * The defect these guard against is a read that ships GREEN and EMPTY: `status`
 * is absent on most owed slots, so the natural spellings of "not done" evaluate
 * to Unknown on a missing key and drop the row. Half the results vanish with no
 * error anywhere. Both halves of the predicate — the SQL and its TypeScript
 * twin — are tested for exactly that case.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  OWED_SLOT_CLAUSES,
  isOwedSlot,
  MISSING_OWED_SINCE,
  owedSlotOrder,
  owedSlotWhere,
  projectOwedSlots,
  retirementForClose,
  stampRetired,
} from "../owed-outputs.js";

const OWED: ExpectedOutput = {
  kind: "credential",
  label: "Stripe live key",
  owner: "human",
  blockedReason: "credential",
  why: "The restricted key for the live account",
  owedSince: "2026-09-01T09:00:00.000Z",
};

describe("isOwedSlot — the TypeScript twin", () => {
  it("counts a slot with NO `status` key — the majority case on the live pod", () => {
    expect(OWED.status).toBeUndefined();
    expect(isOwedSlot(OWED)).toBe(true);
  });

  it("counts an explicitly pending slot", () => {
    expect(isOwedSlot({ ...OWED, status: "pending" })).toBe(true);
  });

  it("drops a delivered slot", () => {
    expect(isOwedSlot({ ...OWED, status: "done" })).toBe(false);
  });

  it("drops an agent-owned slot — absent `owner` means agent", () => {
    const { owner: _o, ...agentOwned } = OWED;
    expect(isOwedSlot(agentOwned as ExpectedOutput)).toBe(false);
    expect(isOwedSlot({ ...OWED, owner: "agent" })).toBe(false);
  });

  it("drops a RETIRED slot — the cancelled-session receipt", () => {
    expect(
      isOwedSlot({
        ...OWED,
        retiredAt: "2026-09-08T13:00:00.000Z",
        retiredReason: "session_cancelled",
      })
    ).toBe(false);
  });

  it("still counts a slot the agent merely CLAIMED it did", () => {
    // A claim is evidence to show the human, never proof — the slot is owed
    // until the human says otherwise.
    expect(isOwedSlot({ ...OWED, claimedDone: true })).toBe(true);
  });
});

describe("owedSlotWhere — the SQL half", () => {
  /**
   * A SOURCE-shaped assertion, deliberately: the trap is a single operator, and
   * there is no local postgres in this suite to run the query against. `!=` and
   * `<>` both yield NULL on a missing key, so the row is rejected and half the
   * owed slots disappear with no error. `IS DISTINCT FROM` is the operator that
   * means what it says.
   */
  const sql = new PgDialect().sqlToQuery(owedSlotWhere()).sql;

  it("tests `status` with IS DISTINCT FROM, never a plain inequality", () => {
    expect(sql).toContain("IS DISTINCT FROM");
    expect(sql).not.toMatch(/!=\s*.?'?done/);
    expect(sql).not.toMatch(/<>\s*.?'?done/);
  });

  it("matches `owner` positively — it is always written explicitly", () => {
    expect(sql).toContain("'human'");
  });

  it("guards jsonb_array_elements against a non-array value", () => {
    // `jsonb_array_elements` ERRORS on a scalar, and `expected_outputs` is
    // untyped JSONB a legacy row can hold anything in.
    expect(sql).toContain("jsonb_typeof");
  });
});

describe("owedSlotOrder — the SQL ordering must agree with the TS sort", () => {
  /**
   * THE BUG. `min()` skips NULLs. A session with one UNSTAMPED owed slot and one
   * stamped `2026-09-01` therefore ranked by September, while `projectOwedSlots`
   * substitutes `MISSING_OWED_SINCE` and the TypeScript sort puts that same slot
   * FIRST of everything. This ORDER BY decides which rows survive `.limit()`, so
   * the disagreement could drop the globally-oldest slot off the page silently.
   *
   * Source-shaped for the same reason the `owedSlotWhere` block above is: no
   * local postgres in this suite. What it CANNOT see is whether postgres agrees
   * that the sentinel sorts below every ISO stamp — that is a property of the
   * text collation, asserted in TypeScript below instead.
   */
  const sql = new PgDialect().sqlToQuery(owedSlotOrder()).sql;

  it("substitutes the sentinel rather than letting min() skip NULLs", () => {
    expect(sql).toContain("coalesce");
    expect(sql).toMatch(/min\(coalesce\(slot->>'owedSince'/);
  });

  it("binds the SAME sentinel `projectOwedSlots` substitutes", () => {
    const { params } = new PgDialect().sqlToQuery(owedSlotOrder());
    expect(params).toContain(MISSING_OWED_SINCE);
  });

  it("shares the owed predicate with the WHERE clause, verbatim", () => {
    // Ordering on a different population than you filtered on is its own bug.
    const where = new PgDialect().sqlToQuery(owedSlotWhere()).sql;
    for (const clause of [
      "slot->>'owner' = 'human'",
      "slot->>'status' IS DISTINCT FROM 'done'",
      "slot->>'retiredAt' IS NULL",
    ]) {
      expect(where).toContain(clause);
      expect(sql).toContain(clause);
    }
  });

  it("the sentinel sorts BEFORE every real stamp", () => {
    // The property both orderings depend on, in the comparison the TS sort uses.
    expect(MISSING_OWED_SINCE < "1970-01-01T00:00:00.000Z").toBe(true);
    expect(MISSING_OWED_SINCE < "2026-09-01T09:00:00.000Z").toBe(true);
  });
});

describe("projectOwedSlots — flattening a session's array", () => {
  const row = {
    id: "11111111-1111-1111-1111-111111111111",
    goal: "Ship the billing cutover",
    status: "closed",
    workspaceId: "22222222-2222-2222-2222-222222222222",
    projectId: null,
    expectedOutputs: [
      OWED,
      { kind: "doc", label: "Runbook" },
      { ...OWED, label: "Signed DPA", status: "done" as const },
    ],
  };

  it("returns only the owed slots, carrying the session that names them", () => {
    const slots = projectOwedSlots(row);
    expect(slots.map((s) => s.label)).toEqual(["Stripe live key"]);
    expect(slots[0]).toMatchObject({
      sessionId: row.id,
      sessionGoal: "Ship the billing cutover",
      // A slot OUTLIVES its session — this one is owed on a CLOSED session,
      // which is the population `list` could never reach.
      sessionStatus: "closed",
      blockedReason: "credential",
      owedSince: "2026-09-01T09:00:00.000Z",
    });
  });

  it("survives a non-array `expected_outputs`", () => {
    expect(projectOwedSlots({ ...row, expectedOutputs: null })).toEqual([]);
    expect(projectOwedSlots({ ...row, expectedOutputs: "nope" })).toEqual([]);
  });

  it("sorts an unstamped slot to the TOP rather than hiding or burying it", () => {
    const { owedSince: _drop, ...unstamped } = OWED;
    const [slot] = projectOwedSlots({
      ...row,
      expectedOutputs: [{ ...unstamped, label: "Anomaly" }],
    });
    // Not "now" — that would bury the oldest work behind an anomaly.
    expect(slot!.owedSince < "2026-09-01T09:00:00.000Z").toBe(true);
  });
});

describe("stampRetired — the cancelled-session receipt", () => {
  const outputs: ExpectedOutput[] = [
    OWED,
    { kind: "doc", label: "Runbook" },
    { ...OWED, label: "Signed DPA", status: "done" },
  ];

  it("stamps the owed slots and NEVER deletes one", () => {
    const next = stampRetired(outputs, "session_cancelled");
    expect(next).toHaveLength(outputs.length);
    expect(next[0]).toMatchObject({
      retiredReason: "session_cancelled",
      // The receipt is additive: the blocker, the why and the clock all remain.
      blockedReason: "credential",
      owedSince: "2026-09-01T09:00:00.000Z",
      owner: "human",
    });
    expect(next[0]!.retiredAt).toEqual(expect.any(String));
  });

  it("leaves agent-owned and already-delivered slots untouched", () => {
    const next = stampRetired(outputs, "session_cancelled");
    expect(next[1]).toEqual(outputs[1]);
    expect(next[2]).toEqual(outputs[2]);
  });

  it("makes the slot stop being owed — the point of the stamp", () => {
    const [retired] = stampRetired([OWED], "session_cancelled");
    expect(isOwedSlot(retired!)).toBe(false);
    // Reversible in the way a delete is not: clear the receipt, it is owed again.
    const { retiredAt: _a, retiredReason: _r, ...restored } = retired!;
    expect(isOwedSlot(restored as ExpectedOutput)).toBe(true);
  });
});

describe("retirementForClose — which exit ends the obligation", () => {
  const outputs: ExpectedOutput[] = [OWED, { kind: "doc", label: "Runbook" }];

  it("CANCELLED retires the owed slots and reports how many", () => {
    const result = retirementForClose(outputs, "cancelled");
    expect(result?.retiredSlots).toBe(1);
    expect(isOwedSlot(result!.outputs[0]!)).toBe(false);
  });

  it("CLOSED leaves them owed — the work outlives the session", () => {
    expect(retirementForClose(outputs, "closed")).toBeNull();
    expect(isOwedSlot(outputs[0]!)).toBe(true);
  });

  it("FAILED leaves them owed too", () => {
    expect(retirementForClose(outputs, "failed")).toBeNull();
  });

  it("is a no-op when nothing was owed", () => {
    expect(
      retirementForClose([{ kind: "doc", label: "Runbook" }], "cancelled")
    ).toBeNull();
  });
});

/**
 * THE PREDICATE IS A SET, AND THE SET IS WHAT IS GUARDED.
 *
 * The suite above asserts membership — `toContain("IS DISTINCT FROM")`, and two
 * negatives for `!=` / `<>`. Membership cannot see an ADDED clause. Verified by
 * mutation: appending `AND slot->>'kind' = 'doc'` to both SQL builders narrowed
 * the pod-wide "blocked on you" read to documents only — hiding every other
 * blocked slot from the one screen built to show them — and all 23 tests stayed
 * GREEN. The mutation was confirmed present in the file before the run.
 *
 * Two assertions close it, and they fail for different reasons on purpose: the
 * COUNT catches a clause added to the rendered SQL, and the FIELD PARITY catches
 * the SQL and its TypeScript twin drifting apart — which no assertion anywhere
 * previously compared, though the file's own docblock says they "cannot drift"
 * because they sit side by side. Adjacency is not a guard.
 */
describe("the owed predicate is a SET, not three strings that happen to appear", () => {
  /**
   * Only the PREDICATE half. `owedSlotOrder` also reads `owedSince` inside its
   * `min(coalesce(...))` — that is the sort key, not a filter, and folding it in
   * made this guard fail on correct code the first time it ran. Slicing at
   * `WHERE` is what separates "which slots count" from "how they are ranked".
   */
  const predicateOf = (rendered: string): string => {
    const at = rendered.indexOf("WHERE");
    expect(at, "every builder must have a WHERE to slice at").toBeGreaterThan(
      -1
    );
    return rendered.slice(at);
  };

  const whereSql = predicateOf(new PgDialect().sqlToQuery(owedSlotWhere()).sql);
  const orderSql = predicateOf(new PgDialect().sqlToQuery(owedSlotOrder()).sql);

  /** Every `slot->>'x'` key named in a blob of SQL. */
  const keysIn = (text: string): Set<string> =>
    new Set([...text.matchAll(/slot->>'([A-Za-z]+)'/g)].map((m) => m[1]));

  it("the constant is not vacuous and names the fields the rule is about", () => {
    expect(OWED_SLOT_CLAUSES.length).toBe(3);
    expect(keysIn(OWED_SLOT_CLAUSES.join(" "))).toEqual(
      new Set(["owner", "status", "retiredAt"])
    );
  });

  it("both builders carry EXACTLY these clauses — a fourth fails here", () => {
    // Counting the keys, not the string, so reformatting the SQL cannot break
    // this while adding a clause still does.
    for (const [label, rendered] of [
      ["WHERE", whereSql],
      ["ORDER BY", orderSql],
    ] as const) {
      expect(
        keysIn(rendered),
        `${label} must test exactly the owed-slot fields`
      ).toEqual(keysIn(OWED_SLOT_CLAUSES.join(" ")));
    }
  });

  it("the SQL and its TypeScript twin read the SAME fields", () => {
    // `isOwedSlot` is the twin the file's docblock promises cannot drift. This
    // is what makes that true: the fields it reads are parsed out of its own
    // source and compared to the clause set.
    const src = readFileSync(join(__dirname, "../owed-outputs.ts"), "utf8");
    const body = src.slice(src.indexOf("export function isOwedSlot"));
    const twinKeys = new Set(
      [...body.slice(0, body.indexOf("}")).matchAll(/slot\.([A-Za-z]+)/g)].map(
        (m) => m[1]
      )
    );
    // Non-vacuity: a parse that found nothing would make the comparison pass
    // against an equally empty set on a bad regex.
    expect(twinKeys.size).toBe(3);
    expect(twinKeys).toEqual(keysIn(OWED_SLOT_CLAUSES.join(" ")));
  });
});
