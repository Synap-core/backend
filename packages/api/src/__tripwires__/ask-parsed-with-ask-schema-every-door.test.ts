/**
 * TRIPWIRE — every wire door that accepts an `ask` parses it with the ONE ask
 * schema (`AskSchema`, `@synap-core/types/ask`).
 *
 * The defect this exists for: the Hub REST block door
 * (`POST /focus-sessions/:id/outputs/block`) typed its `ask` as
 * `z.custom<Ask>()`, which accepts any value. Every floor `AskSchema` holds was
 * skipped on that one door: credential form fields (a masked "Re-enter your
 * password" prompt), http(s)-only act urls, the closed set of modes, ≤1
 * recommended option, ≤8 `{kind, id}` looked-at refs. The service behind it
 * assumes the door already parsed.
 *
 * THE SCAN, over every non-test source file under `src/` (comments stripped):
 *   1. `z.custom<Ask>()` / `z.custom<SlotAsk>()` only names a type. It is
 *      allowed only when piped straight into `AskSchema`.
 *   2. A schema key `ask:` takes one of the accepted parsers (`AskSchema`, the
 *      piped `askWireSchema`, or `expectedOutputWireSchema.shape.ask`). Any other
 *      zod expression on an `ask` key (`z.custom`, `z.any`, `z.unknown`, a local
 *      `z.object`) fails.
 *   3. An MCP handler that reads `args.ask` parses it with `AskSchema`.
 * The known doors are listed so the scan cannot pass by seeing nothing.
 *
 * WHAT THIS DOES NOT SEE, stated: a door that reads an ask from an untyped
 * body (`body.ask`) and stores it without any schema key is invisible to rule
 * 2. The services behind the doors never parse again.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const API_SRC = join(__dirname, "..");

const CUSTOM_ASK = /\bz\.custom<\s*(?:Ask|SlotAsk)\s*>\s*\(\s*\)/g;
const PIPED_INTO_ASK_SCHEMA = /^\s*\.pipe\(\s*AskSchema\s*\)/;
const ASK_KEY = /(?<![\w.])ask\s*:\s*(z\.[\w]+|[A-Za-z_][\w.]*)/g;
const ACCEPTED_ASK_PARSERS = new Set([
  "AskSchema",
  "askWireSchema",
  "expectedOutputWireSchema.shape.ask",
]);
const MCP_READS_ASK = /\bargs\.ask\b/;
const MCP_PARSES_ASK = /\bAskSchema\.(?:safeParse|parse)\(\s*args\.ask\s*\)/;

/** Every wire door known to take an `ask`, and the parse it must carry. */
const KNOWN_DOORS: Record<string, RegExp> = {
  // tRPC `update` / `create` slots and `blockOutput`.
  "routers/focus-sessions.ts": /ask\s*:\s*expectedOutputWireSchema\.shape\.ask/,
  // Hub REST slots (`ExpectedOutputItemSchema`) and the block door.
  "routers/hub-protocol/rest/focus-sessions.ts":
    /ask\s*:\s*expectedOutputWireSchema\.shape\.ask/,
  // Hub REST thread post (a question filed on a slot).
  "routers/hub-protocol/rest/_codecs/thread.ts": /ask\s*:\s*AskSchema\b/,
  // MCP post_message (room question).
  "routers/mcp/handlers/build.ts": MCP_PARSES_ASK,
  // MCP start_session / update_session (`parseSlotInputs`).
  "routers/mcp/handlers/session.ts": /expectedOutputWireSchema\.parse\(/,
  // Proposal executor (an approved slot patch).
  "routers/proposals/executors/focus-session.ts":
    /\.array\(\s*expectedOutputWireSchema\s*\)/,
  // Outcome declarations.
  "services/focus-sessions/outcome-declarations.ts":
    /ask\s*:\s*expectedOutputWireSchema\.shape\.ask/,
  // The slot wire schema itself.
  "services/focus-sessions/update-session.ts":
    /z\.custom<Ask>\(\)\.pipe\(AskSchema\)/,
  // Playbook definitions and stages (authored slots).
  "schemas/playbook-definition.ts": /ask\s*:\s*AskSchema\b/,
  "schemas/playbook-stage.ts": /ask\s*:\s*AskSchema\b/,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (
        name === "node_modules" ||
        name === "dist" ||
        name === "__tests__" ||
        name === "__tripwires__"
      )
        continue;
      walk(p, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(API_SRC).map((abs) => ({
  rel: relative(API_SRC, abs),
  code: stripComments(readFileSync(abs, "utf8"), "ts"),
}));

function unpipedCustomAsks(code: string): number {
  let n = 0;
  for (const m of code.matchAll(CUSTOM_ASK)) {
    const after = code.slice(m.index! + m[0].length);
    if (!PIPED_INTO_ASK_SCHEMA.test(after)) n++;
  }
  return n;
}

function badAskKeys(code: string): string[] {
  const bad: string[] = [];
  for (const m of code.matchAll(ASK_KEY)) {
    const value = m[1]!;
    const accepted = [...ACCEPTED_ASK_PARSERS].some(
      (p) => value === p || value.startsWith(`${p}.`)
    );
    if (value.startsWith("z.")) bad.push(value);
    else if (/Schema\b/.test(value) && !accepted) bad.push(value);
  }
  return bad;
}

describe("ask — every wire door parses it with AskSchema", () => {
  it("the scan can still see what it hunts (self-check)", () => {
    // The exact line the Hub block door carried before the fix.
    expect(
      unpipedCustomAsks("ask: z.custom<Ask>().nullable().optional(),")
    ).toBe(1);
    expect(badAskKeys("ask: z.custom<Ask>().nullable().optional(),")).toEqual([
      "z.custom",
    ]);
    expect(badAskKeys("  ask: z.unknown(),")).toEqual(["z.unknown"]);
    expect(badAskKeys("ask: LocalAskSchema.optional(),")).toEqual([
      "LocalAskSchema.optional",
    ]);
    expect(unpipedCustomAsks("z.custom<Ask>().pipe(AskSchema)")).toBe(0);
    expect(badAskKeys("ask: expectedOutputWireSchema.shape.ask,")).toEqual([]);
    expect(badAskKeys("ask: AskSchema.nullable().optional(),")).toEqual([]);
    // Data, not a schema: `ask: input.ask` passes a parsed value along.
    expect(badAskKeys("ask: input.ask,")).toEqual([]);
    expect(MCP_PARSES_ASK.test("AskSchema.safeParse(args.ask)")).toBe(true);
  });

  it("every known door is still found, with its parse", () => {
    const byRel = new Map(files.map((f) => [f.rel, f.code]));
    const missing = Object.entries(KNOWN_DOORS)
      .filter(([rel, parse]) => !parse.test(byRel.get(rel) ?? ""))
      .map(([rel]) => rel);
    expect(missing).toEqual([]);
  });

  it("no z.custom<Ask>() stands alone (it checks nothing)", () => {
    const offenders = files
      .filter((f) => unpipedCustomAsks(f.code) > 0)
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("no ask key takes a parser other than AskSchema", () => {
    const offenders = files
      .map((f) => ({ rel: f.rel, bad: badAskKeys(f.code) }))
      .filter((f) => f.bad.length > 0);
    expect(offenders).toEqual([]);
  });

  it("every MCP handler that reads args.ask parses it with AskSchema", () => {
    const offenders = files
      .filter(
        (f) =>
          f.rel.startsWith("routers/mcp/") &&
          MCP_READS_ASK.test(f.code) &&
          !MCP_PARSES_ASK.test(f.code)
      )
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
