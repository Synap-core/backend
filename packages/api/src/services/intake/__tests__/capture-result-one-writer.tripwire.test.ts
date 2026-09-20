/**
 * TRIPWIRE — `capture_result` has exactly ONE writer, on the TERMINAL path.
 *
 * Two writers for one fact is this codebase's recurring defect, and here it
 * would be invisible: a second write would just produce a second "newest" part
 * and the report would flicker between two truths. The subtler failure is
 * placement — a write next to `persistCaptureQuestion` covers the follow-up
 * branch only, which is every path EXCEPT the refined result this feature
 * exists to keep. So this pins both the count and the position.
 *
 * WHAT IT CANNOT SEE (measured, not implied): the granularity is the call
 * expression `persistCaptureResult(`, not its runtime reachability. A call
 * placed inside a dead `if (false)` after the dedup loop would still pass. It
 * also reads source, so it says nothing about the built `dist`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const API_SRC = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Comments removed before scanning — a guard in this repo once tripped on its
 * own docblock. Line comments inside string literals are not distinguished;
 * that is acceptable here because every needle below is a call expression.
 */
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

describe("capture_result — one writer, terminal path", () => {
  it("the scan is not vacuous: it sees the api sources and a known sample", () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    // Self-check: the stripper still leaves real code, and the needle exists.
    const service = SOURCES.find(
      (f) => f.path === "services/intake/capture-result-part.ts"
    );
    expect(service, "the service file must be in the scanned set").toBeTruthy();
    expect(service!.code).toContain(
      "export async function persistCaptureResult"
    );
    expect(service!.code).not.toContain("ONE WRITER.");
  });

  it("exactly one file CALLS persistCaptureResult, and it is the capture router", () => {
    const callers = SOURCES.filter(
      (f) =>
        f.path !== "services/intake/capture-result-part.ts" &&
        /\bpersistCaptureResult\s*\(/.test(f.code)
    ).map((f) => f.path);
    expect(callers).toEqual(["routers/capture.ts"]);

    const capture = SOURCES.find((f) => f.path === "routers/capture.ts")!;
    const calls = capture.code.match(/\bpersistCaptureResult\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("the one call sits AFTER dedup — i.e. on the terminal return, not the follow-up branch", () => {
    const code = SOURCES.find((f) => f.path === "routers/capture.ts")!.code;
    const call = code.indexOf("persistCaptureResult({");
    const dedupLoop = code.indexOf("dedupCandidates[entity.tempId] =");
    const followUpReturn = code.indexOf("channelId: followUpChannelId,");

    // Non-vacuity: every anchor must actually be found.
    expect(call, "persistCaptureResult({ call").toBeGreaterThan(-1);
    expect(dedupLoop, "the dedup loop anchor").toBeGreaterThan(-1);
    expect(
      followUpReturn,
      "the follow-up branch return anchor"
    ).toBeGreaterThan(-1);

    expect(call).toBeGreaterThan(followUpReturn);
    expect(call).toBeGreaterThan(dedupLoop);
  });

  it("only the result service constructs a capture_result part", () => {
    const writers = SOURCES.filter((f) =>
      /kind:\s*"capture_result"/.test(f.code)
    ).map((f) => f.path);
    expect(writers).toEqual(["services/intake/capture-result-part.ts"]);
  });
});
