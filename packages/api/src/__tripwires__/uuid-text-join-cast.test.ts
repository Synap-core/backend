import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — a Drizzle join must never compare a `uuid` column directly
 * against `links.toId`/`links.fromId` (both `text`).
 *
 * `links.fromId`/`links.toId` are `text` columns (polymorphic FK — they hold
 * ids from many tables of different PK types). Several tables' primary/foreign
 * keys are `uuid`. Postgres has NO implicit `uuid = text` operator, so
 * `eq(someUuidColumn, links.toId)` compiles fine, typechecks fine, and passes
 * tests that don't seed the triggering row — then crashes LIVE with
 * SQLSTATE 42883 `operator does not exist: uuid = text`.
 *
 * THE BUG (found 2026-07-26): `capability-registry.ts` joined
 * `secrets.capabilityId` (uuid) against `links.toId` (text) with a bare `eq`.
 * It had a SWALLOWED TWIN in `is-agent-executor.ts` joining `skills.id` (uuid)
 * against `links.toId` the same way — same class, different door, silent
 * because the surrounding code caught and logged the throw instead of
 * surfacing it. Both are fixed by casting the uuid side: `eq(sql\`${col}::text\`, links.toId)`.
 *
 * This tripwire:
 *  (a) pins the two known fixed sites to keep their `::text` cast, and
 *  (b) greps the wider `api` source for the same bare-mismatch SHAPE against
 *      a curated list of tables known to have `uuid` PK/FK columns that get
 *      joined against `links`, so a new instance of the same bug (not just a
 *      regression at the two known sites) fails CI before it reaches prod.
 *
 * HONEST LIMITATION: this is a text/regex regression guard, not a type
 * checker. It only catches the exact shape `eq(<table>.<col>, links.toId|fromId)`
 * for the tables listed in `KNOWN_UUID_TABLES` below. A join against a table
 * not in that list, a join written with the table/column order swapped, or a
 * join going through a `.select()`-derived row alias (e.g. `cap.id` — a plain
 * JS value, not a Drizzle column, so it's safely parameterized and NOT part
 * of this bug class) will not be seen. Extend `KNOWN_UUID_TABLES` as new
 * uuid-keyed tables get joined against `links`.
 */

const ROOT = join(process.cwd(), "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tripwires__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// Drizzle table export names (as imported from @synap/database) known to have
// a `uuid` primary/foreign key that has been, or plausibly could be, joined
// directly against the polymorphic `links.toId` / `links.fromId` (both text).
const KNOWN_UUID_TABLES = [
  "secrets",
  "skills",
  "capabilities",
  "automations",
  "agents",
  "documents",
  "entities",
  "tools",
  "workspaces",
  "channels",
  "sessions",
  "artifacts",
];

// `eq(<table>.<col>, links.toId)` / `eq(<table>.<col>, links.fromId)` with NO
// `::text` cast anywhere on the line — the exact shape that crashed live.
const BARE_MISMATCH = new RegExp(
  `eq\\(\\s*(${KNOWN_UUID_TABLES.join("|")})\\.\\w+\\s*,\\s*links\\.(toId|fromId)\\s*\\)`
);

describe("tripwire: uuid columns must be ::text-cast before joining against links.toId/fromId", () => {
  const capabilityRegistryPath =
    "src/services/capabilities/capability-registry.ts";
  const isAgentExecutorPath =
    "src/services/playbooks/executors/is-agent-executor.ts";

  it("capability-registry.ts casts secrets.capabilityId to ::text before joining links.toId", () => {
    const src = readFileSync(
      join(process.cwd(), capabilityRegistryPath),
      "utf8"
    );
    expect(
      src,
      "the original crash: eq(secrets.capabilityId /*uuid*/, links.toId /*text*/) → " +
        "SQLSTATE 42883. The fix casts the uuid side to ::text — don't drop it."
    ).toMatch(/secrets\.capabilityId\}::text`?\s*,\s*links\.toId\)/);
  });

  it("is-agent-executor.ts casts skills.id to ::text before joining links.toId", () => {
    const src = readFileSync(join(process.cwd(), isAgentExecutorPath), "utf8");
    expect(
      src,
      "the swallowed twin of the capability-registry crash: eq(skills.id /*uuid*/, " +
        "links.toId /*text*/) threw the same SQLSTATE 42883, but the throw was caught " +
        "and logged instead of surfacing. Keep the ::text cast."
    ).toMatch(/skills\.id\}::text`?\s*,\s*links\.toId\)/);
  });

  it("no source file introduces a new bare uuid-vs-links.{toId,fromId} join", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(ROOT)) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (BARE_MISMATCH.test(line) && !line.includes("::text")) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "found a bare `eq(<uuid column>, links.toId|fromId)` join with no ::text cast. " +
        "Postgres has no uuid = text operator (SQLSTATE 42883) — cast the uuid side: " +
        "eq(sql`${table.column}::text`, links.toId)."
    ).toEqual([]);
  });
});
