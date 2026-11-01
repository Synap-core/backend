/**
 * TRIPWIRE — every wire door that accepts an `ask` parses it with the ONE ask
 * schema (`AskSchema`, `@synap-core/types/ask`), directly or through the slot
 * wire's `expectedOutputWireSchema`.
 *
 * The defect this exists for: the Hub REST block door
 * (`POST /focus-sessions/:id/outputs/block`) typed its `ask` as
 * `z.custom<Ask>()`, which accepts any value. Every floor `AskSchema` holds was
 * skipped on that one door: credential form fields (a masked "Re-enter your
 * password" prompt), http(s)-only act urls, the closed set of modes, ≤1
 * recommended option, ≤8 `{kind, id}` looked-at refs. The service behind it
 * assumes the door already parsed. Main's door parses with `AskSchema` today
 * (`routers/hub-protocol/rest/focus-sessions.ts`); this keeps every door so.
 *
 * THE SCAN, over every non-test source file under `src/` (derived by walking
 * the tree, never a hand list; comments stripped):
 *   1. `z.custom<Ask>()` / `z.custom<SlotAsk>()` only names a type. It is
 *      allowed only when piped straight into `AskSchema`.
 *   2. A schema key `ask:` takes one of the accepted parsers (`AskSchema`, the
 *      piped `askWireSchema`, or `expectedOutputWireSchema.shape.ask`). Any other
 *      zod expression on an `ask` key (`z.custom`, `z.any`, `z.unknown`, a local
 *      `z.object`) or another `…Schema` fails.
 *   3. An MCP handler that reads `args.ask` parses it with `AskSchema`.
 *
 * NON-VACUITY, derived: the doors are the files the scan finds an ask parse in
 * (rule 2's schema keys, rule 3's MCP reads). The scan must find doors on each
 * of the pod's three wire protocols (tRPC routers, Hub REST, MCP), so a scan
 * that silently sees nothing (a moved tree, a regex that no longer matches)
 * fails instead of passing.
 *
 * WHAT THIS DOES NOT SEE, stated: a door that reads an ask from an untyped
 * body (`body.ask`) and stores it without any schema key is invisible to rule
 * 2. The services behind the doors never parse again.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const API_SRC = join(__dirname, "..");

const CUSTOM_ASK = /\bz\.custom<\s*(?:Ask|SlotAsk)\s*>\s*\(\s*\)/g;
const PIPED_INTO_ASK_SCHEMA = /^\s*\.pipe\(\s*AskSchema\s*\)/;
const ASK_KEY = /(?<![\w.])ask\s*:\s*(z\.[\w]+|[A-Za-z_][\w.]*)/g;
const ACCEPTED_ASK_PARSERS = [
  "AskSchema",
  "askWireSchema",
  "expectedOutputWireSchema.shape.ask",
];
const MCP_READS_ASK = /\bargs\.ask\b/;
const MCP_PARSES_ASK = /\bAskSchema\.(?:safeParse|parse)\(\s*args\.ask\s*\)/;

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
  rel: relative(API_SRC, abs).split(sep).join("/"),
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

const isAccepted = (value: string) =>
  ACCEPTED_ASK_PARSERS.some((p) => value === p || value.startsWith(`${p}.`));

/** The parser expressions on `ask:` keys: zod calls and schemas, not data. */
function askKeyParsers(code: string): string[] {
  const parsers: string[] = [];
  for (const m of code.matchAll(ASK_KEY)) {
    const value = m[1]!;
    if (value.startsWith("z.") || /Schema\b/.test(value) || isAccepted(value))
      parsers.push(value);
  }
  return parsers;
}

function badAskKeys(code: string): string[] {
  return askKeyParsers(code).filter((v) => !isAccepted(v));
}

/** A door: a file the scan finds an ask parse in. */
function isDoor(f: { rel: string; code: string }): boolean {
  return (
    askKeyParsers(f.code).length > 0 ||
    (f.rel.startsWith("routers/mcp/") && MCP_READS_ASK.test(f.code))
  );
}

/** The wire protocol a door serves, from where it sits under routers/. */
function protocolOf(rel: string): "hub-rest" | "mcp" | "trpc" | null {
  if (rel.startsWith("routers/hub-protocol/")) return "hub-rest";
  if (rel.startsWith("routers/mcp/")) return "mcp";
  if (rel.startsWith("routers/")) return "trpc";
  return null;
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
    expect(askKeyParsers("ask: input.ask,")).toEqual([]);
    expect(MCP_PARSES_ASK.test("AskSchema.safeParse(args.ask)")).toBe(true);
  });

  it("finds doors on every wire protocol (tRPC, Hub REST, MCP)", () => {
    const doors = files.filter(isDoor);
    const protocols = new Set(doors.map((d) => protocolOf(d.rel)));
    expect([...protocols].filter(Boolean).sort()).toEqual([
      "hub-rest",
      "mcp",
      "trpc",
    ]);
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
