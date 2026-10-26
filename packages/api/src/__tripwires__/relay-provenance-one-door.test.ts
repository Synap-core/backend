import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

/**
 * TRIPWIRE — a RELAYED answer has ONE writer, and only the person writes a tap
 * (Resolve-XP W1, pod doc 86890dee).
 *
 * The trust rule for relays is that the mark is honest: "relayed by Claude
 * Code" on every answer an agent carried, and a tap only when the person
 * tapped. Two ways to break it, one assertion each:
 *
 *   1. A second writer of `via: "relayed"` — a door that labels answers as
 *      relayed without the relay door's rules (exact address, the asker only,
 *      commitments held for the tap). Scanned over every package's source,
 *      DERIVED by walking `packages/*\/src`, so a new writer joins the scan by
 *      existing.
 *   2. An agent key reaching a tRPC door that writes the person's tap or
 *      hands their turn back: `answerOutput` (which also takes the Confirm of
 *      a relay) and `unblockOutput` must each refuse `ctx.agentUserId` BEFORE
 *      their service call. The Hub twins are pinned BEHAVIOURALLY in
 *      `services/focus-sessions/__tests__/relay-answer.pglite.test.ts`.
 *
 * DOES NOT COVER, stated: (1) sees the literal `via: "relayed"` (either
 * quote), not a value computed at runtime (`via: someVar`); (2) is a source
 * order check inside one procedure body — it proves the refusal is written
 * before the call, not that every branch reaches it.
 */

const API_SRC = resolve(__dirname, "..");
const PACKAGES = resolve(API_SRC, "../..");
const RELAY_DOOR = "api/src/services/focus-sessions/session-answer.ts";
const RELAYED_LITERAL = /\bvia:\s*["']relayed["']/;

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (
      e.name.endsWith(".ts") &&
      !e.name.endsWith(".d.ts") &&
      !/\.(test|spec)\.ts$/.test(e.name) &&
      !p.includes("__tests__") &&
      !p.includes("__tripwires__")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

const SOURCES = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => walk(join(PACKAGES, d.name, "src")));

describe("tripwire: relay provenance has one door", () => {
  it("the scan sees the whole backend, and can see the literal it hunts", () => {
    expect(SOURCES.length).toBeGreaterThan(1000);
    const door = SOURCES.find((f) => relative(PACKAGES, f) === RELAY_DOOR);
    expect(door, "the relay door moved — update RELAY_DOOR").toBeDefined();
    expect(RELAYED_LITERAL.test(stripComments(readFileSync(door!, "utf8")))).toBe(
      true
    );
    // Self-check on a sample: both quote styles.
    expect(RELAYED_LITERAL.test(`{ via: 'relayed' }`)).toBe(true);
  });

  it('only the relay door writes `via: "relayed"`', () => {
    const writers = SOURCES.filter((f) =>
      RELAYED_LITERAL.test(stripComments(readFileSync(f, "utf8")))
    ).map((f) => relative(PACKAGES, f));
    expect(writers).toEqual([RELAY_DOOR]);
  });

  it("the tRPC tap doors refuse an agent key before they write", () => {
    const router = stripComments(
      readFileSync(join(API_SRC, "routers/focus-sessions.ts"), "utf8")
    );
    for (const [procedure, call] of [
      ["answerOutput", "answerSessionSlot("],
      ["unblockOutput", "unblockExpectedOutput("],
    ] as const) {
      const start = router.indexOf(`  ${procedure}: protectedProcedure`);
      expect(start, `${procedure} not found`).toBeGreaterThan(-1);
      // The procedure body runs to the next procedure at the same indent.
      const rest = router.slice(start + 1);
      const next = rest.search(/\n {2}[A-Za-z]+: (protected|public)Procedure/);
      const body = next === -1 ? rest : rest.slice(0, next);
      const refusal = body.search(/if \(ctx\.agentUserId\)\s*\{\s*throw/);
      const write = body.indexOf(call);
      expect(write, `${procedure} no longer calls ${call}`).toBeGreaterThan(-1);
      expect(
        refusal,
        `${procedure} must refuse an agent key before ${call}`
      ).toBeGreaterThan(-1);
      expect(refusal).toBeLessThan(write);
    }
  });
});
