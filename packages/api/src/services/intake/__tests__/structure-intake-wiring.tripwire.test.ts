/**
 * TRIPWIRE — every `capture.structure` outcome records its run.
 *
 * `recordStructureIntake` is exercised on a real Postgres in
 * `intake-run.pglite.test.ts`. What that seam cannot see is whether the
 * PROCEDURE still reaches it on every exit: the procedure needs the IS,
 * profiles, search and a live pod. A new early `return` (a fresh degraded
 * branch, a new follow-up shape) that bypasses `finishIntake` would ship a
 * capture with no room, no source document and no manifest while every other
 * gate stays green. So this reads the procedure's source.
 *
 * WHAT IT CHECKS: inside the `structure:` procedure, every `return` statement
 * is `return finishIntake(`, except the single `return { ...result, ...echo }`
 * inside `finishIntake` itself.
 *
 * WHAT IT CANNOT SEE (measured by construction, not by claim): a `throw` exit
 * (errors deliberately record nothing — the caller gets the error), a return
 * inside a nested callback that is NOT the procedure's own exit, and whether
 * `finishIntake` still calls `recordStructureIntake` beyond the literal below.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../../../routers/capture.ts"), "utf8");

const START = "  structure: podProcedure";
const END = "  analyzeBulkMapping: podProcedure";

function structureSlice(src: string): string {
  const start = src.indexOf(START);
  const end = src.indexOf(END, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("capture.structure records its run on every exit", () => {
  const slice = structureSlice(SRC);
  // A line-leading `return`, OR a single-line guard (`if (x) return y;`,
  // `else return y;`) — normalised to the `return …` part. A return split
  // across lines after a guard (`if (x)\n  return y`) still starts its own line.
  const toReturn = (line: string): string | null => {
    if (/^return\b/.test(line)) return line;
    const guard = /^(?:\}\s*)?(?:if\b.*\)|else)\s+(return\b.*)$/.exec(line);
    return guard ? guard[1]! : null;
  };
  const returns = slice
    .split("\n")
    .map((line) => toReturn(line.trim()))
    .filter((r): r is string => r !== null);

  it("the scan still sees the procedure's exits (non-vacuity)", () => {
    // Five outcomes today: pod auth degrade, pod invalid-response degrade,
    // empty result, follow-up, plan. Fewer means the slice or the regex broke.
    expect(
      returns.filter((r) => r.startsWith("return finishIntake(")).length
    ).toBeGreaterThanOrEqual(5);
    // Self-check: the pattern still sees a bare AND a single-line-guarded return.
    const sample = [
      'return degradedFallback("x");',
      'if (!structureResult) return degradedFallback("x");',
      '} else return degradedFallback("x");',
    ].map(toReturn);
    expect(sample).toEqual([
      'return degradedFallback("x");',
      'return degradedFallback("x");',
      'return degradedFallback("x");',
    ]);
  });

  it("finishIntake still records through the one intake door", () => {
    expect(slice).toContain("await recordStructureIntake(");
  });

  it("finishIntake derives the run facts from the OUTCOME's degraded flag, not only meta", () => {
    // Every door (tRPC, Hub REST `caller.structure`, MCP `captureCaller.structure`)
    // exits through finishIntake, so this one line is what makes a degraded run
    // without IS meta record `engine: "degraded"` instead of "unknown".
    // Cannot see: whether `r` is still the finishIntake result (a rename would
    // have to keep the literal to pass).
    expect(slice).toMatch(
      /runFactsFromStructureMeta\(run\.meta, \{\s*podDegraded: run\.podDegraded,\s*degraded: r\.degraded === true,\s*\}\)/
    );
  });

  it("no exit bypasses finishIntake", () => {
    const bypassing = returns.filter(
      (r) =>
        !r.startsWith("return finishIntake(") &&
        r !== "return { ...result, ...echo };"
    );
    expect(bypassing).toEqual([]);
  });
});

describe("MCP graph lane records sources only after a successful submit", () => {
  const MCP = readFileSync(
    join(HERE, "../../../routers/mcp/handlers/capture.ts"),
    "utf8"
  );
  it("the room is keyed by the graph's canonical content, and intake is recorded AFTER submitCaptureGraph", () => {
    const ensure = MCP.indexOf("const graphRun = await ensureIntakeSession({");
    const submit = MCP.indexOf(
      "const graphResult = await submitCaptureGraph({"
    );
    const record = MCP.indexOf("await recordStructureIntake({", submit);
    expect(ensure).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(ensure);
    expect(record).toBeGreaterThan(submit);
    // No intake recording between the ensure and the submit.
    expect(MCP.slice(ensure, submit)).not.toContain("recordStructureIntake(");
    expect(MCP.slice(ensure, submit)).toContain(
      "computeCaptureGraphIdempotencyKey("
    );
  });
});
