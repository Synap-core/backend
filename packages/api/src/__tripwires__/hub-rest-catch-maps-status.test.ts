import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import ts from "typescript";

/**
 * TRIPWIRE — a Hub REST route's `catch` never answers a hard-coded 500.
 *
 * The class (measured 2026-09-25): 227 `c.json(..., 500)` sites inside `catch`
 * blocks across 67 of the 90 route files. Every one of them turned a caught
 * tRPC NOT_FOUND / FORBIDDEN / BAD_REQUEST / CONFLICT into an opaque 500, so a
 * caller that could act on the refusal ("unknown profile", "extend the existing
 * one") got a server fault instead. The fix is the shared mapper
 * `httpStatusForTrpcError(err)` (`rest/_shared.ts`), which still answers 500 for
 * a genuinely unknown error — so routing a catch through it never hides a real
 * server fault.
 *
 * DERIVED, NOT HAND-LISTED: every non-test `.ts` file in `rest/` is parsed with
 * the TypeScript compiler (not a regex — a multi-line `c.json(\n {...},\n 500\n)`
 * is the common shape and a line regex misses it), and every numeric literal
 * `500` passed as the STATUS argument of a `.json(...)` call lexically inside a
 * `catch` block is counted. A new route file joins the scan by existing.
 *
 * WHAT IT DOES NOT SEE (measured):
 *   - a 500 computed locally (`isValidation ? 400 : 500`, `oauthError(500, …)`,
 *     a `status` variable) — 10 such sites today, each a deliberate local
 *     classifier, not a blanket literal;
 *   - `.text(...)` / `new Response(..., { status: 500 })` — none exist in a catch
 *     today;
 *   - a hard-coded 500 OUTSIDE a catch (an explicit "this is a server fault"
 *     branch) — out of scope on purpose.
 */

// Peer-held files on 2026-09-25 (uncommitted edits by another live session) —
// left unconverted rather than editing under a peer. A RATCHET on the exact
// count: the test fails when a file's count drops (lower/delete the line — the
// work landed) or rises (a new blanket 500 was added).
const KNOWN_PEER_HELD: Record<string, number> = {
  "capabilities.ts": 7,
  "entity-share.ts": 1,
  "focus-sessions.ts": 14,
  "loops.ts": 1,
  "packages.ts": 2,
  "projects.ts": 1,
  "proposals.ts": 3,
  "setup.ts": 7,
  "threads.ts": 7,
  "views.ts": 3,
};

const REST_DIR = join(__dirname, "../routers/hub-protocol/rest");

/** Count literal-500 `.json` statuses and mapper calls inside catch blocks. */
function scanSource(
  fileName: string,
  src: string
): { literal500: number[]; mapped: number; catches: number } {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const literal500: number[] = [];
  let mapped = 0;
  let catches = 0;
  const visit = (node: ts.Node, inCatch: boolean): void => {
    if (ts.isCatchClause(node)) {
      catches++;
      ts.forEachChild(node.block, (c) => visit(c, true));
      return;
    }
    if (inCatch && ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "json" &&
        node.arguments.length >= 2
      ) {
        const status = node.arguments[1];
        if (ts.isNumericLiteral(status) && status.text === "500") {
          literal500.push(
            sf.getLineAndCharacterOfPosition(status.getStart()).line + 1
          );
        }
      }
      if (ts.isIdentifier(callee) && callee.text === "httpStatusForTrpcError") {
        mapped++;
      }
    }
    ts.forEachChild(node, (c) => visit(c, inCatch));
  };
  visit(sf, false);
  return { literal500, mapped, catches };
}

function scanRestDir() {
  const files = readdirSync(REST_DIR).filter(
    (f) => f.endsWith(".ts") && !f.includes(".test.")
  );
  const perFile: Record<string, number[]> = {};
  let mapped = 0;
  let catches = 0;
  for (const f of files) {
    const r = scanSource(f, readFileSync(join(REST_DIR, f), "utf8"));
    mapped += r.mapped;
    catches += r.catches;
    if (r.literal500.length) perFile[f] = r.literal500;
  }
  return { files: files.length, perFile, mapped, catches };
}

describe("tripwire: Hub REST catches map their status (no blanket 500)", () => {
  it("the scanner still sees a multi-line literal 500 and a mapped status", () => {
    // Self-check on literal samples of both shapes it hunts.
    const bad = scanSource(
      "sample.ts",
      `app.get("/x", async (c) => {
        try { await f(); } catch (err) {
          return c.json(
            { error: "boom" },
            500
          );
        }
      });`
    );
    expect(bad.literal500).toHaveLength(1);
    const good = scanSource(
      "sample.ts",
      `app.get("/x", async (c) => {
        try { await f(); } catch (err) {
          return c.json({ error: "boom" }, httpStatusForTrpcError(err));
        }
      });`
    );
    expect(good.literal500).toHaveLength(0);
    expect(good.mapped).toBe(1);
    // A 500 outside a catch is out of scope.
    expect(
      scanSource("s.ts", `return c.json({ error: "x" }, 500);`).literal500
    ).toHaveLength(0);
  });

  it("no route file answers a hard-coded 500 from a catch (except the peer-held ratchet)", () => {
    const { files, perFile, mapped, catches } = scanRestDir();

    // Non-vacuity (2026-09-25: 90 route files, 300+ catch clauses, 190+ mapped
    // catch statuses after the conversion).
    expect(files).toBeGreaterThan(80);
    expect(catches).toBeGreaterThan(250);
    expect(mapped).toBeGreaterThan(150);

    const unexpected = Object.entries(perFile)
      .filter(([f]) => !(f in KNOWN_PEER_HELD))
      .map(([f, lines]) => `${f}:${lines.join(",")}`);
    expect(unexpected).toEqual([]);

    const drifted = Object.entries(KNOWN_PEER_HELD)
      .filter(([f, n]) => (perFile[f]?.length ?? 0) !== n)
      .map(([f, n]) => `${f}: ratchet ${n}, found ${perFile[f]?.length ?? 0}`);
    expect(drifted).toEqual([]);
  });
});
