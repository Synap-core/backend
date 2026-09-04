import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — the gate's (subjectType, action) pair is DERIVED from the
 * operations, never DECLARED beside them.
 *
 * THE DEFECT CLASS. `routers/capture.ts` called `checkPermissionOrPropose` with
 * hardcoded literals:
 *
 *     subjectType: "entity",
 *     action: "create",
 *     data: { operations: gateOperations, source: "capture" }
 *
 * …while `gateOperations` was a real `CompositeProposalOperation[]`. Every
 * governance floor is a pure function of exactly those two literals — rung 2
 * `ADMIN_ACTIONS.includes(eventKey)` (strict equality, NO globbing), rung 2.5
 * `DESTRUCTIVE_ACTIONS.includes(action)`, rung 2.6 by-kind — so the floors were
 * scoring a DECLARATION rather than the write. It was true only by coincidence:
 * capture can emit `create_entity` / `create_relation` and nothing else. The
 * instant a producer emits another arm (`update`, `create_skill`,
 * `create_automation`, `create_rule`), the gate would still say `entity`/
 * `create` and a floor could never fire on the arm that needed it. A DESTRUCTIVE
 * floor cannot fire on a door that says "create".
 *
 * THE RULE: a batch gates at its STRICTEST member, via
 * `deriveGatePairFromOperations` (`@synap/governance-policy`). Over-gating is
 * safe; under-gating is the bug.
 *
 * A SOURCE SCAN is the only mechanism that can see this. The severance is a
 * literal at a call site: the types accept it (both spellings are legal gate
 * doors), the call succeeds, and no runtime assertion can tell a coincidentally
 * correct declaration from a derived one.
 *
 * ── WHAT THIS SCAN HARDENED AGAINST (three measured escapes) ───────────────
 *  1. SPREAD PAYLOAD. The scope filter was `/\boperations\s*:/` on the raw call
 *     text, so `data: gateData` (a local const holding the batch) fell straight
 *     out of scope. Every `data:` value and every top-level `...spread` is now
 *     EXPANDED once from its local `const` initializer before scoping.
 *  2. CLASS-LITERAL DRIFT. The old checks matched only QUOTED literals
 *     (`/action\s*:\s*["'`]/`), so `action: ENTITY_CREATE_ACTION` — a const
 *     holding the identical string — passed. This is the exact shape logged in
 *     this repo's memory as `class-literal-drift`. The rule is now positive and
 *     value-blind: an in-scope call MUST spread
 *     `...deriveGatePairFromOperations(...)` and MUST carry NO top-level
 *     `action` / `subjectType` key of any kind.
 *  3. PRESENCE-ONLY POSITIVE HALF. `expect(src).toContain("deriveGatePair…")`
 *     was satisfied by the import line alone — and by the two PROSE mentions in
 *     `capture.ts` / `capture-update-arm.ts`. Comments and strings are now
 *     stripped before any scan, and the positive half asserts the derivation is
 *     spread INSIDE a `checkPermissionOrPropose(` argument list.
 */

const API_SRC = join(__dirname, "..");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    // Tests may legitimately construct literal gate options as fixtures.
    if (name.includes(".test.ts") || full.includes("__tests__")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Blank out comments and string/template bodies, preserving offsets and line
 * structure. Without this a PROSE mention of the derivation satisfies the
 * positive half, and a commented-out `action: "create"` trips the negative
 * half — both of which were live in this tree.
 */
function stripCommentsAndStrings(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** The balanced-paren argument text of every `<marker>(` call. */
function callArguments(src: string, marker: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at === -1) break;
    let depth = 0;
    let i = at + marker.length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(src.slice(at, i + 1));
    from = i + 1;
  }
  return calls;
}

/** Balanced-brace/bracket/paren text starting at `start` (which must be an opener). */
function balancedFrom(src: string, start: number): string {
  const open = src[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : ")";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

/** `const X = <initializer>` in this file, as text. Used to expand spreads. */
function localBinding(src: string, name: string): string | null {
  const re = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]{0,200})?=\\s*`, "g");
  const m = re.exec(src);
  if (!m) return null;
  const at = m.index + m[0].length;
  const c = src[at];
  if (c === "{" || c === "[" || c === "(") return balancedFrom(src, at);
  const end = src.indexOf(";", at);
  return src.slice(at, end === -1 ? src.length : end);
}

/**
 * Top-level entries of the single options object literal a gate call takes:
 * `{ key: value }` and `...spread` at brace depth 1.
 */
function topLevelEntries(
  call: string
): { key: string | null; spread: string | null; value: string }[] {
  const objAt = call.indexOf("{");
  if (objAt === -1) return [];
  const obj = balancedFrom(call, objAt);
  const inner = obj.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(inner.slice(last));
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (p.startsWith("...")) {
        return { key: null, spread: p.slice(3).trim(), value: p };
      }
      const colon = (() => {
        let d = 0;
        for (let i = 0; i < p.length; i++) {
          const ch = p[i];
          if (ch === "{" || ch === "[" || ch === "(") d++;
          else if (ch === "}" || ch === "]" || ch === ")") d--;
          else if (ch === ":" && d === 0) return i;
        }
        return -1;
      })();
      if (colon === -1) return { key: p.trim(), spread: null, value: p.trim() };
      return {
        key: p.slice(0, colon).trim(),
        spread: null,
        value: p.slice(colon + 1).trim(),
      };
    });
}

/** Bare identifier (expandable from a local const) vs member/call expression. */
const BARE_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

describe("TRIPWIRE: gate pair is derived from data.operations", () => {
  const files = collectSourceFiles(API_SRC);
  const sources = new Map(
    files.map((f) => [f, stripCommentsAndStrings(readFileSync(f, "utf8"))])
  );

  it("finds the gate call sites it is supposed to police", () => {
    const withGate = files.filter((f) =>
      sources.get(f)!.includes("checkPermissionOrPropose(")
    );
    // A scan that matches nothing proves nothing. This is the floor.
    expect(withGate.length).toBeGreaterThan(20);
  });

  it("no gate call carrying a composite batch DECLARES its pair", () => {
    const offenders: string[] = [];
    const inScope: string[] = [];

    for (const file of files) {
      const src = sources.get(file)!;
      if (!src.includes("checkPermissionOrPropose(")) continue;
      const rel = file.slice(API_SRC.length + 1);

      for (const call of callArguments(src, "checkPermissionOrPropose(")) {
        const entries = topLevelEntries(call);

        // ── SCOPE ────────────────────────────────────────────────────────
        // Expand each candidate payload ONCE from its local const so a
        // `data: gateData` / `...gateBase` spread cannot hide the batch. A
        // MEMBER expression (`parsed.data`) is not expandable and is not in
        // scope: the composite batches in this tree are all built as local
        // literals, and a single-op door that declares its own matching pair
        // is correct by the rule above.
        const payloads = entries
          .filter((e) => e.key === "data" || e.spread !== null)
          .map((e) => e.spread ?? e.value);
        const expanded = payloads
          .map((p) => {
            const t = p.trim();
            if (t.startsWith("{") || t.startsWith("[")) return t;
            if (BARE_IDENT.test(t)) return localBinding(src, t) ?? "";
            return "";
          })
          .join("\n");
        const carriesBatch = /\boperations\s*\b/.test(expanded);
        if (!carriesBatch) continue;
        inScope.push(rel);

        // ── THE RULE ─────────────────────────────────────────────────────
        // Positive: the pair comes from the derivation, spread into this very
        // call. Negative: NO top-level pair key survives — value-blind, so a
        // const (`action: ENTITY_CREATE_ACTION`) is caught exactly like a
        // quoted literal.
        const derives = /\.\.\.\s*deriveGatePairFromOperations\s*\(/.test(call);
        const declaredKeys = entries
          .filter((e) => e.key === "action" || e.key === "subjectType")
          .map((e) => e.key);

        if (!derives) {
          offenders.push(
            `${rel} — composite batch gated WITHOUT ...deriveGatePairFromOperations(ops)`
          );
        }
        if (declaredKeys.length > 0) {
          offenders.push(
            `${rel} — declares ${declaredKeys.join(" + ")} alongside a composite batch`
          );
        }
      }
    }

    // A scope filter that matches nothing makes the assertion below vacuous.
    expect(
      inScope.length,
      "no gate call was found carrying a composite operations batch — the scope " +
        "filter has gone blind, so the assertion below proves nothing"
    ).toBeGreaterThanOrEqual(2);

    expect(
      offenders,
      "A gate call carrying a composite `data.operations` batch must derive its " +
        "pair with `deriveGatePairFromOperations(ops)` from @synap/governance-policy " +
        "and declare NEITHER `action` NOR `subjectType`. A pair beside the batch — " +
        "quoted literal OR const — makes every governance floor score a declaration " +
        "instead of the write."
    ).toEqual([]);
  });

  it("the known composite gate doors REACH the derivation inside a gate call", () => {
    // Positive half. Presence of the symbol is not evidence: the import line
    // and two prose mentions of `deriveGatePairFromOperations` exist in this
    // tree. It must be SPREAD INTO the argument list of an actual gate call.
    for (const rel of ["routers/capture.ts", "utils/capture-propose.ts"]) {
      const src = stripCommentsAndStrings(
        readFileSync(join(API_SRC, rel), "utf8")
      );
      const spreadIntoGate = callArguments(
        src,
        "checkPermissionOrPropose("
      ).filter((c) =>
        /\.\.\.\s*deriveGatePairFromOperations\s*\(/.test(c)
      ).length;
      expect(
        spreadIntoGate,
        `${rel} must spread deriveGatePairFromOperations(...) into a ` +
          "checkPermissionOrPropose(...) argument list — an import line, a " +
          "comment, or an unused local does not gate anything"
      ).toBeGreaterThanOrEqual(1);
    }
  });
});
