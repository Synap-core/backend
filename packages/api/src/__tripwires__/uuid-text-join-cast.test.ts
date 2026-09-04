import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TRIPWIRE — a uuid column never meets a text column without a cast.
 *
 * `focus_sessions.id` is `uuid`; `links.from_id` / `links.to_id` are `text`
 * (the links table is polymorphic). A PARAMETER coerces, so `inArray(id, [...])`
 * works and unit tests with mocked db never see the trap — but a column-to-
 * column join `eq(focusSessions.id, links.fromId)` is PG 42883 "operator does
 * not exist: uuid = text" and 500s the whole `focusSessions.list({edges})` door
 * in production (2026-09-05; same class as migration 0234). The honest join
 * casts the uuid side: `eq(drizzleSql\`${focusSessions.id}::text\`, links.fromId)`.
 */
const ROOT = join(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "__tripwires__")
      continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe("tripwire: uuid=text joins carry an explicit cast", () => {
  it("no bare eq(<uuidTable>.id, links.fromId|toId) join survives", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const src = readFileSync(file, "utf8");
      const m = src.match(
        /eq\(\s*(focusSessions|entities|projects|playbooks)\.id\s*,\s*links\.(fromId|toId)\s*\)/g
      );
      if (m) offenders.push(`${file.replace(ROOT, "")}: ${m.join(" | ")}`);
    }
    expect(offenders, "uncast uuid=text join(s)").toEqual([]);
  });
});
