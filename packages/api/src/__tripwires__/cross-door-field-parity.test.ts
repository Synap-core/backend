import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * TRIPWIRE (T4) — cross-door FIELD parity, by ACKNOWLEDGEMENT not symmetry.
 *
 * Sibling of `cross-door-verb-parity.test.ts` (T3), one rung lower. T3 asks
 * "can this door do the verb at all". T4 asks "when it does, does the answer
 * still carry what the service computed".
 *
 * THE FAILURE THIS CATCHES: one service, three hand-assembled doors (tRPC, Hub
 * REST, MCP). Each door re-types the response by hand — the doors DOT into the
 * result rather than destructure it, MCP's `ok(data: unknown)` erases the type
 * relationship entirely, and a Hub route's `z.object` response schema is a
 * SECOND, independently drifting declaration of the same shape. A field the
 * service computes and one door forgets is INDISTINGUISHABLE, from outside,
 * from a field deliberately withheld — both read as "the agent can't see that".
 * Four such drops are live in this tree as of writing (they are the RED proof
 * for this file); each made a broken system look healthy:
 *   • `errorClass`/`providerRef` dropped by MCP `synap_run_capability` — the
 *     agent surface that most needs "reconnect this integration" cannot tell a
 *     credential expiry from a code bug.
 *   • `ackState` dropped by Hub `/capabilities/execute` — the idempotency
 *     replay signal is invisible to the IS.
 *   • `pendingDuplicateCandidates`/`writeReceipt` dropped by Hub
 *     `/capture/structure`.
 *   • `pending` absent from the Hub `/knowledge/search` response schema — the
 *     anti-amnesia block that exists precisely so agents stop re-capturing.
 *
 * A TYPE-LEVEL MECHANISM CANNOT DO THIS, and that is settled, not a matter of
 * taste: `ok(data: unknown)` (routers/mcp/handlers/shared.ts) severs every type
 * link between a service result and an emitted tool payload; Hub routes are
 * constrained to their own drifting zod schema, never to the service type; and
 * `createCaller(x as never)`-shaped casts sit directly on these paths. Source
 * scanning is the only mechanism that survives that.
 *
 * ── WHAT IS DERIVED (both properties are mandatory, both are asserted) ───────
 * 1. The FIELD LIST is EXTRACTED from the service's exported result type in
 *    source — never hand-listed. A hand-maintained field list would relocate
 *    the problem rather than solve it: it is exactly the "hand-maintained
 *    projection with nothing forcing it to track its source" defect this file
 *    exists to catch, one level up. Add a field to `AskResult` and every door
 *    owes an answer for it on the next run.
 * 2. The DOOR LIST is DISCOVERED by walking `routers/` for files that IMPORT
 *    the service (through its own module or a barrel that re-exports it) —
 *    never a fixed path list. A source-scanning tripwire with a hardcoded file
 *    list is a documented failure mode in this repo: move the code and the
 *    tripwire stays GREEN over a fresh hole. Split a handler out and the new
 *    file is audited the moment it wires up.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 * For each audited service, every field of its exported result type must either
 * be COVERED by each discovered door's projection, or carry an
 * {@link ACKNOWLEDGED_GAPS} entry naming the door, the field, and a CHECKABLE
 * reason.
 *
 * ── HOW COVERAGE IS DECIDED (three rules, each stated so it can be argued) ───
 * A field is COVERED on a door when either:
 *   (a) EXPLICIT — the field name appears in the door's source in a projection
 *       position (`field:`, `.field`, or `"field"`), comments stripped; or
 *   (b) PASSTHROUGH — the door forwards the whole service result verbatim
 *       (`return svc(...)`, `ok(result)`, `...result`, `c.json(result)`) AND
 *       neither disqualifier below applies:
 *       • the door declares its own zod RESPONSE SCHEMA on an `app.openapi`
 *         route. A declared schema IS the door's contract: a field missing from
 *         it is invisible to every generated client and every doc reader, even
 *         if the bytes happen to go out. This is what makes the Hub
 *         `/knowledge/search` `pending` drop a real drop despite the handler
 *         literally `return ask(...)`.
 *       • the door BRANCHES on the result union's discriminant (`kind === "x"`
 *         / `case "x":`) for a member that owns the field. Branching is opting
 *         out of passthrough for that member: MCP `synap_run_capability`
 *         forwards `ok(outcome)` for every kind EXCEPT `error`, which it
 *         re-projects as `{ error: outcome.message }` — dropping `errorClass`
 *         and `providerRef` while the passthrough one line below looks total.
 *
 * ── WHAT THIS CAN AND CANNOT PROVE ──────────────────────────────────────────
 * A regex match proves a field NAME APPEARS. It does NOT prove the door assigns
 * it the right value, from the right result, on the right branch, or at all —
 * `summary:` in an OpenAPI route definition and `summary:` in a response body
 * are the same eight characters. Coverage here is therefore an OVER-
 * approximation: this file under-reports (a name that appears for an unrelated
 * reason reads as covered) and by construction never invents a drop that isn't
 * one. Its guarantee is one-directional and that is the useful direction: what
 * it reports RED is a name that appears NOWHERE on that door.
 * A green T4 means "written down somewhere on that door", not "wired correctly".
 * A worked example of that limit, live in this tree: `AskResult.understanding`
 * reads as COVERED on MCP `synap_ask` because the tool's `compare` DIAGNOSTIC
 * branch returns it. The normal answer payload does not. Its siblings `intent`,
 * `primary` and `verdict` appear nowhere in that handler and so are reported —
 * the region is the handler, not the individual return statement, and a field
 * projected on any branch of it counts. Tightening that would mean modelling
 * control flow; the honest move is to state it here.
 *
 * ── ON ACKNOWLEDGEMENT ENTRIES — READ BEFORE ADDING ONE ─────────────────────
 * An entry states WHAT IS MISSING and WHY IT IS STILL MISSING. It must never
 * assert a fact this test cannot verify. This is not hypothetical: the Control
 * Plane's own drift test exempted `get_document` with the reason "COVERED —
 * get_entity returns the linked body". That was FALSE, nothing checked it, and
 * the false justification kept the tool out of the product for months — the
 * registry entry made the miss PERMANENT and self-certifying. A reason of the
 * form "covered elsewhere" is exactly the shape that failed; prefer "dropped,
 * not yet fixed, owned by X" — an honest under-convergence is tolerable, a
 * stamp asserting a convergence that never ran is a durable lie.
 *
 * Entries are self-cleaning: an entry whose field has since become covered
 * FAILS ("remove it"), and an entry naming a service/field/door outside the
 * derived matrix FAILS (the code moved and the entry now silences nothing).
 *
 * ── ANTI-STALENESS (the documented `tripwires-lose-coverage-silently` class) ─
 *   1. Scan roots are walked RECURSIVELY — never a file list.
 *   2. Required roots must EXIST — a rename fails loudly instead of scanning
 *      nothing and passing.
 *   3. Non-vacuity: the corpus, the discovered door set, and the extracted
 *      field set are each asserted non-trivial, so a broken extractor reads red
 *      rather than green-over-nothing.
 *   4. SELF-GUARD on known-positive fields per door — if the detector engine
 *      breaks, that reads red instead of as a wall of new "gaps".
 */

// ── Audited services ─────────────────────────────────────────────────────────

const API_SRC = join(__dirname, "..");
const ROUTERS_DIR = join(API_SRC, "routers");

interface ServiceSpec {
  key: string;
  /** Absolute path to the source that DECLARES the result type. */
  file: string;
  /** Exported symbol callers import (used for passthrough + import detection). */
  fn: string;
  /** Exported result type whose fields are extracted. */
  resultType: string;
  /** Minimum fields a healthy extraction must find (non-vacuity). */
  fieldFloor: number;
}

const SERVICES: ServiceSpec[] = [
  {
    key: "ask",
    file: join(API_SRC, "services/knowledge/ask.ts"),
    fn: "ask",
    resultType: "AskResult",
    fieldFloor: 8,
  },
  {
    key: "execute-capability",
    file: join(API_SRC, "services/capabilities/execute-capability.ts"),
    fn: "executeCapability",
    resultType: "ExecuteCapabilityResult",
    fieldFloor: 8,
  },
  {
    key: "submit-capture-graph",
    file: join(API_SRC, "services/capture-agent/submit-capture-graph.ts"),
    fn: "submitCaptureGraph",
    resultType: "SubmitCaptureGraphResult",
    fieldFloor: 8,
  },
  {
    key: "synthesize",
    file: join(API_SRC, "services/knowledge/synthesize.ts"),
    fn: "synthesizeAnswer",
    resultType: "SynthesisResult",
    fieldFloor: 4,
  },
];

// ── Source utilities ─────────────────────────────────────────────────────────

/**
 * Prose documents the contract; only CODE implements it. A door that merely
 * MENTIONS `writeReceipt` in a comment has not forwarded it — and several of
 * these files carry long comments naming the exact fields they drop.
 *
 * Line comments are stripped only when the `//` starts the line (after
 * whitespace), so a `"https://…"` inside a string survives intact.
 */
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
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      out.push(...collectSources(full));
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
    // Test sources quote the very patterns we detect; a fixture must never be
    // able to stand in for a real door.
    if (name.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

// ── Field extraction (derived from the service's own result type) ────────────

/**
 * The body of `export interface X { … }` or `export type X = … ;`, brace- and
 * string-aware. Returns "" when the type cannot be found, which the non-vacuity
 * assertions turn into a loud failure rather than an empty audit.
 */
function extractTypeBody(source: string, name: string): string {
  const iface = source.indexOf(`export interface ${name}`);
  if (iface >= 0) {
    const open = source.indexOf("{", iface);
    return open < 0 ? "" : sliceBalanced(source, open);
  }
  const alias = source.indexOf(`export type ${name}`);
  if (alias < 0) return "";
  const eq = source.indexOf("=", alias);
  if (eq < 0) return "";
  return sliceToStatementEnd(source, eq + 1);
}

/** From an opening `{` to its matching `}`, inclusive. */
function sliceBalanced(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]!;
    if (isQuote(ch)) {
      i = skipString(source, i);
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/** From `start` to the `;` that closes the type alias at bracket depth 0. */
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

function isQuote(ch: string): boolean {
  return ch === '"' || ch === "'" || ch === "`";
}

/** Index of the closing quote of the string starting at `i`. */
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

/**
 * One member of the result shape. A plain interface yields exactly one member
 * with no discriminant; a discriminated union yields one per `{ … }` arm, each
 * tagged with its `kind` literal so a door that branches on `kind` can be held
 * to that arm's fields specifically.
 */
interface ResultMember {
  discriminant: string | null;
  fields: string[];
}

/** Property keys declared at exactly `wantDepth`, string- and depth-aware. */
function keysAtDepth(body: string, wantDepth: number): string[] {
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
    if (/[A-Za-z_$]/.test(ch) && depth === wantDepth && /[{;,]/.test(prev)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(body.slice(i))![0];
      const after = body.slice(i + m.length).match(/^\s*\??\s*:/);
      if (after) keys.push(m);
      i += m.length - 1;
      prev = "x";
      continue;
    }
    prev = ch;
  }
  return keys;
}

function extractMembers(body: string, isUnion: boolean): ResultMember[] {
  if (!isUnion) {
    return [{ discriminant: null, fields: unique(keysAtDepth(body, 1)) }];
  }
  const members: ResultMember[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (isQuote(ch)) {
      i = skipString(body, i);
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const arm = body.slice(start, i + 1);
        const kind = /\bkind\s*:\s*["']([\w-]+)["']/.exec(arm);
        members.push({
          discriminant: kind ? kind[1]! : null,
          fields: unique(keysAtDepth(arm, 1)),
        });
        start = -1;
      }
    }
  }
  return members;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

interface ResultShape {
  members: ResultMember[];
  fields: string[];
  /** field → the discriminants of the members declaring it (null = untagged). */
  owners: Map<string, Array<string | null>>;
}

function resultShapeOf(spec: ServiceSpec): ResultShape {
  const source = stripComments(readFileSync(spec.file, "utf8"));
  const body = extractTypeBody(source, spec.resultType);
  const isUnion = source.includes(`export type ${spec.resultType}`);
  const members = extractMembers(body, isUnion);
  const owners = new Map<string, Array<string | null>>();
  for (const m of members) {
    for (const f of m.fields) {
      owners.set(f, [...(owners.get(f) ?? []), m.discriminant]);
    }
  }
  return { members, fields: [...owners.keys()], owners };
}

// ── Door discovery (walk for importers — never a fixed path list) ────────────

type DoorRole = "trpc" | "hub_rest" | "mcp";

/**
 * A door is a CALL SITE, not a file.
 *
 * File granularity is not fine enough and the miss is not hypothetical:
 * `rest/knowledge.ts` serves BOTH `/knowledge/search` (whose declared response
 * schema omits `pending`) and `/knowledge/answer` (which forwards
 * `result.pending` explicitly). Auditing the file as one unit lets the second
 * route's forward vouch for the first route's omission — the single most
 * important RED in this file would have read green.
 */
interface Door {
  role: DoorRole;
  /** Stable id: repo-relative file + the call site's own name. */
  id: string;
  /**
   * The source this door is judged on: the enclosing block of the service call,
   * plus — when the file declares response schemas — every `z.object({…})` in
   * it, because a schema-declaring door's contract IS its schema.
   */
  region: string;
  /** Whole file, comments stripped — used for whole-file properties only. */
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

/** Every module specifier a file imports, static or dynamic, resolved to .ts. */
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

/**
 * Which door a file IS, decided from its own source rather than its location:
 * anything under `routers/mcp` or `routers/hub-protocol` is that door, and a
 * tRPC door is a file that actually declares `router({`. Everything else that
 * imports the service (proposal executors, webhook ingesters, job runners) is
 * an INTERNAL caller, not a door — it is reported, never silently skipped.
 */
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
      // Pops run innermost-first, so the first block that straddles `idx` IS
      // the innermost one. Because `idx` points at the call's IDENTIFIER, the
      // argument object literal (which opens after it) can never win here —
      // the block found is the enclosing handler body.
      if (open !== undefined && open < idx && i > idx) return [open, i];
    }
  }
  return null;
}

/**
 * A human name for a call site, read off the source ABOVE its block. Route
 * `path:` is preferred for REST handlers (an anonymous `async (c) => {}` has no
 * other identity); named functions, MCP tool keys and tRPC procedure keys cover
 * the rest. The name only has to be stable and unambiguous — an ACKNOWLEDGED
 * gap is keyed on it, and the dead-entry test fails loudly if it changes.
 */
const CALL_SITE_LABEL =
  /app\.(?:post|get|put|patch|delete)\(\s*["']([^"']+)["']|path:\s*["']([^"']+)["']|function\s+(\w+)\s*\(|(\w+)\s*:\s*async|(\w+)\s*:\s*(?:protected|workspace|public|admin)Procedure|(?:const|let)\s+(\w+)\s*(?::[^=;]*)?=\s*async/g;

function callSiteLabel(
  src: string,
  blockOpen: number,
  fallback: number
): string {
  const preamble = src.slice(0, blockOpen);
  let label: string | null = null;
  // matchAll scans in position order, so the LAST match is the NEAREST
  // preceding one. The Hono mount (`app.post("/capture/structure", …)`) must
  // outrank the `registerOpenApi({ path: … })` declarations, which in
  // `rest/capture.ts` are ALL declared up top: reading only `path:` labelled
  // two different handlers with the same route and collided their ids.
  for (const m of preamble.matchAll(CALL_SITE_LABEL)) {
    label = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? label;
  }
  return label ?? `site${fallback}`;
}

/** Every `z.object({ … })` region in a file — the declared response contract. */
function schemaRegions(src: string): string {
  const out: string[] = [];
  // WHITESPACE-TOLERANT. Prettier breaks a chained builder as `z\n  .object({`,
  // and a `/z\.object\(/` pattern sees NONE of those: `capabilities-execute.ts`
  // has 0 literal `z.object(` and 4 chained ones, so its three declared
  // response schemas were entirely invisible here (`knowledge.ts` hides 5 more
  // the same way). A formatter's line break must not be able to erase a
  // declared contract from this audit.
  const re = /z\s*\.\s*object\s*\(/g;
  for (const m of src.matchAll(re)) {
    const open = src.indexOf("{", m.index! + m[0].length - 1);
    if (open >= 0) out.push(sliceBalanced(src, open));
  }
  return out.join("\n");
}

interface Discovery {
  doors: Door[];
  /** Importers that are NOT doors — reported so the skip is never silent. */
  internal: string[];
}

const ROUTER_SOURCES: Array<{ file: string; source: string }> = collectSources(
  ROUTERS_DIR
).map((file) => ({ file, source: readFileSync(file, "utf8") }));

function discoverDoors(spec: ServiceSpec): Discovery {
  const exposers = new Set(exposingModules(spec));
  const doors: Door[] = [];
  const internal: string[] = [];

  for (const { file, source } of ROUTER_SOURCES) {
    if (!importedPaths(file, source).some((p) => exposers.has(p))) continue;
    const stripped = stripComments(source);
    const role = classify(file, stripped);
    const rel = relative(API_SRC, file);
    const callRe = new RegExp(`\\b${spec.fn}\\s*\\(`, "g");
    const sites = [...stripped.matchAll(callRe)];
    if (sites.length === 0) continue;
    if (!role) {
      internal.push(rel);
      continue;
    }
    const schemas = declaresResponseSchema(stripped)
      ? schemaRegions(stripped)
      : "";
    const seen = new Set<number>();
    sites.forEach((m, n) => {
      const block = enclosingBlock(stripped, m.index!);
      if (!block || seen.has(block[0])) return;
      seen.add(block[0]);
      doors.push({
        role,
        id: `${rel}:${callSiteLabel(stripped, block[0], n)}`,
        region: `${stripped.slice(block[0], block[1] + 1)}\n${schemas}`,
        file: stripped,
      });
    });
  }
  return { doors, internal };
}

// ── Coverage ─────────────────────────────────────────────────────────────────

/** (a) EXPLICIT — the name appears in a projection position in the region. */
function isExplicit(region: string, field: string): boolean {
  const f = field.replace(/\$/g, "\\$");
  return new RegExp(
    `(?:^|[^\\w$.])${f}\\s*\\??\\s*:|\\.${f}\\b|["']${f}["']`,
    "m"
  ).test(region);
}

/** (b) PASSTHROUGH — the whole result is forwarded verbatim. */
function forwardsWholeResult(region: string, fn: string): boolean {
  if (new RegExp(`return\\s+(?:await\\s+)?${fn}\\s*\\(`).test(region))
    return true;
  const vars = [
    ...region.matchAll(
      new RegExp(
        `(?:const|let)\\s+(\\w+)\\s*=\\s*(?:await\\s+)?${fn}\\s*\\(`,
        "g"
      )
    ),
  ].map((m) => m[1]!);
  return vars.some((v) =>
    new RegExp(
      `\\.\\.\\.${v}\\b|\\bok\\(\\s*${v}\\s*\\)|return\\s+${v}\\s*;|c\\.json\\(\\s*${v}\\b`
    ).test(region)
  );
}

/**
 * Disqualifier: the door declares its own zod response schema on an OpenAPI
 * route. A declared schema IS the contract — a field missing from it is
 * invisible to every generated client and every doc reader even if the bytes
 * happen to go out, which is exactly why Hub `/knowledge/search` counts as
 * dropping `pending` despite its handler literally `return ask(…)`.
 */
function declaresResponseSchema(source: string): boolean {
  return (
    // Same whitespace tolerance as `schemaRegions` — see the note there.
    /z\s*\.\s*object\s*\(/.test(source) &&
    /\.openapi\(|registerOpenApi\(/.test(source)
  );
}

/**
 * Per-DOOR form of the disqualifier above — the one that must be used.
 *
 * The file-level test is wrong for a file that mounts several routes and only
 * declares a schema for some. `rest/capture.ts` registers OpenAPI for
 * `/capture/structure`, `/capture/execute` and `/import/*`, but mounts
 * `/capture/graph` as a bare `app.post` that ends in `return c.json(result)` —
 * a genuine passthrough. Judged at file granularity, its siblings' schemas
 * disqualified ITS passthrough and invented 8 drops, ~44% of this tripwire's
 * output. Noise is how a guard dies: people learn to ignore it and it then
 * stays green by habituation.
 *
 * That is the same "a door is a CALL SITE, not a file" correction this file
 * already applies to door LABELS — it simply had not been applied here.
 *
 * A door declares a schema when EITHER its own region does (an `.openapi(`
 * route carries the schema inline), OR the file registers OpenAPI for this
 * door's own path. The path is the tail of the door id for a Hono mount
 * (`…/capture.ts:/capture/graph`).
 */
function doorDeclaresResponseSchema(door: Door): boolean {
  if (declaresResponseSchema(door.region)) return true;
  const path = door.id.slice(door.id.lastIndexOf(":") + 1);
  // NOT path-labelled (a named handler like `handleRetrieval`, an MCP tool, a
  // tRPC procedure) ⇒ this test cannot tell WHICH route it serves, so fall
  // back to the file-level answer. That is deliberately CONSERVATIVE: it may
  // over-flag, and over-flagging is recoverable through an acknowledged gap
  // whereas under-flagging is silent. Getting this backwards silenced Hub
  // `/knowledge/search`'s real `pending` drop — its handler is
  // `handleRetrieval`, and the schema that omits `pending` is declared
  // elsewhere in the same file.
  if (!path.startsWith("/")) return declaresResponseSchema(door.file);
  // Path-labelled ⇒ definitive: does the file register OpenAPI for THIS route?
  // `registerOpenApi(app, { ... })` — the FIRST argument is the Hono app, so a
  // `registerOpenApi\(\{` pattern matches NOTHING in this codebase: this branch
  // silently returned false for EVERY path-labelled door, leaving the
  // declared-schema disqualifier inert on exactly the doors it names. An inert
  // guard is the original failure wearing the fix's clothes, so the shape of
  // the call is asserted directly below rather than trusted.
  return new RegExp(
    `registerOpenApi\\([^,)]*,\\s*\\{[\\s\\S]{0,600}?path:\\s*["']${path.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    )}["']`
  ).test(door.file);
}

/**
 * Disqualifier: the door branches on the union discriminant for this member.
 *
 * The comparison must be against a `kind` property (or a `case` label, which
 * only ever follows a `switch` on one). A bare `=== "proposed"` is NOT enough:
 * `routers/mcp/handlers/capability.ts` also holds `result.status === "proposed"`
 * for an unrelated tool, and treating that as a branch on
 * `ExecuteCapabilityResult.kind` invented two drops that are not real.
 */
function branchesOn(region: string, discriminant: string): boolean {
  return new RegExp(
    `\\bkind\\s*===\\s*["']${discriminant}["']|case\\s+["']${discriminant}["']`
  ).test(region);
}

function isCovered(
  door: Door,
  spec: ServiceSpec,
  shape: ResultShape,
  field: string
): boolean {
  if (isExplicit(door.region, field)) return true;
  if (!forwardsWholeResult(door.region, spec.fn)) return false;
  if (doorDeclaresResponseSchema(door)) return false;
  const owners = shape.owners.get(field) ?? [];
  // Covered by passthrough only if SOME owning member is not branched away.
  return owners.some((d) => d === null || !branchesOn(door.region, d));
}

// ── Acknowledged gaps ────────────────────────────────────────────────────────

interface Gap {
  service: string;
  field: string;
  /** Repo-relative door id, as reported in a failure. */
  door: string;
  /** WHAT is missing and WHY it is still missing. Never "covered elsewhere". */
  reason: string;
}

/**
 * Adding a row is how you close a T4 failure without shipping the field — but
 * the row must survive the `get_document` test: would this reason still be true
 * if nobody ever checked it again? See the header before adding one.
 */
const ACKNOWLEDGED_GAPS: Gap[] = [
  {
    service: "ask",
    field: "intent",
    door: "routers/mcp/handlers/read.ts:synap_ask",
    reason:
      "DELIBERATE — `synap_ask` is the ANSWER tier: it hands the retrieval to `synthesizeAnswer` and returns prose + sources. The SEARCH tier (glass-box routing: what the query cues suggested vs what actually answered) is not exposed over MCP at all; there is no `synap_search` tool. Withheld with the tier, not dropped from a shipped payload.",
  },
  {
    service: "ask",
    field: "primary",
    door: "routers/mcp/handlers/read.ts:synap_ask",
    reason:
      "DELIBERATE — same tier boundary. `primary` names WHICH SUBSTRATE answered; the MCP payload is prose + `sources[]`, where every source already carries its own `substrate` tag, so the substrate identity reaches the agent per-item rather than as a single header value. Checkable: `synthesizeAnswer` builds `SynthesisSource { substrate, id, title }` and `synap_ask` spreads that result.",
  },
  {
    service: "ask",
    field: "verdict",
    door: "routers/mcp/handlers/read.ts:synap_ask",
    reason:
      "DELIBERATE — same tier boundary as `intent`. The CRAG verdict rates the RETRIEVAL, and MCP callers never see the retrieval: they get the synthesized answer plus `degraded` (the retrieval-health signal that IS forwarded, since it changes what the agent should tell the user).",
  },
];

// ── The matrix, computed once ────────────────────────────────────────────────

interface Audit {
  spec: ServiceSpec;
  shape: ResultShape;
  discovery: Discovery;
}

const AUDITS: Audit[] = SERVICES.map((spec) => ({
  spec,
  shape: resultShapeOf(spec),
  discovery: discoverDoors(spec),
}));

function auditOf(service: string): Audit | undefined {
  return AUDITS.find((a) => a.spec.key === service);
}

// ── The tripwire ─────────────────────────────────────────────────────────────

describe("tripwire (T4): every service field is projected by every door, or acknowledged", () => {
  // RULE 2 — a moved/renamed root or service file fails loudly.
  /**
   * SELF-GUARD for the disqualifier's own pattern.
   *
   * `doorDeclaresResponseSchema` recognises a path-labelled route by matching
   * its `registerOpenApi(...)` call. Every Hub route passes the app FIRST
   * (`registerOpenApi(app, {`), so a pattern written as `registerOpenApi\({`
   * matched nothing and the branch returned false for every such door — the
   * disqualifier whose absence "silenced Hub /knowledge/search's real pending
   * drop" was itself switched off. Asserted on a REAL door so that a change to
   * the registration helper's signature fails here loudly instead of quietly
   * disarming the rule.
   */
  /**
   * SELF-GUARD for the schema-region pattern.
   *
   * `capabilities-execute.ts` declares three response schemas and contains
   * ZERO literal `z.object(` — Prettier formats every one as `z\n  .object({`.
   * A `/z\.object\(/` pattern therefore saw no schema in that file at all, so
   * both `declaresResponseSchema` and `schemaRegions` reported it as declaring
   * nothing. A formatter's line break must never be able to erase a declared
   * contract from this audit; `knowledge.ts` hides five more the same way.
   */
  it("schema regions survive a chained `z\\n.object({` formatting", () => {
    const chained =
      'const S = z\n  .object({ reviewUrl: z.string() })\n  .openapi("S");';
    expect(
      declaresResponseSchema(chained),
      "a chained builder must still count as declaring a response schema"
    ).toBe(true);
    expect(
      schemaRegions(chained),
      "the chained schema's fields must be extractable, or every field in it " +
        "silently reads as undeclared"
    ).toMatch(/reviewUrl/);
  });

  it("the declared-schema disqualifier actually fires on a path-labelled Hub door", () => {
    const door = AUDITS.flatMap((a) => a.discovery.doors).find((d) =>
      d.id.endsWith("rest/capabilities-execute.ts:/capabilities/execute")
    );
    expect(
      door,
      "the /capabilities/execute door was not discovered"
    ).toBeTruthy();
    expect(
      doorDeclaresResponseSchema(door!),
      "this route DOES declare 200/202 response schemas, so the disqualifier " +
        "must see them. Returning false here silently converts rule (b) into " +
        "an unconditional pass for every path-labelled door."
    ).toBe(true);
  });

  it("the routers scan root exists", () => {
    expect(
      existsSync(ROUTERS_DIR),
      `Scan root ${ROUTERS_DIR} does not exist — it moved. Update ROUTERS_DIR; ` +
        `do NOT let this tripwire scan an empty set and report green.`
    ).toBe(true);
  });

  it.each(SERVICES)("the $key service source exists", (spec) => {
    expect(
      existsSync(spec.file),
      `${spec.file} does not exist — the service moved. Update SERVICES.`
    ).toBe(true);
  });

  // RULE 3 — non-vacuity, three ways. A broken extractor must read RED.
  it("the routers corpus is non-trivially sized", () => {
    expect(
      ROUTER_SOURCES.length,
      `Scanned only ${ROUTER_SOURCES.length} router source(s) — the corpus ` +
        `collapsed (check SKIP_DIRS / the .ts filter) and every result below ` +
        `is untrustworthy.`
    ).toBeGreaterThan(80);
  });

  it.each(AUDITS)(
    "$spec.key: the field set is EXTRACTED from its result type, non-empty",
    ({ spec, shape }) => {
      expect(
        shape.fields.length,
        `Extracted ${shape.fields.length} field(s) from ${spec.resultType} in ` +
          `${spec.file} (floor ${spec.fieldFloor}). The parser broke or the ` +
          `type was renamed — every "gap" below would be a phantom.`
      ).toBeGreaterThanOrEqual(spec.fieldFloor);
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
          `broke and this audit is vacuous.`
      ).not.toHaveLength(0);
      expect(discovery.doors.length).toBeGreaterThanOrEqual(2);
    }
  );

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
      `Two call sites resolved to the SAME door id — the second one's fields ` +
        `are audited under the first's name and an ACKNOWLEDGED_GAPS entry ` +
        `would silence both. Teach callSiteLabel to tell them apart:\n  ` +
        dupes.join("\n  ")
    ).toEqual([]);
  });

  // RULE 4 — SELF-GUARD. Known-positive fields per door: if the detector
  // engine, the comment stripper or the passthrough rule breaks, THIS reads
  // red instead of every field silently reporting "dropped".
  const KNOWN_POSITIVES: Array<[string, string, string]> = [
    // Explicitly projected, by name, in the door body.
    [
      "execute-capability",
      "providerRef",
      "routers/hub-protocol/rest/capabilities-execute.ts:/capabilities/execute",
    ],
    [
      "execute-capability",
      "correlationId",
      "routers/hub-protocol/rest/capabilities-execute.ts:/capabilities/execute",
    ],
    ["ask", "pending", "routers/mcp/handlers/read.ts:synap_ask"],
    ["ask", "degraded", "routers/mcp/handlers/read.ts:synap_ask"],
    // Covered by PASSTHROUGH (`return ask({...})`, no response schema).
    ["ask", "answers", "routers/knowledge.ts:search"],
    // Covered by PASSTHROUGH on a non-branched union member (`ok(outcome)`).
    [
      "execute-capability",
      "ackState",
      "routers/mcp/handlers/capability.ts:synap_run_capability",
    ],
  ];
  it.each(KNOWN_POSITIVES)(
    "SELF-GUARD: %s.%s is detected as covered on %s",
    (service, field, doorId) => {
      const audit = auditOf(service)!;
      const door = audit.discovery.doors.find((d) => d.id === doorId);
      expect(
        door,
        `Self-guard door ${doorId} was not DISCOVERED for ${service} — import ` +
          `resolution broke, or the door moved. Fix the resolver, not the table.`
      ).toBeTruthy();
      expect(
        audit.shape.fields,
        `Self-guard field "${field}" is not in the extracted field set for ` +
          `${service} — the type parser broke.`
      ).toContain(field);
      expect(
        isCovered(door!, audit.spec, audit.shape, field),
        `The engine failed to see a field that IS projected (${service}.${field} ` +
          `on ${doorId}). Every gap this file reports is therefore untrustworthy.`
      ).toBe(true);
    }
  );

  it("every acknowledged gap carries a real reason", () => {
    const thin = ACKNOWLEDGED_GAPS.filter(
      (g) => g.reason.trim().length < 40
    ).map((g) => `${g.service}.${g.field}@${g.door}`);
    expect(
      thin,
      `An acknowledged gap without a real reason is a silenced failure:\n  ` +
        thin.join("\n  ")
    ).toEqual([]);
  });

  it("every acknowledged gap names a service/field/door that still exists", () => {
    const dead = ACKNOWLEDGED_GAPS.filter((g) => {
      const audit = auditOf(g.service);
      if (!audit) return true;
      if (!audit.shape.fields.includes(g.field)) return true;
      return !audit.discovery.doors.some((d) => d.id === g.door);
    }).map((g) => `${g.service}.${g.field}@${g.door}`);
    expect(
      dead,
      `These ACKNOWLEDGED_GAPS entries name a cell the derived matrix does not ` +
        `contain — the service, the field or the door was renamed/removed, so ` +
        `the entry now silences nothing and hides the rename:\n  ` +
        dead.join("\n  ")
    ).toEqual([]);
  });

  it("no acknowledged gap is STALE (the field is now projected)", () => {
    const stale = ACKNOWLEDGED_GAPS.filter((g) => {
      const audit = auditOf(g.service);
      const door = audit?.discovery.doors.find((d) => d.id === g.door);
      return audit && door && isCovered(door, audit.spec, audit.shape, g.field);
    }).map((g) => `${g.service}.${g.field}@${g.door}`);
    expect(
      stale,
      `These fields are listed as acknowledged gaps but ARE now projected on ` +
        `that door — the gap is CLOSED. Remove the entry, or the registry rots ` +
        `into a list of things that used to be true:\n  ${stale.join("\n  ")}`
    ).toEqual([]);
  });

  it("every service field is projected by every door, or acknowledged", () => {
    const acknowledged = new Set(
      ACKNOWLEDGED_GAPS.map((g) => `${g.service}.${g.field}@${g.door}`)
    );
    const dropped: string[] = [];

    for (const { spec, shape, discovery } of AUDITS) {
      for (const door of discovery.doors) {
        for (const field of shape.fields) {
          const key = `${spec.key}.${field}@${door.id}`;
          if (acknowledged.has(key)) continue;
          if (isCovered(door, spec, shape, field)) continue;
          dropped.push(key);
        }
      }
    }

    expect(
      dropped,
      `These fields are computed by the service but appear NOWHERE in the ` +
        `door's projection:\n  ${dropped.join("\n  ")}\n` +
        `Either forward the field on that door, or add an ACKNOWLEDGED_GAPS ` +
        `entry saying what is missing and why it is still missing. "Forgotten" ` +
        `and "withheld on purpose" must never look the same from outside.`
    ).toEqual([]);
  });

  it("reports the DISCOVERED audit matrix (services x doors x fields)", () => {
    for (const { spec, shape, discovery } of AUDITS) {
      // eslint-disable-next-line no-console
      console.info(
        `[T4] ${spec.key}: ${shape.fields.length} field(s) ` +
          `[${shape.fields.join(", ")}] x ${discovery.doors.length} door(s) ` +
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
        `[T4] ${spec.fn} is also imported by ${discovery.internal.length} ` +
          `non-door file(s) under routers/, NOT audited for field parity: ` +
          `${discovery.internal.join(", ")}. These are proposal executors / ` +
          `webhook ingesters / job runners — they consume the result, they do ` +
          `not publish it to a client.`
      );
    }
    expect(AUDITS.length).toBe(SERVICES.length);
  });
});
