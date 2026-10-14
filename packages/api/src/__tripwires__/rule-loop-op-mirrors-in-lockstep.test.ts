/**
 * TRIPWIRE — composite proposal ops are declared ONCE (the server package).
 *
 * `CompositeProposalOperation` used to be declared TWICE: the server
 * (`synap-backend/packages/types/src/proposals/index.ts`) and a browser-safe
 * mirror (`synap-app/packages/headless/src/proposal-types/types.ts`). A
 * vocabulary declared in two places where only one gets updated is this repo's
 * most repeated defect (the DeclarativeBlock seam-fork: same op name, different
 * INTERNAL shape, blank render), so this test compared field signatures.
 *
 * synap-app d9617239 (2026-10-12) removed the mirror: the browser file now
 * re-exports every op type from `@synap-core/types/proposals`. A fork is
 * impossible while that holds, so the guard now pins the stronger invariant:
 * the browser file declares NO op interface of its own and takes the union
 * from the server package. Re-declaring one there (the old mirror shape) fails.
 *
 * NOT covered: an op type declared in some OTHER synap-app file; this reads the
 * one file that held the mirror.
 *
 * Cross-repo, guarded like `cp-pod-package-schema-parity`: when `synap-app` is
 * not checked out beside `synap-backend`, the browser assertions are skipped
 * rather than reading an empty string and reporting green.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `src/__tripwires__` → src → api → packages → synap-backend → multi-repo root. */
const REPO_ROOT = join(import.meta.dirname, "../../../../..");

const SERVER_TYPES = join(
  REPO_ROOT,
  "synap-backend/packages/types/src/proposals/index.ts"
);
const BROWSER_TYPES = join(
  REPO_ROOT,
  "synap-app/packages/headless/src/proposal-types/types.ts"
);

/** Strip comments so prose can never be read as a field signature. */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Map `op` discriminant → normalised field signatures of the interface that
 * declares it. Field text is whitespace-collapsed so formatting differences
 * (prettier wrapping a long union) are not reported as drift.
 */
function opFieldSignatures(file: string): Map<string, string[]> {
  return opFieldSignaturesOf(readFileSync(file, "utf8"));
}

function opFieldSignaturesOf(raw: string): Map<string, string[]> {
  const src = strip(raw);
  const out = new Map<string, string[]>();
  for (const m of src.matchAll(/export interface (\w+) \{([\s\S]*?)\n\}/g)) {
    const body = m[2]!;
    const discriminant = body.match(/\bop:\s*"([\w_]+)"/);
    if (!discriminant) continue;
    const fields = body
      .split(";")
      .map((f) => f.replace(/\s+/g, " ").trim())
      .filter((f) => f.length > 0 && !f.startsWith("op:"))
      .sort();
    out.set(discriminant[1]!, fields);
  }
  return out;
}

// Skip ONLY when the synap-app REPO is absent; a moved BROWSER_TYPES with the
// repo present must fail (opFieldSignatures reads it), not skip.
const bothCheckedOut =
  existsSync(SERVER_TYPES) && existsSync(join(REPO_ROOT, "synap-app"));

describe("tripwire: mirrored composite ops mirror each other exactly", () => {
  it("the server declaration exists at the path this test parses", () => {
    expect(
      existsSync(SERVER_TYPES),
      `${SERVER_TYPES} does not exist — it moved. Update the constant; do NOT ` +
        "let this tripwire parse nothing and report green."
    ).toBe(true);
  });

  it("SELF-GUARD: the parser reads a non-trivial corpus from the server file", () => {
    const server = opFieldSignatures(SERVER_TYPES);
    expect(server.size).toBeGreaterThanOrEqual(5);
    expect(server.get("create_relation")).toContain("sourceRef: string");
  });

  it("SELF-GUARD: the parser sees an inline op declaration", () => {
    const sample =
      'export interface X {\n  op: "create_skill";\n  ref: string;\n}';
    expect([...opFieldSignaturesOf(sample).keys()]).toEqual(["create_skill"]);
  });

  it.runIf(bothCheckedOut)(
    "the browser file declares no composite op of its own (one declaration)",
    () => {
      const browser = opFieldSignatures(BROWSER_TYPES);
      expect(
        [...browser.keys()],
        "synap-app re-declares composite ops — re-export them from " +
          "@synap-core/types/proposals instead (a second declaration forks)."
      ).toEqual([]);
    }
  );

  it.runIf(bothCheckedOut)(
    "the browser file takes the op union from the server package",
    () => {
      const src = strip(readFileSync(BROWSER_TYPES, "utf8"));
      expect(src).toMatch(
        /import type \{[^}]*\bCompositeProposalOperation\b[^}]*\} from "@synap-core\/types\/proposals"/
      );
    }
  );
});
