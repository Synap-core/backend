/**
 * The `how` hint of a capped reply must be TRUE: every parameter it tells the
 * caller to pass must exist in that tool's real `inputSchema`.
 *
 * WHY: an agent reported `synap_list_tracks` / `synap_list_agents` "take no
 * limit or offset" while `HOW_TO_NARROW` told it to page with them, and five
 * other list tools had no `offset` at all. The hint map and the schemas were
 * two hand-kept lists that drifted. This derives the check from the schema, so
 * a hint that names a parameter the tool lacks (or a schema edit that drops one
 * a hint relies on) turns red.
 */
import { describe, it, expect } from "vitest";
import { HOW_TO_NARROW } from "./reply-cap.js";
import { tools } from "./tools/index.js";

/** Reply fields a hint names (what to read back), not inputs. */
const REPLY_FIELDS = new Set(["nextOffset", "nextCursor"]);

/** Parameters a hint names: `backticked` words and `word:'value'` pairs. */
export function hintParams(hint: string): string[] {
  const found = new Set<string>();
  for (const m of hint.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)) found.add(m[1]!);
  for (const m of hint.matchAll(/\b([A-Za-z][A-Za-z0-9_]*):'/g))
    found.add(m[1]!);
  return [...found].filter((p) => !REPLY_FIELDS.has(p));
}

describe("HOW_TO_NARROW names only parameters the tool declares", () => {
  it("parses the hint grammar (non-vacuous)", () => {
    expect(
      hintParams(
        "Lower `limit`, page with `offset` (use `nextOffset`), detail:'lean'."
      )
    ).toEqual(["limit", "offset", "detail"]);
  });

  it("every named tool exists and every parameter in its hint is in its inputSchema", async () => {
    const list = await tools.list();
    const byName = new Map(list.map((t) => [t.name, t]));
    const problems: string[] = [];
    for (const [name, hint] of Object.entries(HOW_TO_NARROW)) {
      const def = byName.get(name);
      if (!def) {
        problems.push(`${name}: no such tool`);
        continue;
      }
      const props = Object.keys(
        (def.inputSchema as { properties?: Record<string, unknown> })
          .properties ?? {}
      );
      const params = hintParams(hint);
      expect(params.length, `${name} hint names no parameter`).toBeGreaterThan(
        0
      );
      for (const p of params) {
        if (!props.includes(p))
          problems.push(
            `${name}: hint names \`${p}\`, schema has [${props.join(", ")}]`
          );
      }
    }
    expect(problems).toEqual([]);
  });
});
