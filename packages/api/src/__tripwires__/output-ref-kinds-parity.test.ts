import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUTPUT_REF_KINDS } from "@synap/playbooks";
import { SESSION_ARTIFACT_KINDS } from "../services/focus-sessions/record-session-artifact.js";
import { tools } from "../routers/mcp/tools/index.js";

/**
 * TRIPWIRE — the output-slot `ref` KIND UNION has one source and several
 * mirrors, and the mirrors are checked.
 *
 * This file is the guard the `OUTPUT_REF_KINDS` docblock (@synap/playbooks)
 * cites by name. Until it was written, that citation was the codebase's
 * signature defect in its purest form: a comment asserting a guard that does
 * not exist, self-certifying, because the next reader trusts the sentence
 * instead of running `ls`.
 *
 * ── THE SOURCE ──────────────────────────────────────────────────────────────
 * `artifacts.kind` (the Postgres enum) → `SESSION_ARTIFACT_KINDS`
 * (`record-session-artifact.ts`, read off `.enumValues`) → minus `url`, which is
 * the OTHER arm of `OutputRef` rather than a kind. Everything below is compared
 * against THAT, derived at runtime — never against a list written in this file.
 *
 * ── THE MIRRORS THIS AUDITS ─────────────────────────────────────────────────
 *   1. `OUTPUT_REF_KINDS` (@synap/playbooks) — the domain constant. Duplicated
 *      from the column rather than imported because that package is
 *      dependency-free by design.
 *   2. `FocusSessionExpectedOutput.ref` (@synap/hub-rest-client `types.ts`) — a
 *      hand-written literal union, for the same dependency-free reason. Parsed
 *      out of SOURCE: the package publishes types only, so there is nothing to
 *      import at runtime.
 *   3. Every `ref` enum the MCP tools EMIT, found by walking `tools.list()`
 *      rather than by naming three call sites. These are now `[...OUTPUT_REF_KINDS]`
 *      in `tools/index.ts` (they were three hand-written copies), so this
 *      assertion is a REGRESSION guard: it goes red if anyone retypes one.
 *   4. The same enums in the COMMITTED manifest — the artifact the Control Plane
 *      generates its `pod__*` surface from, and therefore what a client sees.
 *   5. The PROSE list inside each `ref` description (`"entity|document|view|…"`),
 *      compared as a SET. Prose is what the model actually reads; a description
 *      naming a kind the enum refuses is an advertised dead end, which is the
 *      defect this whole area keeps producing.
 *
 * ── WHAT THIS CANNOT SEE, measured, not implied ─────────────────────────────
 * `OutputRef` in `browser/electron/renderer/src/.../sessionRoomTabs.ts` and any
 * relay mirror are in OTHER REPOSITORIES; a cross-repo scan is out of this
 * test's reach, exactly as `cross-door-input-parity`'s header says of the IS and
 * the CLI. Saying so is the honest move; asserting coverage nobody runs is the
 * failure this file exists to end. Nothing here proves a kind is ADJUDICABLE
 * either — that the visibility floor has a branch for it — which is
 * `assert-output-ref-visible.test.ts`'s job, including its default arm.
 *
 * ⚠️ ONE MORE THING IT CANNOT SEE, and it bit the first negative control: `api`
 * resolves `@synap/playbooks` through that package's `exports` map to its BUILT
 * `dist/index.js`, not `src`. Editing `OUTPUT_REF_KINDS` in source and running
 * this alone reads GREEN until `pnpm --filter @synap/playbooks build`. Same
 * hazard the vocabulary rule documents for `@synap-core/types`. Rebuild before
 * trusting a green here after a source edit.
 *
 * NEGATIVE CONTROLS (run before landing, each reverted after; the mutated line
 * was grepped back to prove it landed):
 *   • drop `"playbook"` from `OUTPUT_REF_KINDS` (in `dist`, per the note above)
 *     → 2 red: the derivation assertion and the emitted-enum assertion. The
 *     manifest and hub-rest-client assertions stay GREEN, correctly — they are
 *     compared against the COLUMN, which did not move, so they are still right
 *     while the constant is wrong.
 *   • retype the first `tools/index.ts` enum as a five-kind literal → 1 red,
 *     the emitted-enum assertion only. The manifest stays green, which is the
 *     honest split: the committed artifact really has not changed yet.
 *   • drop `"cell"` from the hub-rest-client union → 2 red, the mirror
 *     assertion (naming the file) and the non-vacuity floor beneath it.
 */

const HUB_TYPES = resolve(__dirname, "../../../hub-rest-client/src/types.ts");
const MANIFEST = resolve(
  __dirname,
  "../routers/mcp/tools/mcp-tools.manifest.json"
);

/** The kind list, DERIVED from the column the artifacts table declares. */
const DERIVED = [...SESSION_ARTIFACT_KINDS].filter((k) => k !== "url").sort();

const sorted = (v: readonly string[]) => [...v].sort();

/**
 * The `kind` literals of `FocusSessionExpectedOutput.ref`'s in-pod arm, read out
 * of the hub-rest-client SOURCE.
 *
 * Anchored at BOTH ends: from the `ref?:` property declaration to the `id:
 * string` that closes that arm. An unanchored scan would collect string
 * literals from any union in a 900-line types file and pass on the wrong one.
 */
function hubRestClientRefKinds(): string[] {
  const src = readFileSync(HUB_TYPES, "utf8");
  const arm = /\bref\?:[\s\S]{0,400}?kind:([\s\S]*?)id:\s*string/.exec(src);
  if (!arm) return [];
  return [...arm[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/**
 * Every `{ kind: enum }` a `ref` property advertises anywhere in a JSON Schema
 * tree, with the path that found it.
 *
 * DERIVED BY WALKING — a fourth `ref` on a fifth tool joins this audit by
 * EXISTING. A hand-listed set of three call sites is the very defect the header
 * describes, one level up from where it was fixed.
 */
function refKindEnums(
  node: unknown,
  path = "$",
  out: Array<{ path: string; kinds: string[] }> = []
): Array<{ path: string; kinds: string[] }> {
  if (Array.isArray(node)) {
    node.forEach((v, i) => refKindEnums(v, `${path}[${i}]`, out));
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const obj = node as Record<string, unknown>;
  const kindEnum = (
    (obj.properties as Record<string, unknown> | undefined)?.kind as
      { enum?: unknown } | undefined
  )?.enum;
  if (path.endsWith(".ref") || /\.ref\.oneOf\[\d+\]$/.test(path)) {
    if (Array.isArray(kindEnum)) {
      out.push({ path, kinds: kindEnum as string[] });
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    refKindEnums(v, `${path}.${k}`, out);
  }
  return out;
}

/** The `a|b|c` list a `ref` description spells out for the model. */
function refDescriptionKinds(
  node: unknown,
  out: Array<{ where: string; kinds: string[] }> = [],
  where = "$"
): Array<{ where: string; kinds: string[] }> {
  if (Array.isArray(node)) {
    node.forEach((v, i) => refDescriptionKinds(v, out, `${where}[${i}]`));
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (
      k === "ref" &&
      v &&
      typeof v === "object" &&
      typeof (v as { description?: unknown }).description === "string"
    ) {
      const m = /"kind"\s*:\s*"([a-z|]+)"/.exec(
        (v as { description: string }).description
      );
      if (m) out.push({ where: `${where}.ref`, kinds: m[1]!.split("|") });
    }
    refDescriptionKinds(v, out, `${where}.${k}`);
  }
  return out;
}

const TOOL_LIST = (await tools.list()) as unknown as Array<
  Record<string, unknown>
>;
const MANIFEST_TOOLS = (
  JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    tools: Array<Record<string, unknown>>;
  }
).tools;

describe("tripwire: the output-slot `ref` kind union has ONE source", () => {
  it("NON-VACUITY: the derivation and both scans found a plausible set", () => {
    // A scan that matched nothing passes every assertion after it.
    expect(SESSION_ARTIFACT_KINDS.length).toBeGreaterThanOrEqual(7);
    expect(DERIVED.length).toBeGreaterThanOrEqual(6);
    expect(TOOL_LIST.length).toBeGreaterThan(20);
    expect(MANIFEST_TOOLS.length).toBeGreaterThan(20);
    // SELF-CHECK on each scanner: it can still see a literal sample of what it
    // hunts. If a formatting change blinds one, this reads red instead of the
    // parity assertions passing over an empty set.
    expect(hubRestClientRefKinds().length).toBeGreaterThanOrEqual(6);
    expect(refKindEnums(TOOL_LIST).length).toBeGreaterThanOrEqual(3);
    expect(refKindEnums(MANIFEST_TOOLS).length).toBeGreaterThanOrEqual(3);
    expect(refDescriptionKinds(TOOL_LIST).length).toBeGreaterThanOrEqual(3);
  });

  it("OUTPUT_REF_KINDS is exactly `artifacts.kind` minus `url`", () => {
    expect(
      sorted(OUTPUT_REF_KINDS),
      "`OUTPUT_REF_KINDS` (@synap/playbooks) no longer mirrors " +
        "`SESSION_ARTIFACT_KINDS` minus `url`. Widening the column means " +
        "teaching `isOutputRefVisible` that kind FIRST, then updating the " +
        "constant — a kind the floor cannot adjudicate is one every door must " +
        "refuse."
    ).toEqual(DERIVED);
  });

  it("the hub-rest-client's duplicated union mirrors it", () => {
    expect(
      sorted(hubRestClientRefKinds()),
      "`FocusSessionExpectedOutput.ref` (packages/hub-rest-client/src/types.ts) " +
        "declares a different kind set from `OUTPUT_REF_KINDS`. That package is " +
        "dependency-free by design, so the union is duplicated there on purpose " +
        "— this is the check that keeps the duplication honest. Update the " +
        "literal; do not import."
    ).toEqual(DERIVED);
  });

  it("every `ref` enum the MCP tools EMIT mirrors it", () => {
    const wrong = refKindEnums(TOOL_LIST)
      .filter((e) => sorted(e.kinds).join() !== DERIVED.join())
      .map((e) => `${e.path}: [${e.kinds.join(", ")}]`);
    expect(
      wrong,
      "An MCP tool advertises a `ref.kind` enum that is not the union. These " +
        "are `[...OUTPUT_REF_KINDS]` in routers/mcp/tools/index.ts precisely so " +
        "they cannot drift — a red here means someone retyped one as a " +
        "literal:\n  " +
        wrong.join("\n  ")
    ).toEqual([]);
  });

  it("the COMMITTED manifest carries the same set", () => {
    // The published artifact is what the Control Plane generates its `pod__*`
    // surface from, so a stale manifest is a wrong contract shipped to
    // claude.ai even when the source is right. Freshness itself is
    // `manifest-freshness.test.ts`; this is the union, specifically.
    const wrong = refKindEnums(MANIFEST_TOOLS)
      .filter((e) => sorted(e.kinds).join() !== DERIVED.join())
      .map((e) => `${e.path}: [${e.kinds.join(", ")}]`);
    expect(
      wrong,
      "mcp-tools.manifest.json advertises a `ref.kind` enum that is not the " +
        "union. Run `pnpm --filter @synap/api gen:mcp-manifest`:\n  " +
        wrong.join("\n  ")
    ).toEqual([]);
  });

  it("the PROSE each tool shows the model names the same kinds", () => {
    // Order differs deliberately (the description leads with the kinds an agent
    // reaches for first), so this compares SETS, not sequences.
    const wrong = refDescriptionKinds(TOOL_LIST)
      .filter((e) => sorted(e.kinds).join() !== DERIVED.join())
      .map((e) => `${e.where}: [${e.kinds.join("|")}]`);
    expect(
      wrong,
      "A `ref` description names a kind set the enum beside it does not accept. " +
        "The prose is what the model reads, so a kind listed there and refused " +
        "at the parse is an advertised dead end — and one missing from the " +
        "prose is a capability nobody will use:\n  " +
        wrong.join("\n  ")
    ).toEqual([]);
  });
});
