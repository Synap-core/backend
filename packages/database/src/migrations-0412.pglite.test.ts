/**
 * REAL-POSTGRES (PGlite) test for migration 0412 — `subjectProfile.onEnd` is
 * retired (decision 5e377b06, plan 73fa04b5 D1):
 *   - it strips `onEnd` from a playbook's `subject_profile`, a move or `{}`,
 *     and keeps every other process key;
 *   - it strips it from the market baseline too, so live == baseline;
 *   - a playbook with no onEnd, or no subject, is left exactly as it was;
 *   - running it twice changes nothing more.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0412 = readFileSync(
  resolve(HERE, "../migrations/0412_playbook_on_end_retired.sql"),
  "utf8"
);

const MOVE = "11111111-1111-4111-8111-111111111111";
const EMPTY = "22222222-2222-4222-8222-222222222222";
const NONE = "33333333-3333-4333-8333-333333333333";
const NO_SUBJECT = "44444444-4444-4444-8444-444444444444";

const fixBug = {
  profileSlug: "issue",
  humanOnlyStatuses: ["wont_fix"],
  onEnd: { failed: "open", cancelled: "open" },
};

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    `CREATE TABLE "playbooks" ("id" uuid PRIMARY KEY, "subject_profile" jsonb, "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb);`
  );
  await pg.query(
    `INSERT INTO playbooks (id, subject_profile, metadata) VALUES
       ($1, $2::jsonb, $3::jsonb),
       ($4, '{"profileSlug":"post","onEnd":{}}'::jsonb, '{}'::jsonb),
       ($5, '{"profileSlug":"finding","statusProperty":"status"}'::jsonb, '{"marketSource":{"packageSlug":"x"}}'::jsonb),
       ($6, NULL, '{}'::jsonb)`,
    [
      MOVE,
      JSON.stringify(fixBug),
      JSON.stringify({
        marketSource: {
          packageSlug: "builder-workspace",
          baseline: { scope: "session", subjectProfile: fixBug },
        },
      }),
      EMPTY,
      NONE,
      NO_SUBJECT,
    ]
  );
  await pg.exec(M0412);
  await pg.exec(M0412);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

const row = async (id: string) =>
  (
    await pg.query<{ subject_profile: unknown; metadata: unknown }>(
      `SELECT subject_profile, metadata FROM playbooks WHERE id = $1`,
      [id]
    )
  ).rows[0];

describe("migration 0412 — subjectProfile.onEnd retired", () => {
  it("strips a declared move, keeps the other process keys, and strips the baseline's too", async () => {
    const r = await row(MOVE);
    expect(r?.subject_profile).toEqual({
      profileSlug: "issue",
      humanOnlyStatuses: ["wont_fix"],
    });
    expect(r?.metadata).toEqual({
      marketSource: {
        packageSlug: "builder-workspace",
        baseline: {
          scope: "session",
          subjectProfile: {
            profileSlug: "issue",
            humanOnlyStatuses: ["wont_fix"],
          },
        },
      },
    });
  });

  it("strips an empty onEnd too", async () => {
    expect((await row(EMPTY))?.subject_profile).toEqual({
      profileSlug: "post",
    });
  });

  it("leaves a playbook with no onEnd, or no subject, as it was", async () => {
    expect(await row(NONE)).toEqual({
      subject_profile: { profileSlug: "finding", statusProperty: "status" },
      metadata: { marketSource: { packageSlug: "x" } },
    });
    expect(await row(NO_SUBJECT)).toEqual({
      subject_profile: null,
      metadata: {},
    });
  });
});
