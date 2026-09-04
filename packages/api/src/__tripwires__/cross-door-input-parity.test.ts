import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * TRIPWIRE (T5) — cross-door INPUT parity, by ACKNOWLEDGEMENT not symmetry.
 *
 * The mirror image of `cross-door-field-parity.test.ts` (T4). T4 asks "when a
 * door answers, does the answer still carry what the service computed". T5 asks
 * the question one step earlier and in the other direction: **can a caller at
 * this door even SAY the thing the service accepts?**
 *
 * THE FAILURE THIS CATCHES, measured, live in this tree as the RED proof for
 * this file: `executeCapability` declares twelve parameters. The tRPC door —
 * which is the BROWSER door, the one a human clicks — declares four. It cannot
 * pass `sessionId`, `channelId`, `sourceMessageId` or `idempotencyKey`, so:
 *   • every capability run launched from the browser lands with
 *     `proposals.session_id = NULL`. That is not a theory: the measured
 *     session-provenance rate on the live pod is 2.6%, and this door is why.
 *     The Why-pane, the run feed grouping and every "which operation was this
 *     part of" surface are structurally starved at the door, not at the column.
 *   • the origin-trust classification (rung 2.55) can never activate on a
 *     browser-launched run, because the acting channel never arrives.
 *   • a retried browser run has no caller idempotency key, so it falls to the
 *     derived content-hash window rather than a real correlation.
 *
 * None of that is visible from inside the door. A parameter the service accepts
 * and a door never declares is INDISTINGUISHABLE, from outside, from a
 * parameter that door deliberately withholds — both read as "you can't ask for
 * that here". T4's whole argument applies unchanged on the input side; this
 * file is that argument, one arrow-direction over.
 *
 * ── WHY A TYPE-LEVEL MECHANISM CANNOT DO THIS ───────────────────────────────
 * Every parameter of `executeCapability` past `verbId`/`workspaceId`/`userId`
 * is OPTIONAL — that is what makes the door contracts type-check while dropping
 * them. TypeScript's answer to "this door never passes `sessionId`" is, and must
 * be, silence: omitting an optional property is legal. The doors are also three
 * different KINDS of declaration — a zod-4 `.input()`, a `@hono/zod-openapi`
 * request schema, and a hand-written JSON Schema literal — so there is no single
 * type to be wrong about. Source scanning is the only mechanism that survives
 * that, exactly as in T4.
 *
 * ── WHAT IS DERIVED (both properties are mandatory, both are asserted) ───────
 * 1. The PARAMETER LIST is EXTRACTED from the service's own inline parameter
 *    object in source — never hand-listed. Add a thirteenth parameter to
 *    `executeCapability` and every door owes an answer for it on the next run.
 *    A hand-kept list here would be the very defect this file exists to catch,
 *    one level up.
 * 2. The DOOR LIST is DISCOVERED by walking `routers/` for files that import
 *    the service (statically or through `await import(...)`, which is how the
 *    MCP handler reaches it) — never a fixed path list. Split a handler out and
 *    the new file is audited the moment it wires up.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 * For each audited service, every parameter must either be REACHABLE through
 * each discovered door, or carry an {@link ACKNOWLEDGED_GAPS} entry naming the
 * door, the parameter, and a CHECKABLE reason.
 *
 * ── HOW REACHABILITY IS DECIDED (two rules, both arguable) ──────────────────
 * A parameter is REACHABLE at a door when either:
 *   (a) DECLARED — the parameter name appears as a property key in that door's
 *       own INPUT CONTRACT: the tRPC procedure's `.input(z.object({…}))`, the
 *       Hub route's parsed request schema, or the MCP tool's `inputSchema`
 *       published `inputSchema` in the committed MCP manifest. The contract is
 *       resolved PER
 *       DOOR and per declaration site — never "some schema in this file" — for
 *       the same reason T4 judges a door as a call site rather than a file: one
 *       route's schema must never vouch for another's omission. Note the MCP
 *       contract lives in a DIFFERENT FILE from the MCP handler; a file-local
 *       search would have found nothing and reported twelve phantom drops.
 *   (b) SERVER-SUPPLIED — the door passes the parameter at the call site from
 *       something the client does not control (`userId: ctx.userId`,
 *       `agentUserId: agentUserId ?? null`, `sessionId` off the X-Session-Id
 *       header). The value still reaches the service, so nothing is lost; a
 *       client simply is not the one who says it. A bare `field: null` /
 *       `field: undefined` does NOT count — that is a hardcoded absence wearing
 *       a forward's clothes, and it is precisely how a parameter can look wired
 *       while being permanently dead.
 *
 * ── WHAT THIS CAN AND CANNOT PROVE ──────────────────────────────────────────
 * A regex match proves a NAME APPEARS in a contract or an argument object. It
 * does not prove the declared type is right, that the value is threaded from
 * the right place, or that the handler does anything with it. Coverage here is
 * an OVER-approximation in exactly T4's direction: this file under-reports and
 * never invents a drop. What it reports RED is a name that appears NOWHERE in
 * that door's contract and nowhere in its call.
 *
 * ── DOORS THIS FILE CANNOT SEE (stated, not silently omitted) ───────────────
 * `executeCapability` also has callers OUTSIDE this repo:
 *   • the Intelligence Service's `run_capability` tool (zod 3, cannot import
 *     the zod-4 contract) — it reaches the pod over Hub REST, so its ceiling is
 *     the Hub door audited here, and its own tool schema is checked against the
 *     committed JSON Schema artifact by `capability-execute-schema-freshness`.
 *   • `synap-cli`, which builds request bodies dynamically.
 * A cross-repo scan is out of this test's reach. Saying so here is the honest
 * move; asserting coverage nobody checks is the `get_document` failure T4's
 * header describes, and it is not repeated.
 */

// ── Audited services ─────────────────────────────────────────────────────────

const API_SRC = join(__dirname, "..");
const ROUTERS_DIR = join(API_SRC, "routers");
/**
 * The MCP tool CONTRACTS live neither beside their handlers nor, any longer, as
 * source literals: `synap_run_capability`'s `inputSchema` is now DERIVED from
 * the shared contract at module load. So this audit reads the PUBLISHED
 * ARTIFACT — the committed manifest, which is what the Control Plane generates
 * its curated `pod__*` surface from and therefore what a client actually sees.
 * Its own freshness is guarded by `mcp/tools/manifest-freshness.test.ts`; using
 * it here means a derived schema is judged by what it EMITS rather than by
 * whether a regex could still find a literal.
 */
const MCP_MANIFEST = join(
  ROUTERS_DIR,
  "mcp",
  "tools",
  "mcp-tools.manifest.json"
);

interface ServiceSpec {
  key: string;
  /** Absolute path to the module that EXPORTS `fn` — the import-discovery seed. */
  file: string;
  /** Exported function whose INLINE parameter object declares the contract. */
  fn: string;
  /** Minimum parameters a healthy extraction must find (non-vacuity). */
  paramFloor: number;
}

const SERVICES: ServiceSpec[] = [
  {
    key: "execute-capability",
    file: join(API_SRC, "services/capabilities/execute-capability.ts"),
    fn: "executeCapability",
    paramFloor: 10,
  },
];

// ── Source utilities (same contract as T4: prose documents, only code implements) ──

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  "__tripwires__",
  "__tests__",
]);

/** RULE 1: recursive walk — never a file-path list. */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      out.push(...collectSources(full));
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
    if (name.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

function isQuote(ch: string): boolean {
  return ch === '"' || ch === "'" || ch === "`";
}

function skipString(source: string, i: number): number {
  const quote = source[i]!;
  for (let j = i + 1; j < source.length; j += 1) {
    if (source[j] === "\\") {
      j += 1;
      continue;
    }
    if (source[j] === quote) return j;
  }
  return source.length;
}

/** From an opening bracket to its match, inclusive. String-aware. */
function sliceBalanced(source: string, open: number): string {
  const opener = source[open]!;
  const closer = opener === "{" ? "}" : opener === "(" ? ")" : "]";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]!;
    if (isQuote(ch)) {
      i = skipString(source, i);
      continue;
    }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/** Property keys declared at depth 1 of a `{ … }` body, string- and depth-aware. */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let prev = "{";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (isQuote(ch)) {
      i = skipString(body, i);
      prev = '"';
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth += 1;
      prev = ch;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      prev = ch;
      continue;
    }
    if (/\s/.test(ch)) continue;
    if (/[A-Za-z_$]/.test(ch) && depth === 1 && /[{;,]/.test(prev)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(body.slice(i))![0];
      if (/^\s*\??\s*:/.test(body.slice(i + m.length))) keys.push(m);
      i += m.length - 1;
      prev = "x";
      continue;
    }
    prev = ch;
  }
  return [...new Set(keys)];
}

// ── Parameter extraction (derived from the service's own signature) ──────────

/**
 * The `{ … }` of `export async function fn(input: { … })`.
 *
 * WORD-BOUNDED on the function name for T4's reason: a prefix match would
 * extract a DIFFERENT function's parameters with every non-vacuity assertion
 * still green — confident nonsense, which is worse than an empty audit.
 */
function extractParamBody(source: string, fn: string): string {
  const m = new RegExp(
    `export\\s+(?:async\\s+)?function\\s+${fn}\\s*\\(\\s*\\w+\\s*:\\s*\\{`
  ).exec(source);
  if (!m) return "";
  return sliceBalanced(source, m.index + m[0].length - 1);
}

function paramsOf(spec: ServiceSpec): string[] {
  const source = stripComments(readFileSync(spec.file, "utf8"));
  return topLevelKeys(extractParamBody(source, spec.fn));
}

// ── Door discovery (walk for importers — never a fixed path list) ────────────

type DoorRole = "trpc" | "hub_rest" | "mcp";

interface Door {
  role: DoorRole;
  /** Stable id: repo-relative file + the call site's own name. */
  id: string;
  /** The `{ … }` argument object handed to the service at this call site. */
  callArgs: string;
  /** This door's OWN declared input contract, resolved per door. */
  contract: string;
  /** Whole file, comments stripped. */
  file: string;
}

/** Modules through which `spec.fn` can be imported: the file, plus any barrel. */
function exposingModules(spec: ServiceSpec): string[] {
  const mods = [spec.file];
  const barrel = join(dirname(spec.file), "index.ts");
  if (existsSync(barrel)) {
    const src = stripComments(readFileSync(barrel, "utf8"));
    if (new RegExp(`export\\s*\\{[^}]*\\b${spec.fn}\\b[^}]*\\}`).test(src)) {
      mods.push(barrel);
    }
  }
  return mods;
}

/**
 * Every module specifier a file imports, static or dynamic, resolved to .ts.
 *
 * The DYNAMIC form is load-bearing here and not an afterthought: the MCP
 * handler reaches the service through `await import("…/execute-capability.js")`
 * inside the tool body. A static-only import walk finds no MCP door at all and
 * this whole audit reads green over the agent-facing surface.
 */
function importedPaths(file: string, source: string): string[] {
  const out: string[] = [];
  const specifiers = [
    ...source.matchAll(/from\s*["']([^"']+)["']/g),
    ...source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g),
  ];
  for (const m of specifiers) {
    const raw = m[1]!;
    if (!raw.startsWith(".")) continue;
    out.push(resolve(dirname(file), raw.replace(/\.js$/, ".ts")));
  }
  return out;
}

function classify(file: string, source: string): DoorRole | null {
  if (file.includes(join("routers", "mcp"))) return "mcp";
  if (file.includes(join("routers", "hub-protocol"))) return "hub_rest";
  if (/=\s*router\(\{/.test(source)) return "trpc";
  return null;
}

/** The innermost `{ … }` block that CONTAINS `idx`, as `[open, close]`. */
function enclosingBlock(src: string, idx: number): [number, number] | null {
  const stack: number[] = [];
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (isQuote(ch)) {
      i = skipString(src, i);
      continue;
    }
    if (ch === "{") stack.push(i);
    else if (ch === "}") {
      const open = stack.pop();
      if (open !== undefined && open < idx && i > idx) return [open, i];
    }
  }
  return null;
}

const CALL_SITE_LABEL =
  /app\.(?:post|get|put|patch|delete)\(\s*["']([^"']+)["']|function\s+(\w+)\s*\(|(\w+)\s*:\s*async|(\w+)\s*:\s*(?:protected|workspace|public|pod|admin)Procedure/g;

function callSiteLabel(
  src: string,
  blockOpen: number,
  fallback: number
): string {
  const preamble = src.slice(0, blockOpen);
  let label: string | null = null;
  for (const m of preamble.matchAll(CALL_SITE_LABEL)) {
    label = m[1] ?? m[2] ?? m[3] ?? m[4] ?? label;
  }
  return label ?? `site${fallback}`;
}

// ── Per-door input contract resolution ───────────────────────────────────────

/** The `{ … }` argument object of the FIRST `fn(` call inside `region`. */
function callArgObject(region: string, fn: string): string {
  const m = new RegExp(`\\b${fn}\\s*\\(`).exec(region);
  if (!m) return "";
  const open = region.indexOf("{", m.index + m[0].length - 1);
  return open < 0 ? "" : sliceBalanced(region, open);
}

/** From `start` to the `;` that closes the statement at bracket depth 0. */
function sliceToStatementEnd(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    if (isQuote(ch)) {
      i = skipString(source, i);
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (ch === ";" && depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

/**
 * The `z.object({ … })` body a schema IDENTIFIER ultimately resolves to,
 * FOLLOWING an import when the identifier is declared in another module.
 *
 * Following the import is the whole point of a shared contract, not a
 * convenience: `const RequestSchema = z.object({…})` is a door declaring its own
 * shape, while `.input(CapabilityExecuteInput.extend({…}))` is a door adopting
 * the SSOT. A resolver that only understood the first would go dark the moment
 * a door was consolidated onto the contract — reporting every parameter as
 * unreachable at exactly the door that just fixed itself, which is the "a guard
 * dies of noise" failure T4's header describes.
 *
 * `depth` bounds the hop count so a cyclic re-export cannot hang the run.
 */
function resolveSchemaIdentifier(
  file: string,
  source: string,
  name: string,
  depth = 3
): string {
  if (depth <= 0 || name === "z") return "";
  const local = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=]*)?=\\s*`
  ).exec(source);
  if (local) {
    const at = local.index + local[0].length;
    // WHITESPACE-TOLERANT: prettier breaks a chained builder as `z\n  .object({`
    // and a `/z\.object\(/` pattern sees NONE of those — the formatting that hid
    // three declared schemas from T4 in this file's sibling.
    const obj = /^\s*z\s*\.\s*object\s*\(/.exec(source.slice(at, at + 400));
    if (obj) {
      const open = source.indexOf("{", at + obj.index + obj[0].length - 1);
      return open < 0 ? "" : sliceBalanced(source, open);
    }
    const ref = /^\s*([A-Za-z_$][\w$]*)/.exec(source.slice(at, at + 400))?.[1];
    if (ref && ref !== name) {
      return resolveSchemaIdentifier(file, source, ref, depth - 1);
    }
    return "";
  }
  const spec = new RegExp(
    `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`
  ).exec(source)?.[1];
  if (!spec || !spec.startsWith(".")) return "";
  const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
  if (!existsSync(target)) return "";
  return resolveSchemaIdentifier(
    target,
    stripComments(readFileSync(target, "utf8")),
    name,
    depth - 1
  );
}

/**
 * A contract region, plus the body of every schema identifier it names.
 *
 * A door's declaration and the contract it is built FROM are both part of what
 * that door accepts: `.input(CapabilityExecuteInput.extend({ verbId }))` says
 * nine keys, only two of which are written at the call site.
 */
function expandContract(file: string, source: string, region: string): string {
  let out = region;
  const seen = new Set<string>();
  for (const m of region.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\b/g)) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const body = resolveSchemaIdentifier(file, source, name);
    if (body) out += `\n${body}`;
  }
  return out;
}

/** The published `inputSchema` of the MCP tool named `toolName`, from the manifest. */
function mcpToolInputSchema(toolName: string): string {
  if (!existsSync(MCP_MANIFEST)) return "";
  const manifest = JSON.parse(readFileSync(MCP_MANIFEST, "utf8")) as {
    tools?: Array<{ name: string; inputSchema?: unknown }>;
  };
  const tool = (manifest.tools ?? []).find((t) => t.name === toolName);
  return tool?.inputSchema ? JSON.stringify(tool.inputSchema, null, 2) : "";
}

/**
 * The door's OWN declared input contract — resolved per door, per role.
 *
 * Resolved from the door's own declaration rather than from "a schema somewhere
 * in this file", for T4's reason at file granularity: `capabilities-execute.ts`
 * declares two RESPONSE schemas alongside its request schema, and both mention
 * `skillId`. A file-wide search would let a response contract vouch for a
 * request contract's omission — the same defect this pair of tripwires exists
 * to catch, wearing the fix's clothes.
 */
function declaredContract(
  role: DoorRole,
  path: string,
  source: string,
  blockOpen: number,
  label: string
): string {
  if (role === "mcp") return mcpToolInputSchema(label);
  if (role === "trpc") {
    // The nearest `.input(` ABOVE the handler block is this procedure's.
    const preamble = source.slice(0, blockOpen);
    const hits = [...preamble.matchAll(/\.\s*input\s*\(/g)];
    const last = hits[hits.length - 1];
    if (!last) return "";
    const open = source.indexOf("(", last.index! + last[0].length - 1);
    if (open < 0) return "";
    return expandContract(path, source, sliceBalanced(source, open));
  }
  // hub_rest: the schema the handler actually PARSES the body with, named by
  // the handler itself. Falls back to the route's declared `body:` schema.
  const parsed =
    /(\w+)\s*\.\s*parse\s*\(\s*await\s+c\.req\.json\(\)/.exec(source)?.[1] ??
    /body\s*:\s*(\w+Schema)/.exec(source)?.[1];
  if (!parsed) return "";
  const decl = new RegExp(
    `(?:const|let|var)\\s+${parsed}\\s*(?::[^=]*)?=\\s*`
  ).exec(source);
  const region = decl
    ? sliceToStatementEnd(source, decl.index + decl[0].length)
    : parsed;
  return expandContract(path, source, region);
}

interface Discovery {
  doors: Door[];
  /** Importers that are NOT doors — reported so the skip is never silent. */
  internal: string[];
}

function loadSources(dir: string): Array<{ file: string; source: string }> {
  return collectSources(dir).map((file) => ({
    file,
    source: readFileSync(file, "utf8"),
  }));
}

const ROUTER_SOURCES = loadSources(ROUTERS_DIR);

function discoverDoors(spec: ServiceSpec): Discovery {
  const exposers = new Set(exposingModules(spec));
  const doors: Door[] = [];
  const internal: string[] = [];

  for (const { file, source } of ROUTER_SOURCES) {
    if (!importedPaths(file, source).some((p) => exposers.has(p))) continue;
    const stripped = stripComments(source);
    const sites = [
      ...stripped.matchAll(new RegExp(`\\b${spec.fn}\\s*\\(`, "g")),
    ];
    if (sites.length === 0) continue;
    const rel = relative(API_SRC, file);
    const role = classify(file, stripped);
    if (!role) {
      internal.push(rel);
      continue;
    }
    const seen = new Set<number>();
    sites.forEach((m, n) => {
      const block = enclosingBlock(stripped, m.index!);
      if (!block || seen.has(block[0])) return;
      seen.add(block[0]);
      const label = callSiteLabel(stripped, block[0], n);
      const region = stripped.slice(block[0], block[1] + 1);
      const callArgs = callArgObject(region, spec.fn);
      doors.push({
        role,
        id: `${rel}:${label}`,
        callArgs,
        contract: declaredContract(role, file, stripped, block[0], label),
        file: stripped,
      });
    });
  }
  return { doors, internal };
}

// ── Reachability ─────────────────────────────────────────────────────────────

/**
 * (a) DECLARED — the name is a property key of the door's input contract.
 *
 * The optional quotes are load-bearing, not defensive: two of the three
 * contracts are TypeScript (`verbId:`) and the third is the published JSON
 * manifest (`"verbId":`). A pattern that only understood the bare form reported
 * every MCP parameter as unreachable — caught here by the self-guard rather
 * than shipped as six phantom gaps.
 */
function isDeclared(contract: string, param: string): boolean {
  return new RegExp(`(?:^|[^\\w$.])["']?${param}["']?\\s*:`, "m").test(
    contract
  );
}

/**
 * (b) SERVER-SUPPLIED — the door passes it at the call site from something the
 * client does not control.
 *
 * A bare `null` / `undefined` value is REJECTED. `channelId: null` reaches the
 * service and can never be anything else: it is a hardcoded absence, and
 * counting it as a forward is exactly how a parameter looks wired while being
 * permanently dead. That distinction is the whole point of the file.
 */
function isServerSupplied(callArgs: string, param: string): boolean {
  if (!callArgs) return false;
  // The value stops at a `,` OR a `}` — capturing `[^,]*` swallowed the
  // closing brace, so `{ channelId: null }` yielded " null }" and did not match
  // the null test. The self-guard below caught exactly that on the first run.
  const kv = new RegExp(`(?:^|[{,\\s])${param}\\s*:\\s*([^,}]*)`).exec(
    callArgs
  );
  if (kv) return !/^\s*(?:null|undefined)\s*$/.test(kv[1]!);
  // Shorthand `{ …, param, … }`.
  return new RegExp(`[{,]\\s*${param}\\s*[,}]`).test(callArgs);
}

function isReachable(door: Door, param: string): boolean {
  return (
    isDeclared(door.contract, param) || isServerSupplied(door.callArgs, param)
  );
}

// ── Acknowledged gaps ────────────────────────────────────────────────────────

interface Gap {
  service: string;
  param: string;
  /** Repo-relative door id, as reported in a failure. */
  door: string;
  /** WHAT is unreachable and WHY it is still unreachable. */
  reason: string;
}

/**
 * Adding a row is how you close a T5 failure without widening a door — but the
 * row must survive T4's `get_document` test: would this reason still be true if
 * nobody ever checked it again? A reason of the form "reachable elsewhere" is
 * exactly the shape that failed there; prefer "withheld, and here is the
 * structural fact that makes it so" or an honest "dropped, not yet fixed".
 *
 * Entries are self-cleaning: an entry whose parameter has since become
 * reachable FAILS ("remove it"), and an entry naming a service/param/door
 * outside the derived matrix FAILS (the code moved and it now silences
 * nothing).
 */
const ACKNOWLEDGED_GAPS: Gap[] = [
  // ── `suppressProposal`: the same reason at all three doors ────────────────
  // It is not a missing feature; it is a parameter no client may ever hold.
  {
    service: "execute-capability",
    param: "suppressProposal",
    door: "routers/capabilities.ts:execute",
    reason:
      "INTERNAL ONLY, and structurally so. `suppressProposal` turns a `propose` verdict into a plain `deny` instead of persisting a proposal row; it exists for callers with no interactive review surface (the automation executor, which would otherwise spawn a duplicate proposal every tick). A client able to set it could suppress its own governance receipt — the write would be refused, but no reviewable record of the attempt would exist. CHECKABLE: it is one of `SERVER_DERIVED_PARAMS` in `contracts/capability-execute.ts`, and the schema-freshness test fails if it ever appears in the published client contract.",
  },
  {
    service: "execute-capability",
    param: "suppressProposal",
    door: "routers/hub-protocol/rest/capabilities-execute.ts:/capabilities/execute",
    reason:
      "INTERNAL ONLY — same rule as the tRPC door, and it binds hardest here: this is the door an AGENT KEY reaches. An agent that could set `suppressProposal` would convert every governance queue-up into a silent refusal, removing the review trail that is the entire point of routing an ungranted agent write to a proposal. CHECKABLE: `SERVER_DERIVED_PARAMS` in `contracts/capability-execute.ts`.",
  },
  {
    service: "execute-capability",
    param: "suppressProposal",
    door: "routers/mcp/handlers/capability.ts:synap_run_capability",
    reason:
      "INTERNAL ONLY — same rule, and the caller here is a language model, so the field would be settable by anything that can write into the model's context. CHECKABLE: `SERVER_DERIVED_PARAMS` in `contracts/capability-execute.ts`.",
  },
  // ── Identity: derived from the transport, never from the body ─────────────
  {
    service: "execute-capability",
    param: "agentUserId",
    door: "routers/capabilities.ts:execute",
    reason:
      "NO AGENT IDENTITY EXISTS ON THIS TRANSPORT. `protectedProcedure` authenticates a HUMAN through the Kratos session and its context carries `userId` alone — `agentUserId` has ZERO occurrences in `trpc.ts`, so there is nothing server-side to forward and nothing a client could be trusted to declare. Accepting it as a body field is the impersonation door the contract's header rules out: a caller could name any agent and have the gate judge the run under that agent's grants. An agent-attributed run reaches the service through the Hub REST or MCP doors, where the identity comes off the API key. If tRPC ever gains an agent-key path, this entry becomes false and must be removed.",
  },
  // ── Instruction-provenance on MCP: absent SIGNAL, not a dropped field ─────
  {
    service: "execute-capability",
    param: "channelId",
    door: "routers/mcp/handlers/capability.ts:synap_run_capability",
    reason:
      "NO CHANNEL SIGNAL ON THIS TRANSPORT, and a model-supplied one would be worse than none. `McpToolContext` (`routers/mcp/handlers/shared.ts`) declares `userId`, `agentUserId`, `sessionId`, key/workspace fields and the two callers — no channel and no message. So the handler has nothing to forward. `channelId` feeds the rung-2.55 origin-trust classification, which is TIGHTEN-ONLY: its whole value is that an untrusted-origin turn force-proposes. A value the model itself supplies is self-attested provenance — the one party a trust signal must not be sourced from — so publishing it would let a run assert its own trustworthiness. DROPPED, NOT YET FIXED: the fix is an MCP transport header carrying the acting channel (the X-Session-Id precedent), at which point this entry becomes false.",
  },
  {
    service: "execute-capability",
    param: "sourceMessageId",
    door: "routers/mcp/handlers/capability.ts:synap_run_capability",
    reason:
      "SAME ABSENT SIGNAL as `channelId`, one hop earlier: `sourceMessageId` exists only to be resolved server-side INTO the acting channel, so it inherits that field's rule exactly. `McpToolContext` carries no triggering-message id, and a model-supplied message id would be self-attested provenance feeding the same tighten-only classifier. DROPPED, NOT YET FIXED — the same MCP transport header closes both.",
  },
];

// ── The matrix, computed once ────────────────────────────────────────────────

interface Audit {
  spec: ServiceSpec;
  params: string[];
  discovery: Discovery;
}

const AUDITS: Audit[] = SERVICES.map((spec) => ({
  spec,
  params: paramsOf(spec),
  discovery: discoverDoors(spec),
}));

function auditOf(service: string): Audit | undefined {
  return AUDITS.find((a) => a.spec.key === service);
}

// ── The tripwire ─────────────────────────────────────────────────────────────

describe("tripwire (T5): every service parameter is reachable at every door, or acknowledged", () => {
  // RULE 2 — a moved/renamed root or service file fails loudly.
  it("the routers scan root and the published MCP manifest exist", () => {
    expect(
      existsSync(ROUTERS_DIR),
      `Scan root ${ROUTERS_DIR} does not exist — it moved. Update ROUTERS_DIR; ` +
        `do NOT let this tripwire scan an empty set and report green.`
    ).toBe(true);
    expect(
      existsSync(MCP_MANIFEST),
      `${MCP_MANIFEST} does not exist — the published MCP manifest moved. ` +
        `Every MCP door would then report EVERY parameter as unreachable.`
    ).toBe(true);
  });

  it.each(SERVICES)("the $key service source exists", (spec) => {
    expect(
      existsSync(spec.file),
      `${spec.file} does not exist — the service moved. Update SERVICES.`
    ).toBe(true);
  });

  // RULE 3 — non-vacuity. A broken extractor must read RED.
  it("the routers corpus is non-trivially sized", () => {
    expect(
      ROUTER_SOURCES.length,
      `Scanned only ${ROUTER_SOURCES.length} router source(s) — the corpus ` +
        `collapsed and every result below is untrustworthy.`
    ).toBeGreaterThan(80);
  });

  it.each(AUDITS)(
    "$spec.key: the parameter set is EXTRACTED from the signature, non-empty",
    ({ spec, params }) => {
      expect(
        params.length,
        `Extracted ${params.length} parameter(s) from ${spec.fn} in ` +
          `${spec.file} (floor ${spec.paramFloor}). The signature parser broke ` +
          `or the function was renamed — every "gap" below would be a phantom.`
      ).toBeGreaterThanOrEqual(spec.paramFloor);
    }
  );

  it.each(AUDITS)(
    "$spec.key: at least two doors were DISCOVERED by import-walk",
    ({ spec, discovery }) => {
      expect(
        discovery.doors.map((d) => d.id),
        `Import discovery found ${discovery.doors.length} door(s) for ` +
          `${spec.fn}. A service reachable through one door needs no parity ` +
          `check — if that is now true, say so; if not, the import resolver ` +
          `broke (check the DYNAMIC import branch: the MCP handler uses one).`
      ).not.toHaveLength(0);
      expect(discovery.doors.length).toBeGreaterThanOrEqual(2);
    }
  );

  it("every discovered door resolved a NON-EMPTY input contract", () => {
    const empty = AUDITS.flatMap((a) => a.discovery.doors)
      .filter((d) => d.contract.trim().length === 0)
      .map((d) => `${d.role}:${d.id}`);
    expect(
      empty,
      `These doors resolved an EMPTY input contract, so every parameter would ` +
        `read as unreachable there for a reason that has nothing to do with ` +
        `the door. Fix the resolver (declaredContract), not the matrix:\n  ` +
        empty.join("\n  ")
    ).toEqual([]);
  });

  it("each role's contract resolver actually found THIS service's own contract", () => {
    // SELF-GUARD. Every door of this service takes `verbId`; if a resolver
    // silently pointed at the wrong schema (a RESPONSE schema, another
    // procedure's `.input(`, another tool's `inputSchema`) this reads red
    // instead of the matrix filling with plausible nonsense.
    for (const { discovery } of AUDITS) {
      for (const door of discovery.doors) {
        expect(
          isDeclared(door.contract, "verbId"),
          `${door.role}:${door.id} resolved a contract that does not declare ` +
            `\`verbId\` — the resolver found the WRONG declaration. Every ` +
            `verdict for this door is untrustworthy.`
        ).toBe(true);
      }
    }
  });

  it("a hardcoded `null` does NOT count as a forward", () => {
    // The distinction this whole file rests on. If it inverts, a door that
    // pins a parameter to null forever reads as wired.
    expect(isServerSupplied("{ channelId: null }", "channelId")).toBe(false);
    expect(
      isServerSupplied("{ sessionId: sessionId ?? null }", "sessionId")
    ).toBe(true);
    expect(isServerSupplied("{ userId: ctx.userId }", "userId")).toBe(true);
    expect(isServerSupplied("{ a: 1, sessionId, b: 2 }", "sessionId")).toBe(
      true
    );
  });

  it("discovered door ids are unique (a collision would hide a whole door)", () => {
    const dupes: string[] = [];
    for (const { discovery } of AUDITS) {
      const seen = new Set<string>();
      for (const d of discovery.doors) {
        if (seen.has(d.id)) dupes.push(d.id);
        seen.add(d.id);
      }
    }
    expect(
      dupes,
      `Two call sites resolved to the SAME door id — the second one's ` +
        `parameters are audited under the first's name and one ` +
        `ACKNOWLEDGED_GAPS entry would silence both:\n  ` +
        dupes.join("\n  ")
    ).toEqual([]);
  });

  // RULE 4 — SELF-GUARD on known-positive cells, so a broken engine reads red
  // rather than reporting a wall of new "gaps".
  const KNOWN_POSITIVES: Array<[string, string, string]> = [
    // DECLARED in the tRPC procedure's own `.input(`.
    ["execute-capability", "verbId", "routers/capabilities.ts:execute"],
    // DECLARED in the Hub route's parsed request schema.
    [
      "execute-capability",
      "sourceMessageId",
      "routers/hub-protocol/rest/capabilities-execute.ts:/capabilities/execute",
    ],
    // DECLARED in the MCP tool's inputSchema — which lives in a DIFFERENT FILE
    // from the handler. If cross-file resolution breaks, this reads red.
    [
      "execute-capability",
      "idempotencyKey",
      "routers/mcp/handlers/capability.ts:synap_run_capability",
    ],
    // SERVER-SUPPLIED: the acting identity is never a client field.
    ["execute-capability", "userId", "routers/capabilities.ts:execute"],
    [
      "execute-capability",
      "agentUserId",
      "routers/mcp/handlers/capability.ts:synap_run_capability",
    ],
  ];
  it.each(KNOWN_POSITIVES)(
    "SELF-GUARD: %s.%s is reachable at %s",
    (service, param, doorId) => {
      const audit = auditOf(service)!;
      const door = audit.discovery.doors.find((d) => d.id === doorId);
      expect(
        door,
        `Self-guard door ${doorId} was not DISCOVERED for ${service} — import ` +
          `resolution broke, or the door moved. Fix the resolver, not the table.`
      ).toBeTruthy();
      expect(
        audit.params,
        `Self-guard parameter "${param}" is not in the extracted set for ` +
          `${service} — the signature parser broke.`
      ).toContain(param);
      expect(
        isReachable(door!, param),
        `The engine failed to see a parameter that IS reachable ` +
          `(${service}.${param} at ${doorId}). Every gap this file reports is ` +
          `therefore untrustworthy.`
      ).toBe(true);
    }
  );

  it("every acknowledged gap carries a real reason", () => {
    const thin = ACKNOWLEDGED_GAPS.filter(
      (g) => g.reason.trim().length < 40
    ).map((g) => `${g.service}.${g.param}@${g.door}`);
    expect(
      thin,
      `An acknowledged gap without a real reason is a silenced failure:\n  ` +
        thin.join("\n  ")
    ).toEqual([]);
  });

  it("every acknowledged gap names a service/param/door that still exists", () => {
    const dead = ACKNOWLEDGED_GAPS.filter((g) => {
      const audit = auditOf(g.service);
      if (!audit) return true;
      if (!audit.params.includes(g.param)) return true;
      return !audit.discovery.doors.some((d) => d.id === g.door);
    }).map((g) => `${g.service}.${g.param}@${g.door}`);
    expect(
      dead,
      `These ACKNOWLEDGED_GAPS entries name a cell the derived matrix does not ` +
        `contain — the service, the parameter or the door was renamed/removed, ` +
        `so the entry now silences nothing and hides the rename:\n  ` +
        dead.join("\n  ")
    ).toEqual([]);
  });

  it("no acknowledged gap is STALE (the parameter is now reachable)", () => {
    const stale = ACKNOWLEDGED_GAPS.filter((g) => {
      const audit = auditOf(g.service);
      const door = audit?.discovery.doors.find((d) => d.id === g.door);
      return audit && door && isReachable(door, g.param);
    }).map((g) => `${g.service}.${g.param}@${g.door}`);
    expect(
      stale,
      `These parameters are listed as acknowledged gaps but ARE now reachable ` +
        `at that door — the gap is CLOSED. Remove the entry, or the registry ` +
        `rots into a list of things that used to be true:\n  ` +
        stale.join("\n  ")
    ).toEqual([]);
  });

  it("every service parameter is reachable at every door, or acknowledged", () => {
    const acknowledged = new Set(
      ACKNOWLEDGED_GAPS.map((g) => `${g.service}.${g.param}@${g.door}`)
    );
    const unreachable: string[] = [];

    for (const { spec, params, discovery } of AUDITS) {
      for (const door of discovery.doors) {
        for (const param of params) {
          const key = `${spec.key}.${param}@${door.id}`;
          if (acknowledged.has(key)) continue;
          if (isReachable(door, param)) continue;
          unreachable.push(key);
        }
      }
    }

    expect(
      unreachable,
      `The service ACCEPTS these parameters and the door offers NO WAY to say ` +
        `them — not in its input contract, not from server context:\n  ` +
        unreachable.join("\n  ") +
        `\nEither declare the parameter on that door, or add an ` +
        `ACKNOWLEDGED_GAPS entry saying what is unreachable and why it still ` +
        `is. "Forgotten" and "withheld on purpose" must never look the same ` +
        `from outside.`
    ).toEqual([]);
  });

  it("reports the DISCOVERED audit matrix (services x doors x params)", () => {
    for (const { spec, params, discovery } of AUDITS) {
      // eslint-disable-next-line no-console
      console.info(
        `[T5] ${spec.key}: ${params.length} param(s) [${params.join(", ")}] x ` +
          `${discovery.doors.length} door(s) ` +
          `[${discovery.doors.map((d) => `${d.role}:${d.id}`).join(", ")}]`
      );
    }
    expect(AUDITS.every((a) => a.discovery.doors.length > 0)).toBe(true);
  });

  // Reduced coverage is STATED, never silently treated as clean.
  it("reports importers that are NOT doors (internal callers, unaudited)", () => {
    for (const { spec, discovery } of AUDITS) {
      if (discovery.internal.length === 0) continue;
      // eslint-disable-next-line no-console
      console.warn(
        `[T5] ${spec.fn} is also imported by ${discovery.internal.length} ` +
          `non-door file(s) under routers/, NOT audited for input parity: ` +
          `${discovery.internal.join(", ")}.`
      );
    }
    expect(AUDITS.length).toBe(SERVICES.length);
  });
});
