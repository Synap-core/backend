import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";

/**
 * TRIPWIRE — every governed MCP write can state WHY, and forwards it.
 *
 * The MCP door was the only agent transport that could not give a reason. The
 * Hub accepted `reasoning` at 18 call sites; the MCP tool schemas exposed one on
 * 3 of 35 write tools and NO MCP handler forwarded it. With `reasoning` unset,
 * `checkPermissionOrPropose` stores the placeholder
 * `"<action> <type> requires your approval"`, which the review UI correctly
 * suppresses — so the reviewer reads "No reason was given for this write."
 * on a proposal whose whole body is otherwise empty.
 *
 * WHAT IS DERIVED, never hand-listed: the set of MCP tools that reach the
 * governance gate. A tool joins this scan BY EXISTING — a new write handler that
 * calls the gate, or calls a Hub mutation whose input declares `reasoning`, is
 * scanned the moment it is written. There is no exemption array, deliberately:
 * the one this replaces would have held exactly the tools that were already
 * right.
 *
 * The two membership rules, both read off source:
 *   1. the handler body calls `checkPermissionOrPropose(` itself, OR
 *   2. it calls `<something>Caller.<router>.<mutation>(` where that Hub
 *      procedure's own input declares `reasoning: z.string()`.
 *
 * WHAT THIS DOES NOT COVER, measured: a tool that reaches the gate through a
 * plain imported SERVICE function rather than the gate or a Hub caller — today
 * `synap_start_session` / `synap_complete_session` / `synap_update_session`
 * (services/focus-sessions/*, which reach `checkPermissionOrPropose` but expose
 * no `reasoning` parameter to forward one INTO). Verified by widening the scan
 * to one-level import resolution: exactly those three appear, and no other.
 * Closing them means teaching those services a `reasoning` parameter first.
 *
 * NEGATIVE CONTROL (run before landing): remove the `reasoning` forward at
 * `handlers/entity.ts:97` from `synap_create_entity` and this fails with
 * "synap_create_entity reaches the governance gate ... but its handler never
 * forwards `reasoning`". That tool is the control DELIBERATELY: its body still
 * contains the word `reasoning` afterwards, in the `aiMetadata` provenance stamp
 * two lines above, so a control on a tool without that decoy would pass while
 * the hole was real — which is exactly what happened with the previous control
 * (`synap_promote_cell_to_renderer`, no second occurrence). Removing the
 * `reasoning` property from a gated tool's `inputSchema` fails the schema
 * assertion instead.
 */

const API_SRC = resolve(__dirname, "..");
const HANDLERS = join(API_SRC, "routers/mcp/handlers");
const HUB = join(API_SRC, "routers/hub-protocol");
const TOOLS_INDEX = join(API_SRC, "routers/mcp/tools/index.ts");
const MANIFEST = join(API_SRC, "routers/mcp/tools/mcp-tools.manifest.json");
const PERMISSION_CHECK = join(API_SRC, "utils/permission-check.ts");

/**
 * The floor is a NON-VACUITY guard, not a target: it is below the count derived
 * at the time of writing (15), so removing a whole handler family trips it while
 * an honest single-tool retirement does not.
 */
const MIN_GATED_TOOLS = 14;

/** `import { a, b as c } from "./x.js"` → local name → resolved .ts path. */
function resolveRelativeImports(file: string): Map<string, string> {
  const src = readFileSync(file, "utf8");
  const out = new Map<string, string>();
  for (const m of src.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g
  )) {
    let target = resolve(dirname(file), m[2].replace(/\.js$/, ".ts"));
    if (!existsSync(target)) target = target.replace(/\.ts$/, "/index.ts");
    if (!existsSync(target)) continue;
    for (const part of m[1].split(",")) {
      const t = part.trim().replace(/^type\s+/, "");
      if (!t) continue;
      const [orig, alias] = t.split(/\s+as\s+/);
      out.set((alias ?? orig).trim(), target);
    }
  }
  return out;
}

/**
 * Split a source file into top-level-ish member blocks keyed by name, by cutting
 * at each declaration mark and running to the next. Coarse on purpose: the
 * assertions below only ask "does THIS member's text contain X", and a block
 * that over-reaches its neighbour would make the guard MORE permissive, which is
 * why every membership rule is paired with a positive self-check.
 */
function memberBlocks(src: string, markRe: RegExp): Map<string, string> {
  const marks = [...src.matchAll(markRe)];
  const out = new Map<string, string>();
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index!;
    const end = i + 1 < marks.length ? marks[i + 1].index! : src.length;
    out.set(marks[i][1], src.slice(start, end));
  }
  return out;
}

/** router key (`profiles`) → the sub-router file it is composed from. */
function hubRouterFiles(): Map<string, string> {
  const indexPath = join(HUB, "index.ts");
  const src = readFileSync(indexPath, "utf8");
  const imports = resolveRelativeImports(indexPath);
  const body = src.slice(src.indexOf("export const hubProtocolRouter"));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/^\s{2}(\w+):\s*(\w+),/gm)) {
    const file = imports.get(m[2]);
    if (file) out.set(m[1], file);
  }
  return out;
}

/** `profiles.setRenderer` … for every Hub procedure whose input takes a reason. */
function hubProceduresAcceptingReasoning(): Set<string> {
  const out = new Set<string>();
  for (const [routerKey, file] of hubRouterFiles()) {
    const blocks = memberBlocks(
      readFileSync(file, "utf8"),
      /^ {2}(\w+):\s*(?:public|protected|scoped|\w+)Procedure/gm
    );
    for (const [proc, block] of blocks) {
      if (/reasoning:\s*z\.string\(\)/.test(block)) {
        out.add(`${routerKey}.${proc}`);
      }
    }
  }
  return out;
}

interface GatedTool {
  tool: string;
  file: string;
  body: string;
  /** Why it is in the set — quoted in the failure message. */
  via: string[];
}

function deriveGatedTools(): GatedTool[] {
  const reasoningProcs = hubProceduresAcceptingReasoning();
  const gated: GatedTool[] = [];
  for (const entry of readdirSync(HANDLERS)) {
    if (!entry.endsWith(".ts") || entry.includes(".test.")) continue;
    const path = join(HANDLERS, entry);
    const src = readFileSync(path, "utf8");
    const fileMembers = memberBlocks(
      src,
      /^(?:export )?(?:async )?function (\w+)/gm
    );
    for (const [tool, rawBlock] of memberBlocks(src, /^ {2}(synap_\w+):/gm)) {
      // `captureHandlers` maps two tool names onto one shared function — follow
      // the alias so the shared body is what gets scanned, not the one-line map
      // entry (which contains nothing and would pass every assertion).
      const alias = rawBlock.match(/^ {2}synap_\w+:\s*(\w+),/);
      const block = (alias && fileMembers.get(alias[1])) || rawBlock;

      const via: string[] = [];
      if (/checkPermissionOrPropose\(\{/.test(block)) {
        via.push("checkPermissionOrPropose");
      }
      for (const m of block.matchAll(/\b\w*[Cc]aller\.(\w+)\.(\w+)\(/g)) {
        const key = `${m[1]}.${m[2]}`;
        if (reasoningProcs.has(key) && !via.includes(key)) via.push(key);
      }
      if (via.length > 0) gated.push({ tool, file: entry, body: block, via });
    }
  }
  return gated;
}

/** The `properties` object of one tool's `inputSchema`, from the SHIPPED manifest. */
function manifestToolProperties(): Map<string, Record<string, unknown>> {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    tools: Array<{
      name: string;
      inputSchema?: { properties?: Record<string, unknown> };
    }>;
  };
  return new Map(
    manifest.tools.map((t) => [t.name, t.inputSchema?.properties ?? {}])
  );
}

describe("tripwire: every governed MCP write carries a reason", () => {
  const gated = deriveGatedTools();

  it("the derivation is not vacuous and can still see a known member", () => {
    // A scan that matched nothing would pass every assertion after it.
    expect(hubProceduresAcceptingReasoning().size).toBeGreaterThanOrEqual(10);
    expect(gated.length).toBeGreaterThanOrEqual(MIN_GATED_TOOLS);

    // Positive self-check on BOTH membership rules, on tools whose route to the
    // gate is different: one calls the gate directly, one goes through a Hub
    // mutation. If either rule silently stopped matching, this is what says so.
    const byName = new Map(gated.map((g) => [g.tool, g]));
    expect(byName.get("synap_create_cell")?.via).toContain(
      "checkPermissionOrPropose"
    );
    expect(byName.get("synap_promote_cell_to_renderer")?.via).toContain(
      "profiles.setRenderer"
    );
  });

  it("every gated tool's handler forwards `reasoning` to the gate", () => {
    // The AGENT'S value, not the word. This filter used to accept any
    // occurrence of `\breasoning\b`, which `handlers/entity.ts:93` satisfies
    // with `aiMetadata: { model: "mcp", reasoning: \`MCP tool: ${toolName}\` }`
    // — provenance ("which tool wrote this"), never a why, as the comment two
    // lines below it says. So `synap_create_entity` could drop its governance
    // forward entirely and this stayed green. A hard-coded server string
    // (`reasoning: "Created via MCP"`) is the same decoy one shape over.
    //
    // GRANULARITY, measured: the scan is the HANDLER BLOCK, not the call site.
    // A handler that reads the agent's reason and forwards it into ONE of two
    // gate calls passes on the strength of the first — `synap_create_document`
    // has exactly that shape (`entity.ts:274` forwards it, `:324` hard-codes a
    // server reason for the follow-up attach). Verified by deleting :274 alone
    // and watching this go red, and by deleting :97 with the `aiMetadata` decoy
    // at :93 left in place.
    const offenders = gated
      .filter(
        (g) =>
          !/readReasoning\(args\)/.test(g.body) &&
          !/args\s*\.\s*reasoning\b/.test(g.body)
      )
      .map(
        (g) => `${g.tool} (${g.file}, reaches the gate via ${g.via.join(", ")})`
      );
    expect(
      offenders,
      `These MCP tools reach the governance gate but their handler never forwards \`reasoning\`, so every proposal they file reads "No reason was given for this write." Forward it with \`...(readReasoning(args) ? { reasoning: readReasoning(args) } : {})\` — do NOT add an exemption list.\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every gated tool's input schema DECLARES `reasoning` (source and manifest)", () => {
    const toolsSrc = readFileSync(TOOLS_INDEX, "utf8");
    const properties = manifestToolProperties();

    const missing: string[] = [];
    for (const g of gated) {
      // The shipped artifact is the thing an agent actually reads.
      const props = properties.get(g.tool);
      expect(
        props,
        `${g.tool} is missing from mcp-tools.manifest.json`
      ).toBeDefined();
      if (!props || !("reasoning" in props))
        missing.push(`${g.tool} (manifest)`);
      // …and the source it is generated from, so a stale manifest cannot pass.
      const declStart = toolsSrc.indexOf(`name: "${g.tool}",`);
      const nextTool = toolsSrc.indexOf('name: "synap_', declStart + 1);
      const decl = toolsSrc.slice(
        declStart,
        nextTool === -1 ? toolsSrc.length : nextTool
      );
      if (declStart === -1 || !/\n\s*reasoning: \{/.test(decl)) {
        missing.push(`${g.tool} (tools/index.ts)`);
      }
    }
    expect(
      missing,
      `An agent cannot supply a reason it was never offered. Add an optional \`reasoning\` string to these tools' inputSchema and re-run \`pnpm --filter @synap/api gen:mcp-manifest\`:\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("the two spellings of the trailing-s strip are the SAME expression", () => {
    // The strip exists twice on purpose. `createProposal` keeps it INLINE
    // because a peer tripwire (`severed-approval-doors.test.ts` (5))
    // source-scans for that exact literal to prove the gate's plural subject
    // (`subjectType: "workspaces"`) still lands on the executor's singular key;
    // routing it through the helper blinds that guard — which this wave did,
    // and this assertion is the reason it cannot happen silently again.
    //
    // Two spellings of one rule can drift, and neither can be driven
    // behaviourally here (the inline half sits mid-way through a DB-backed
    // function). So compare the EXPRESSIONS, derived from source on both sides
    // rather than hand-copied into this file.
    const src = readFileSync(PERMISSION_CHECK, "utf8");
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

    const inline = src.match(/const singularType =([\s\S]*?);/)?.[1];
    const helper = src.match(
      /function singularSubjectType\(subjectType: string\): string \{\s*return([\s\S]*?);/
    )?.[1];

    // Non-vacuity: a regex that matched nothing would make the compare trivial.
    expect(
      inline,
      "the inline strip in createProposal was not found"
    ).toBeTruthy();
    expect(helper, "singularSubjectType was not found").toBeTruthy();
    expect(normalize(inline!)).toContain('endsWith("s")');

    expect(
      normalize(inline!),
      "createProposal's inline trailing-s strip and `singularSubjectType` no longer compute the same thing — the receipt title and the stored summary will disagree on a plural subject (`workspaces`, `apiKeys`)"
    ).toBe(normalize(helper!));
  });

  it("both agent-receipt session mints pass the proposal's own summary", () => {
    // The BINDING, not the deriver: `deriveAgentProposalSessionGoal` ranks a
    // supplied `summary` above the `Agent <type> · <target>` machine-token
    // fallback, but only for a caller that actually passes one. There are
    // exactly two producers, both in permission-check.ts (the provenance hoist
    // and the pending-row mint), and dropping the argument at either is
    // invisible until a receipt session shows up titled with two DB tokens.
    const src = readFileSync(PERMISSION_CHECK, "utf8");
    const calls = [
      ...src.matchAll(/deriveAgentProposalSessionGoal\(\{([\s\S]*?)\}\)/g),
    ];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(
        call[1],
        "a deriveAgentProposalSessionGoal call site does not pass `summary` — its receipt session will be titled `Agent <type> · <target>`"
      ).toMatch(/summary:\s*buildProposalSummary\(/);
    }
  });
});
