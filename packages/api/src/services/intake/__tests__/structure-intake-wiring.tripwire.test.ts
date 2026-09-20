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

  // Locals assigned from `await finishIntake(` — DERIVED, never listed. An
  // exit that spreads one of these still recorded its run; one that spreads
  // anything else did not. (Was a hand-counted allowance for `asked` alone,
  // which made the second such exit — the terminal one, which now persists the
  // capture_result part before returning — read as a bypass.)
  const recordedLocals = new Set(
    [...slice.matchAll(/const (\w+) = await finishIntake\(/g)].map((m) => m[1]!)
  );

  it("the scan still sees the procedure's exits (non-vacuity)", () => {
    // Five outcomes today: pod auth degrade, pod invalid-response degrade,
    // empty result, follow-up, plan. Fewer means the slice or the regex broke.
    // Two of them record through a local (`asked`, `structured`) and return an
    // object that spreads it.
    expect(recordedLocals.size).toBeGreaterThanOrEqual(2);
    expect(
      returns.filter((r) => r.startsWith("return finishIntake(")).length +
        recordedLocals.size
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
    // Also pins `podTimings` (lane LA): the pod's dedup/placement timings reach
    // the run manifest only through this call.
    expect(slice).toMatch(
      /runFactsFromStructureMeta\(run\.meta, \{\s*podDegraded: run\.podDegraded,\s*degraded: r\.degraded === true,\s*podTimings,\s*\}\)/
    );
  });

  it("no exit bypasses finishIntake", () => {
    // Object exits that SPREAD a recorded local — multi-line (`return {\n
    // ...asked,`) and single-line (`return { ...structured, x };`) alike. The
    // spread name must be one `await finishIntake(` produced; anything else is
    // a bypass wearing the same shape.
    const spreadExits = [
      ...slice.matchAll(/return \{\s*(?:\n\s*)?\.\.\.(\w+)[,\s}]/g),
    ].map((m) => m[1]!);
    expect(
      spreadExits.filter((n) => !recordedLocals.has(n) && n !== "result")
    ).toEqual([]);
    const recordedSpreadExits = spreadExits.filter((n) =>
      recordedLocals.has(n)
    ).length;

    const bypassing = returns.filter(
      (r) =>
        !r.startsWith("return finishIntake(") &&
        r !== "return { ...result, ...echo };" &&
        // The ONE exit that records nothing BY DESIGN: the file's bytes were
        // already analyzed into a run of their own (the "already imported"
        // ledger) — staging them again would mint a second room for them.
        r !== "return alreadyImportedAnswer;" &&
        // An object exit that spreads a finishIntake local (see above).
        !(r === "return {" && recordedSpreadExits > 0) &&
        !/^return \{ \.\.\.(\w+)[,\s}]/.test(r)
    );
    expect(bypassing).toEqual([]);
    // Every bare `return {` exit must be accounted for by a recorded spread.
    expect(returns.filter((r) => r === "return {").length).toBeLessThanOrEqual(
      recordedSpreadExits
    );
    expect(recordedSpreadExits).toBe(recordedLocals.size);
  });

  it("ONE bulk derivation decides the IS vision lane: the caller's flag OR a run already holding a file", () => {
    // Behaviour of each lane is pinned IS-side (`context.vision-budget.test.ts`).
    // Cannot see: that the IS client still posts the whole input (it does:
    // `body: JSON.stringify(input)`) — an older IS simply ignores the field.
    expect(slice).toContain("let visionBulk = input.bulk === true;");
    expect(slice).toContain("if (run.count > 0) visionBulk = true;");
    expect(slice).toMatch(
      /visionLane: visionBulk \? \("bulk" as const\) : \("single" as const\),/
    );
    // Exactly one assignment site each — a second derivation is a fork.
    expect(slice.match(/visionBulk = /g)).toHaveLength(2);
  });

  it("a caption-structured outcome whose FILE was not read records it as not read", () => {
    // Behaviour pinned in `known-source-hashes.pglite.test.ts`. Cannot see:
    // that `r` is still the finishIntake result.
    expect(slice.replace(/\s+/g, " ")).toContain(
      '...(r.degraded !== true && r.extraction?.degraded === true ? { fileNotRead: { reason: str(r.extraction.degradedReason) ?? "unknown", }, } : {}),'
    );
  });

  it("forwards the pod's vision model PREFERENCE on the IS structure request", () => {
    // The IS side (honour when served, else fall back) is pinned in
    // `context.vision-preference.test.ts`; the read in `pod-vision-preference.test.ts`.
    expect(slice).toContain("await readPodVisionModelPreference(database)");
    expect(slice).toContain("...(visionModelId ? { visionModelId } : {}),");
  });

  it("the already-imported exit is scoped to THIS workspace and a run still in effect", () => {
    // Cannot see: that `findKnownSourceHashes` scopes and classifies correctly
    // (pglite suite). This pins that the procedure ASKS for both.
    const flat = slice.replace(/\s+/g, " ");
    expect(flat).toMatch(
      /await findKnownSourceHashes\(\{ database, userId, hashes: [^}]*, workspaceId: workspaceId \?\? null, \}\)/
    );
    expect(flat).toContain(
      'known.find( (k) => k.status === "analyzed" && k.inEffect )'
    );
  });

  it("the already-imported exit is taken only on the ledger's `analyzed` verdict", () => {
    // Cannot see: that `findKnownSourceHashes` classifies correctly (pglite
    // suite `known-source-hashes.pglite.test.ts`).
    expect(slice).toMatch(
      // Windows measured 2026-09-14: 530 and 990 chars (the workspace/in-effect
      // scope comment sits before the verdict; the answer's shape after it).
      /if \(!input\.reanalyze\) \{[\s\S]{0,900}status === "analyzed"[\s\S]{0,1500}return alreadyImportedAnswer;/
    );
  });
});

describe("MCP graph lane keeps its raw BEFORE the submit, and the submit names it", () => {
  // Was "records sources only AFTER a successful submit" — overturned by the
  // founder rule 2026-09-14 (raw is always kept): a refused submit must still
  // leave the raw stored, and the receipt must carry `data.sourceDocumentIds`,
  // which only exist once staged. Cannot see: the text actually sent (pinned
  // literal below), nor what `submitCaptureGraph` writes with the ids (its tests).
  const MCP = readFileSync(
    join(HERE, "../../../routers/mcp/handlers/capture.ts"),
    "utf8"
  );
  it("the room is keyed by the graph's canonical content; the raw is recorded between the ensure and the submit, exactly once, even when the room failed", () => {
    const ensure = MCP.indexOf("const graphRun = await ensureIntakeSession({");
    // The record sits inside a try: a throw or a missing echo is SURFACED as a
    // failed intake (`intakeNotRecorded`), never a crash of the capture.
    const record = MCP.indexOf("(await recordStructureIntake({", ensure);
    const submit = MCP.indexOf(
      "const graphResult = await submitCaptureGraph({",
      ensure
    );
    expect(ensure).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(ensure);
    expect(submit).toBeGreaterThan(record);
    expect(MCP.slice(ensure, record)).toContain(
      "computeCaptureGraphIdempotencyKey("
    );
    expect(MCP.match(/await recordStructureIntake\(\{/g)).toHaveLength(1);
    // Never gated on the room: a failed ensure still stages, sessionless.
    const call = MCP.slice(record, submit).replace(/\s+/g, " ");
    expect(call).toContain("ensuredSession: graphRun,");
    expect(call).toContain(
      '})) ?? intakeNotRecorded("no intake echo returned");'
    );
    expect(call).toMatch(
      /\} catch \(err\) \{ graphIntake = intakeNotRecorded\( err instanceof Error \? err\.message : String\(err\) \); \}/
    );
    expect(MCP.slice(ensure, record)).toMatch(
      /let graphIntake: Awaited<ReturnType<typeof recordStructureIntake>>;\s*try \{\s*graphIntake =\s*$/
    );
    expect(MCP.slice(ensure, record)).not.toMatch(/graphSessionId\s*\?/);
  });

  it("the staged ids ride the submit (absent ⇒ omitted, never [])", () => {
    const submit = MCP.indexOf(
      "const graphResult = await submitCaptureGraph({"
    );
    expect(MCP.slice(submit, submit + 400).replace(/\s+/g, " ")).toContain(
      "...(graphIntake.intake.sourceDocumentIds.length ? { sourceDocumentIds: graphIntake.intake.sourceDocumentIds } : {}),"
    );
  });
});
