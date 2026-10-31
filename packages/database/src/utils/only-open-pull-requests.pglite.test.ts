/**
 * `onlyOpenPullRequestsWhere` (plan d679e92c C6), on PGlite: a session whose
 * ONLY outstanding outcomes are pull requests waits on a merge — the reaper
 * holds it instead of staling it, and never cancels it as abandoned.
 *
 * BEHAVIOURAL: each fixture list runs through the real rendered SQL against a
 * real Postgres and through a TypeScript reference built on THE deliverable
 * rule (`isDeliverableOutstanding`). Each row names what it rules out — the
 * inputs where plausible wrong spellings of "only open PRs" disagree:
 *   - empty list / everything done: "no non-PR outstanding" alone is vacuously
 *     true, so a missing EXISTS half would hold sessions that wait on nothing;
 *   - a second, non-PR outstanding slot: a missing NOT EXISTS half holds work
 *     that still has work;
 *   - a retired (`retiredAt: ""`), optional or done non-PR slot: they are not
 *     outstanding, so they must not cancel the hold;
 *   - a person-owned slot: outstanding (and owed), so not "only PRs";
 *   - a PR slot without a GitHub pull url: nothing to resume on.
 *
 * WHAT IT DOES NOT COVER: the `jsonb_typeof` non-array guard is checked once
 * (a JSON object), not every non-array shape.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql as drizzleSql } from "drizzle-orm";
import { isDeliverableOutstanding } from "@synap-core/types/units";
import {
  onlyOpenPullRequestsWhere,
  outstandingSlotExistsIn,
  PULL_REQUEST_URL_PATTERN,
} from "./owed-slot-predicate.js";

const PR = {
  kind: "pull_request",
  label: "backend#603",
  ref: { url: "https://github.com/Synap-core/backend/pull/603" },
};
const WORK = { kind: "code", label: "the fix" };

type Slot = Record<string, unknown>;

const ROWS: ReadonlyArray<{ rulesOut: string; slots: Slot[] }> = [
  { rulesOut: "vacuous truth on an empty list", slots: [] },
  { rulesOut: "an open PR alone is not held", slots: [PR] },
  {
    rulesOut: "vacuous truth when the PR is done",
    slots: [{ ...PR, status: "done" }],
  },
  { rulesOut: "other open work ignored", slots: [PR, WORK] },
  {
    rulesOut: "a done slot read as open",
    slots: [PR, { ...WORK, status: "done" }],
  },
  {
    rulesOut: "an empty retirement stamp read as open",
    slots: [PR, { ...WORK, retiredAt: "" }],
  },
  {
    rulesOut: "an optional slot read as owed",
    slots: [PR, { ...WORK, optional: true }],
  },
  {
    rulesOut: "a person's slot read as not outstanding",
    slots: [PR, { ...WORK, owner: "human" }],
  },
  {
    rulesOut: "a PR slot without a url held",
    slots: [{ kind: "pull_request", label: "pr" }],
  },
  {
    rulesOut: "any url taken for a pull request",
    slots: [{ ...PR, ref: { url: "https://github.com/Synap-core/backend" } }],
  },
  {
    rulesOut: "a non-pull_request kind with a PR url held",
    slots: [{ ...WORK, ref: PR.ref }],
  },
];

const PR_URL = new RegExp(PULL_REQUEST_URL_PATTERN);

/** The reference: THE deliverable rule, plus what a PR outcome is. */
function reference(slots: Slot[]): boolean {
  const open = slots.filter((s) => isDeliverableOutstanding(s as never));
  const isPr = (s: Slot) =>
    s.kind === "pull_request" &&
    typeof (s.ref as { url?: unknown } | undefined)?.url === "string" &&
    PR_URL.test((s.ref as { url: string }).url);
  return open.length > 0 && open.every(isPr);
}

let client: PGlite;
const dialect = new PgDialect();

async function ask(
  fragment: ReturnType<typeof onlyOpenPullRequestsWhere>
): Promise<boolean> {
  const q = dialect.sqlToQuery(fragment);
  const res = await client.query<{ v: boolean }>(
    `select ${q.sql} as v`,
    q.params as unknown[]
  );
  return res.rows[0]!.v;
}

const value = (v: unknown) => drizzleSql`${JSON.stringify(v)}::jsonb`;

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("onlyOpenPullRequestsWhere", () => {
  it("non-vacuity: the table holds both answers", () => {
    const answers = ROWS.map((r) => reference(r.slots));
    expect(answers.filter(Boolean).length).toBeGreaterThanOrEqual(4);
    expect(answers.filter((a) => !a).length).toBeGreaterThanOrEqual(5);
  });

  it("answers the reference on every discriminating row", async () => {
    for (const { rulesOut, slots } of ROWS) {
      expect({
        rulesOut,
        held: await ask(onlyOpenPullRequestsWhere(value(slots))),
      }).toEqual({ rulesOut, held: reference(slots) });
    }
  });

  it("a non-array value holds nothing (and does not throw)", async () => {
    expect(await ask(onlyOpenPullRequestsWhere(value({ a: 1 })))).toBe(false);
  });
});

describe("outstandingSlotExistsIn", () => {
  it("is THE deliverable rule, whoever owns the slot", async () => {
    for (const { rulesOut, slots } of ROWS) {
      expect({
        rulesOut,
        any: await ask(outstandingSlotExistsIn(value(slots))),
      }).toEqual({
        rulesOut,
        any: slots.some((s) => isDeliverableOutstanding(s as never)),
      });
    }
  });
});
