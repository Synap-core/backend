/**
 * PARITY: the owed-slot SQL (`owedSlotExistsIn`, every reaper + the needs-you
 * tray) answers exactly what the ONE deliverable rule answers —
 * `deliverableOwedBy(slot) === "you"` (`@synap-core/types/units`).
 *
 * BEHAVIOURAL, on PGlite: each fixture slot is run through the real rendered
 * SQL against a real Postgres, and through the real TypeScript rule.
 *
 * The rows are the inputs where naive spellings DISAGREE — each names what it
 * rules out:
 *   - `retiredAt: ""`   — `!retiredAt` (falsy) vs `IS NULL`: the pair split
 *                         the path row's tally from the tray's count once;
 *   - `status` absent / `null` — `->>'status' != 'done'` drops them (NULL);
 *   - `owner` absent    — `=== "agent"` / `!= 'human'` spellings disagree;
 *   - retired + human / retired + agent — retirement on one owner branch only;
 *   - JSON `false` / `0` stamps — a falsy test reads them as not retired.
 *   - a DECISION the person answered (`isDecidedByAnswer`): delivered only
 *     with a non-empty string `decisionId` AND an answer object whose
 *     `askSnapshot.mode` is confirm / choose, never on a criterion's grade
 *     slot. Each half missing is a row: a NULL in the SQL test must keep the
 *     slot owed, never drop it. A REFUSED decision (`answer.value.type`
 *     `declined`) is never decided, even with a `decisionId` (an ask opened
 *     for a decision carries one before anyone answers).
 *
 * The third block is a GRADE read in its session (work-model W5): a
 * criterion's grade slot naming the output it checks (`outputKey`) is owed
 * only once a slot of the same list with that stored `key` is delivered
 * (`isOwedByYouIn`). Each row is a whole `expected_outputs` list in which only
 * the grade can be owed, so "the list owes the person" IS the grade's answer.
 *
 * The SQL and the TypeScript rule cannot be one declaration (Postgres runs
 * the one, Node the other), which is why this parity test exists at all.
 *
 * The second block is the copy guard: no other pod source spells the
 * retirement clause (the blocked-slot scanner once carried its own copy of all
 * three clauses). Granularity: the `retiredAt` key in a `->>`/`->` SQL read —
 * a copy that spells only the other two clauses is NOT caught.
 *
 * WHAT THIS PROVES: SAMENESS of the SQL and the rule on these rows, never that
 * the rule is right. It does not cover the `jsonb_typeof` non-array guard (no
 * slot to compare) or `owedSlotOrder`'s ranking.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql as drizzleSql } from "drizzle-orm";
import { OWED_SLOT_CLAUSES, owedSlotExistsIn } from "./owed-slot-predicate.js";
import { deliverableOwedBy, isOwedByYouIn } from "@synap-core/types/units";

const STAMP = "2026-09-08T13:00:00.000Z";
/** An answer as the answer door stores it (trimmed to what the rule reads). */
const DECIDED_CHOOSE = {
  text: "EU account",
  askSnapshot: { mode: "choose", chosenKey: "eu" },
};
const DECIDED_CONFIRM = {
  text: "Yes",
  askSnapshot: { mode: "confirm", chosenKey: "yes" },
};
/** The person REFUSED the choose: an answer, never a decision. */
const REFUSED_CHOOSE = {
  text: "Refused: not this quarter",
  value: { type: "declined", reason: "not this quarter" },
  askSnapshot: { mode: "choose", chosenKey: null },
};

const ROWS: ReadonlyArray<{ rulesOut: string; slot: Record<string, unknown> }> =
  [
    { rulesOut: "!= 'done' on absent", slot: { owner: "human" } },
    {
      rulesOut: "!= 'done' on null",
      slot: { owner: "human", status: null },
    },
    {
      rulesOut: "=== 'pending' only",
      slot: { owner: "human", status: "in_progress" },
    },
    { rulesOut: "done still owed", slot: { owner: "human", status: "done" } },
    { rulesOut: "absent owner = human", slot: {} },
    { rulesOut: "agent = human", slot: { owner: "agent" } },
    {
      rulesOut: "retirement ignored",
      slot: { owner: "human", retiredAt: STAMP },
    },
    {
      rulesOut: "falsy retiredAt (empty stamp)",
      slot: { owner: "human", retiredAt: "" },
    },
    {
      rulesOut: "null stamp = retired",
      slot: { owner: "human", retiredAt: null },
    },
    {
      rulesOut: "falsy retiredAt (false)",
      slot: { owner: "human", retiredAt: false },
    },
    {
      rulesOut: "falsy retiredAt (0)",
      slot: { owner: "human", retiredAt: 0 },
    },
    {
      rulesOut: "retirement on the human branch only",
      slot: { owner: "agent", retiredAt: STAMP },
    },
    {
      rulesOut: "claim = delivered",
      slot: { owner: "human", claimedDone: true },
    },
    {
      rulesOut: "optional ignored (an unfilled optional slot reads owed)",
      slot: { owner: "human", optional: true },
    },
    {
      rulesOut: 'truthy optional (the string "false" lets go)',
      slot: { owner: "human", optional: "false" },
    },
    {
      rulesOut: "optional = false read as optional",
      slot: { owner: "human", optional: false },
    },
    {
      rulesOut: "an answered choose with its decision filed read as owed",
      slot: { owner: "human", decisionId: "d-1", answer: DECIDED_CHOOSE },
    },
    {
      rulesOut: "an answered confirm with its decision filed read as owed",
      slot: { owner: "human", decisionId: "d-1", answer: DECIDED_CONFIRM },
    },
    {
      rulesOut: "a refused choose with a decisionId read as decided",
      slot: { owner: "human", decisionId: "d-1", answer: REFUSED_CHOOSE },
    },
    {
      rulesOut: "a refused confirm with a decisionId read as decided",
      slot: {
        owner: "human",
        decisionId: "d-1",
        answer: {
          ...REFUSED_CHOOSE,
          askSnapshot: { mode: "confirm", chosenKey: null },
        },
      },
    },
    {
      rulesOut: "a value of another type read as a refusal",
      slot: {
        owner: "human",
        decisionId: "d-1",
        answer: { ...DECIDED_CHOOSE, value: { type: "chip" } },
      },
    },
    {
      rulesOut: "a decisionId alone read as decided (the ask is still open)",
      slot: { owner: "human", decisionId: "d-1" },
    },
    {
      rulesOut: "an answer alone read as decided (its filing failed)",
      slot: { owner: "human", answer: DECIDED_CHOOSE },
    },
    {
      rulesOut: "an empty decisionId read as a decision",
      slot: { owner: "human", decisionId: "", answer: DECIDED_CHOOSE },
    },
    {
      rulesOut: "a JSON null decisionId read as a decision",
      slot: { owner: "human", decisionId: null, answer: DECIDED_CHOOSE },
    },
    {
      rulesOut: "a non-string decisionId read as a decision",
      slot: { owner: "human", decisionId: 7, answer: DECIDED_CHOOSE },
    },
    {
      rulesOut: "a form answer read as a decision",
      slot: {
        owner: "human",
        decisionId: "d-1",
        answer: { text: "x", askSnapshot: { mode: "form" } },
      },
    },
    {
      rulesOut: "an answer with no ask snapshot read as a decision",
      slot: { owner: "human", decisionId: "d-1", answer: { text: "x" } },
    },
    {
      rulesOut: "a JSON null answer read as a decision",
      slot: { owner: "human", decisionId: "d-1", answer: null },
    },
    {
      rulesOut: "a criterion grade (kind) read as a decision",
      slot: {
        owner: "human",
        kind: "criterion",
        decisionId: "d-1",
        answer: DECIDED_CHOOSE,
      },
    },
    {
      rulesOut: "a criterion grade (criterionKey) read as a decision",
      slot: {
        owner: "human",
        criterionKey: "tests-pass",
        decisionId: "d-1",
        answer: DECIDED_CHOOSE,
      },
    },
    {
      rulesOut: "an empty criterionKey read as a criterion",
      slot: {
        owner: "human",
        criterionKey: "",
        decisionId: "d-1",
        answer: DECIDED_CHOOSE,
      },
    },
  ];

let client: PGlite;
const dialect = new PgDialect();

async function sqlOwed(slot: Record<string, unknown>): Promise<boolean> {
  const q = dialect.sqlToQuery(
    owedSlotExistsIn(drizzleSql`${JSON.stringify([slot])}::jsonb`)
  );
  const res = await client.query<{ owed: boolean }>(
    `select ${q.sql} as owed`,
    q.params as unknown[]
  );
  return res.rows[0]!.owed;
}

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("owed-slot SQL === deliverableOwedBy(slot) === 'you'", () => {
  it("non-vacuity: the table holds both answers and the clause set is real", async () => {
    expect(OWED_SLOT_CLAUSES.length).toBe(5);
    const answers = ROWS.map(
      (r) => deliverableOwedBy(r.slot as never) === "you"
    );
    expect(answers.filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(answers.filter((a) => !a).length).toBeGreaterThanOrEqual(5);
    // The SQL can still see a literal owed slot, and a literal non-owed one.
    expect(await sqlOwed({ owner: "human" })).toBe(true);
    expect(await sqlOwed({ owner: "agent" })).toBe(false);
  });

  it("a refused decision stays owed in the SQL itself, not only in parity", async () => {
    // Parity alone proves sameness: both sides reverted together would agree
    // on "decided". This pins the right answer on the SQL side.
    expect(
      await sqlOwed({
        owner: "human",
        decisionId: "d-1",
        answer: REFUSED_CHOOSE,
      })
    ).toBe(true);
    // …and a real decision still is not owed (the clause did not swallow it).
    expect(
      await sqlOwed({
        owner: "human",
        decisionId: "d-1",
        answer: DECIDED_CHOOSE,
      })
    ).toBe(false);
  });

  it("agrees on every discriminating row", async () => {
    for (const { rulesOut, slot } of ROWS) {
      expect({ rulesOut, slot, owed: await sqlOwed(slot) }).toEqual({
        rulesOut,
        slot,
        owed: deliverableOwedBy(slot as never) === "you",
      });
    }
  });
});

/** A grade slot as `fileCriterionSlot` files it, naming its output. */
const GRADE = {
  kind: "criterion",
  label: "Check: the copy reads well",
  criterionKey: "copy-reads-well",
  owner: "human",
  status: "pending",
  outputKey: "landing-copy",
};
/** The output it grades, the agent's, not yet delivered. */
const COPY = { key: "landing-copy", label: "Landing copy", owner: "agent" };

const GRADE_ROWS: ReadonlyArray<{
  rulesOut: string;
  slots: Array<Record<string, unknown>>;
}> = [
  {
    rulesOut: "a grade owed before its output is delivered",
    slots: [GRADE, COPY],
  },
  {
    rulesOut: "a grade kept waiting once its output is done",
    slots: [GRADE, { ...COPY, status: "done" }],
  },
  {
    rulesOut: "an output decided by the person's answer read as undelivered",
    slots: [
      GRADE,
      {
        ...COPY,
        owner: "human",
        decisionId: "d-1",
        answer: DECIDED_CHOOSE,
      },
    ],
  },
  {
    rulesOut: "an output with a REFUSED answer read as delivered",
    slots: [GRADE, { ...COPY, decisionId: "d-1", answer: REFUSED_CHOOSE }],
  },
  {
    rulesOut: "a grade with no outputKey held back (old data)",
    slots: [{ ...GRADE, outputKey: undefined }, COPY],
  },
  {
    rulesOut: "an empty outputKey read as naming an output",
    slots: [{ ...GRADE, outputKey: "" }, COPY],
  },
  {
    rulesOut: "a non-string outputKey matched as text",
    slots: [
      { ...GRADE, outputKey: 7 },
      { ...COPY, key: "7" },
    ],
  },
  {
    rulesOut: "a numeric output key matched as text",
    slots: [
      { ...GRADE, outputKey: "7" },
      { ...COPY, key: 7 },
    ],
  },
  {
    rulesOut: "a grade held back by an output nobody declared",
    slots: [{ ...GRADE, outputKey: "missing" }, COPY],
  },
  {
    rulesOut: "an output matched by label instead of its stored key",
    slots: [GRADE, { label: "landing-copy", owner: "agent" }],
  },
  {
    rulesOut: "a grade waiting on another grade",
    slots: [GRADE, { ...GRADE, key: "landing-copy", owner: "agent" }],
  },
  {
    rulesOut: "a non-grade slot held back by an outputKey",
    slots: [{ ...GRADE, kind: "text", criterionKey: undefined }, COPY],
  },
  {
    rulesOut: "a retired output read as delivered (the grade still waits)",
    slots: [GRADE, { ...COPY, retiredAt: STAMP }],
  },
  {
    rulesOut: "a done grade owed",
    slots: [
      { ...GRADE, status: "done" },
      { ...COPY, status: "done" },
    ],
  },
  {
    rulesOut: "a scalar in the list breaks the read",
    slots: [GRADE, "landing-copy", { ...COPY, status: "done" }],
  },
];

async function sqlListOwed(slots: unknown[]): Promise<boolean> {
  const q = dialect.sqlToQuery(
    owedSlotExistsIn(drizzleSql`${JSON.stringify(slots)}::jsonb`)
  );
  const res = await client.query<{ owed: boolean }>(
    `select ${q.sql} as owed`,
    q.params as unknown[]
  );
  return res.rows[0]!.owed;
}

const tsListOwed = (slots: unknown[]): boolean =>
  slots.some(
    (s) => !!s && typeof s === "object" && isOwedByYouIn(s as never, slots)
  );

describe("a criterion's grade is owed once its output is delivered", () => {
  it("SQL: not owed while the output is pending, owed once it is done", async () => {
    // Pins the right answer on the SQL side, not only sameness.
    expect(await sqlListOwed([GRADE, COPY])).toBe(false);
    expect(await sqlListOwed([GRADE, { ...COPY, status: "done" }])).toBe(true);
    // Old data: a grade naming no output is owed as before.
    expect(await sqlListOwed([{ ...GRADE, outputKey: undefined }, COPY])).toBe(
      true
    );
  });

  it("TS: the same three answers", () => {
    expect(tsListOwed([GRADE, COPY])).toBe(false);
    expect(tsListOwed([GRADE, { ...COPY, status: "done" }])).toBe(true);
    expect(tsListOwed([{ ...GRADE, outputKey: undefined }, COPY])).toBe(true);
  });

  it("agrees on every discriminating list", async () => {
    const answers = GRADE_ROWS.map((r) => tsListOwed(r.slots));
    expect(answers.filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(answers.filter((a) => !a).length).toBeGreaterThanOrEqual(3);
    for (const { rulesOut, slots } of GRADE_ROWS) {
      expect({ rulesOut, owed: await sqlListOwed(slots) }).toEqual({
        rulesOut,
        owed: tsListOwed(slots),
      });
    }
  });
});

describe("no second copy of the owed-slot clauses in pod source", () => {
  const PACKAGES = join(__dirname, "../../..");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === "node_modules" || e.name === "dist") return [];
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
    });

  it("only owed-slot-predicate.ts reads `retiredAt` in SQL", () => {
    const scanned = ["api", "jobs", "database"].flatMap((pkg) =>
      walk(join(PACKAGES, pkg, "src"))
    );
    expect(scanned.length).toBeGreaterThan(500); // non-vacuity
    const hits = scanned
      .filter((f) => /slot->>?'retiredAt'/.test(readFileSync(f, "utf8")))
      .map((f) => relative(PACKAGES, f));
    expect(hits).toEqual(["database/src/utils/owed-slot-predicate.ts"]);
  });
});
