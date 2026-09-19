import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TRIPWIRE — capture routing hints have ONE mapping: `captureExecuteRoutingHints`.
 *
 * Every capture door forwards `capture.structure`'s placement advice
 * (`targetWorkspace*` / `targetProject*`) to `capture.execute` as the advisory
 * `ai*` hints. Each door used to hand-copy its own subset, so the same capture
 * recorded different routing data by door — only MCP forwarded the decision
 * distribution (`aiWorkspaceDecision`), the hub REST codec stripped it. The
 * mapping now lives once, in `@synap-core/types` (`capture-routing-types.ts`).
 *
 * WHAT IT CHECKS
 * 1. No backend source file (outside that one mapper) hand-copies a structure
 *    field into its execute hint — `aiWorkspaceConfidence: …targetWorkspaceConfidence`
 *    and the same for every `ai(Workspace|Project)(Id|Confidence|Reason|Decision)`.
 * 2. The execute doors are DISCOVERED (a file that builds a capture caller and
 *    calls `.execute(`), never hand-listed. An `.execute({…})` call whose
 *    argument references the variable a `.structure(` result was assigned to
 *    FORWARDS that result, and must spread `...captureExecuteRoutingHints(`.
 *
 * DERIVED, not listed: the scanned set is every non-test `.ts` under
 * `synap-backend/packages/*\/src`, so a new door is audited by existing.
 *
 * WHAT IT CANNOT SEE (measured): a hand-copy that goes through an intermediate
 * variable (`const c = structured.targetWorkspaceConfidence; … aiWorkspaceConfidence: c`),
 * or one more than ~240 characters from its key; a structure result assigned
 * other than `const x = await ….structure(` (a `let`, a destructure); and a
 * door that relays ALREADY-MAPPED hints (the hub REST door forwards its body's
 * `ai*` fields — its codec coverage is pinned by
 * `capture.execute-routing-hints.test.ts`). The mapper's own field coverage is
 * the types package's concern. Negative controls run while writing this: the
 * MCP handler's old hand-copy restored ⇒ checks 2 and 3 red; the mapper spread
 * deleted outright ⇒ check 3 red.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, "../../..");
const CANONICAL = join("types", "src", "capture-routing-types.ts");

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith("."))
      continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !/\.test\.ts$/.test(name)
    )
      out.push(p);
  }
}

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, "src");
    try {
      if (statSync(src).isDirectory()) walk(src, out);
    } catch {
      // A package without src/ (config-only) has nothing to scan.
    }
  }
  return out;
}

/**
 * `aiX: …targetX` for the same X, not crossing into the next `ai*:` key.
 * Pinned at both ends: the key (`aiWorkspaceConfidence:`) and the SAME-suffix
 * target field (`targetWorkspaceConfidence`).
 */
const HAND_COPY =
  /\bai(Workspace|Project)(Id|Confidence|Reason|Decision)\s*:(?:(?!\bai(?:Workspace|Project)[A-Z]\w*\s*:)[\s\S]){0,240}?\btarget\1\2\b/g;

/** The argument text of every `.execute({ … })` call (brace-matched). */
function executeArgs(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\.execute\(\s*\{/g)) {
    let depth = 0;
    const start = m.index! + m[0].length - 1;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        out.push(src.slice(start, i + 1));
        break;
      }
    }
  }
  return out;
}

const FILES = sourceFiles();
const rel = (p: string) => relative(PACKAGES, p);

describe("capture execute routing hints — one mapper", () => {
  it("the scan sees the backend (non-vacuity) and the regex still sees a hand-copy (self-check)", () => {
    expect(FILES.length).toBeGreaterThan(300);
    expect(FILES.map(rel)).toContain(CANONICAL);
    const hits = (s: string) => (s.match(HAND_COPY) ?? []).length;
    // The exact shape the MCP handler had before the mapper.
    expect(
      hits(`aiWorkspaceConfidence: (
      structured as { targetWorkspaceConfidence?: number | null }
    ).targetWorkspaceConfidence,`)
    ).toBe(1);
    expect(hits("aiProjectId: structured.targetProjectId,")).toBe(1);
    expect(
      hits("aiWorkspaceDecision: s.targetWorkspaceDecision ?? null,")
    ).toBe(1);
    // Not a hand-copy: a pass-through of already-mapped hints, or a
    // different field on the next key.
    expect(hits("aiWorkspaceConfidence: body.aiWorkspaceConfidence,")).toBe(0);
    expect(
      hits(
        "aiWorkspaceId: body.aiWorkspaceId,\n aiWorkspaceReason: x.targetWorkspaceId,"
      )
    ).toBe(0);
    // The canonical mapper itself matches — it is the one allowed site.
    expect(
      hits(readFileSync(join(PACKAGES, CANONICAL), "utf8"))
    ).toBeGreaterThanOrEqual(7);
  });

  it("no backend source outside the mapper hand-copies structure → execute hints", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      if (rel(f) === CANONICAL) continue;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(HAND_COPY)) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${rel(f)}:${line} ${m[0].split("\n")[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("execute doors are discovered, and the one forwarding a structure result uses the mapper", () => {
    const doors = FILES.filter((f) => {
      const src = readFileSync(f, "utf8");
      return (
        /captureRouter\.createCaller\(|\bcaptureCaller\b/.test(src) &&
        /\.execute\(\s*\{/.test(src)
      );
    });
    // Non-vacuity: MCP + hub REST today.
    expect(doors.length).toBeGreaterThanOrEqual(2);
    // A door FORWARDS a structure result when an `.execute({…})` argument
    // references the variable a `.structure(` call was assigned to. Every such
    // execute call must spread the mapper.
    const forwarding: string[] = [];
    const bypassing: string[] = [];
    for (const f of doors) {
      const src = readFileSync(f, "utf8");
      const vars = [
        ...src.matchAll(/const (\w+) = await \w+\.structure\(/g),
      ].map((m) => m[1]!);
      if (!vars.length) continue;
      for (const call of executeArgs(src)) {
        if (!vars.some((v) => new RegExp(`\\b${v}\\b`).test(call))) continue;
        forwarding.push(rel(f));
        if (!/\.\.\.captureExecuteRoutingHints\(/.test(call))
          bypassing.push(rel(f));
      }
    }
    // Non-vacuity: the MCP capture handler forwards today.
    expect(forwarding.length).toBeGreaterThanOrEqual(1);
    expect(bypassing).toEqual([]);
  });
});
