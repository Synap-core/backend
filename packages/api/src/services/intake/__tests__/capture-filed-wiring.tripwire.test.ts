/**
 * TRIPWIRE — `capture_filed` has ONE writer (`capture.execute`), on EVERY exit,
 * and execute's `created[].action` comes from the SAME `captureRowAction` the
 * receipt's outcome does.
 *
 * The failure this pins is placement: a receipt written on the applied exit
 * only leaves a governance-held accept reading "proposed" on the accepting
 * device and as nothing at all on every other one. And a second derivation of
 * `action` would let the response and the room disagree about one row.
 *
 * Behaviour (what the receipt says, idempotency, the room floor) is pinned on
 * PGlite by `capture-filed-part.pglite.test.ts`; this file only pins wiring.
 *
 * WHAT IT CANNOT SEE (measured, not implied): the granularity is the call
 * expression between two exits, not its runtime reachability — a call inside a
 * dead branch before the return still passes. It reads source, never `dist`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const API_SRC = fileURLToPath(new URL("../../../", import.meta.url));

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      tsFiles(full, acc);
    } else if (name.endsWith(".ts") && !/\.(test|tripwire)\.ts$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

const SOURCES = tsFiles(API_SRC).map((path) => ({
  path: relative(API_SRC, path),
  code: stripComments(readFileSync(path, "utf8")),
}));

const captureSrc = SOURCES.find((f) => f.path === "routers/capture.ts")!.code;
const executeSrc = captureSrc.slice(
  captureSrc.indexOf("\n  execute: podProcedure"),
  captureSrc.indexOf("\n  executeWithSchema: podProcedure")
);

/** Execute's exits: a `return {` whose first key is the outcome status. */
const EXIT = /return \{\s*status: "(proposed|applied)" as const/g;

describe("capture_filed — written by execute on every exit", () => {
  it("the scan is not vacuous", () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(executeSrc.length).toBeGreaterThan(10_000);
    expect(executeSrc).toContain("const recordFiledReceipt = async");
    expect([...executeSrc.matchAll(EXIT)].map((m) => m[1])).toEqual([
      "proposed",
      "proposed",
      "applied",
    ]);
  });

  it("each exit is preceded by its own receipt write", () => {
    let from = executeSrc.indexOf("const recordFiledReceipt = async");
    for (const m of executeSrc.matchAll(EXIT)) {
      const segment = executeSrc.slice(from, m.index);
      expect(
        segment.match(/await recordFiledReceipt\(/g)?.length,
        `the "${m[1]}" exit at offset ${m.index} writes no receipt`
      ).toBe(1);
      from = m.index! + m[0].length;
    }
  });

  it("the applied receipt reads the SAME created array the response returns", () => {
    expect(executeSrc).toMatch(
      /recordFiledReceipt\(\s*\{\s*kind: "applied", created, updated: captureUpdates \}/
    );
  });

  it("execute is the only writer", () => {
    const writers = SOURCES.filter(
      (f) =>
        /persistCaptureFiled\(/.test(f.code) &&
        f.path !== "services/intake/capture-filed-part.ts"
    ).map((f) => f.path);
    expect(writers).toEqual(["routers/capture.ts"]);
    expect(captureSrc.match(/persistCaptureFiled\(/g)?.length).toBe(1);
  });
});

describe("created[].action — one derivation", () => {
  it("execute's applied rows take their action from captureRowAction", () => {
    const createdMap = executeSrc.slice(
      executeSrc.indexOf("const created = result.entities.map("),
      executeSrc.indexOf("const createdRelations =")
    );
    expect(createdMap.length).toBeGreaterThan(100);
    expect(createdMap).toMatch(/action: captureRowAction\(/);
    // The two inputs the helper needs to tell matched from linked from updated.
    expect(createdMap).toContain("autoLinkedTempIds.has(");
    expect(createdMap).toContain("updateByTempId.get(");
  });

  it("only the helper spells the action out", () => {
    const handRolled =
      /\?\s*"matched"\s*:\s*"linked"|\?\s*"linked"\s*:\s*"created"/;
    const hits = SOURCES.filter((f) => handRolled.test(f.code)).map(
      (f) => f.path
    );
    // Self-check: the pattern still sees the one place that may spell it.
    expect(hits).toEqual(["services/intake/capture-filed-part.ts"]);
  });
});
