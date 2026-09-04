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
 * ── THREE AXES THIS AUDIT REACHES ALONG ────────────────────────────────────
 * Each was added because a field leaked past the previous shape of this file
 * and had to be found BY HAND afterwards:
 *   • DEPTH (`fieldDepth`). `AgentScorecard.counts` / `.rates` are inline
 *     anonymous objects; `partiallyApproved` / `partialApproveRate` were dropped
 *     INSIDE them on the day they were added, so every diagnose surface scored a
 *     gutted package as a full approval and a trust lane widened on it. Depth is
 *     only sound because of {@link forwardsFieldWhole}: a nested key rides along
 *     whenever the parent's VALUE is forwarded whole, and is audited only on a
 *     door that REBUILDS its parent.
 *   • COMPOSITION (`auditSubShapes`). Extraction stops at a named type
 *     reference, so `CapabilityCard.verbs: CapabilityCardVerb[]` hid a whole
 *     shape — `intent`, the vendor-independent routing axis, was computed for
 *     83/83 verbs and absent from the Hub REST response schema, so the feature
 *     reached one of its two doors. The list of sub-shapes is DERIVED by walking
 *     the type graph, not kept by hand.
 *   • REPUBLISHERS (`republisherRoots`). The diagnose roster re-projects
 *     `AgentScorecard` field by field inside a SERVICE; no router file imports
 *     the scorecard on that path, so a `routers/`-only walk was blind to it.
 *     Same defect shape as a door, one module earlier.
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
 *   5. Type extraction is WORD-BOUNDED and asserted so. A prefix match
 *      (`CapabilityCard` finding `CapabilityCardConnection`) audits the WRONG
 *      SHAPE with every non-vacuity check still green — confident nonsense,
 *      which is worse than an empty audit.
 */

// ── Audited services ─────────────────────────────────────────────────────────

const API_SRC = join(__dirname, "..");
const ROUTERS_DIR = join(API_SRC, "routers");

interface ServiceSpec {
  key: string;
  /** Absolute path to the module that EXPORTS `fn` — the import-discovery seed. */
  file: string;
  /**
   * Absolute path to the source that DECLARES `resultType`, when that is not
   * `file`. `agentScorecard` lives in `agent-scorecard.ts` but its result type
   * is declared in the sibling `types.ts`; without this the extractor finds no
   * type and the non-vacuity assertion (correctly) reds. Defaults to `file`.
   */
  typeFile?: string;
  /** Exported symbol callers import (used for passthrough + import detection). */
  fn: string;
  /** Exported result type whose fields are extracted. */
  resultType: string;
  /**
   * The result contract is a tRPC procedure's `.output(z.object({…}))` rather
   * than an exported TS type. Value is the source text the procedure's
   * declaration starts with (`get: podProcedure`); the field list is extracted
   * from the FIRST `.output(z.object({` after it.
   *
   * WHY THIS EXISTS AND WHY IT IS NOT A HAND-WRITTEN INTERFACE. `entities.get`
   * assembles its envelope inline in the router and declares its shape only as
   * a zod output schema — there is no exported result type to point `resultType`
   * at. Mirroring that schema into a TS interface here would be a SECOND,
   * independently drifting declaration of the same shape: precisely the
   * hand-maintained-projection defect this whole file exists to catch, one level
   * up. So the extractor reads the DECLARED CONTRACT ITSELF. `resultType` then
   * carries no extraction duty and is only the name failures report under.
   */
  zodOutputAfter?: string;
  /**
   * Regex SOURCE for the call expression that reaches the service, when a bare
   * `fn(` does not describe it. A tRPC procedure is reached through a caller
   * object (`entityCaller.get({…})`), so `fn` — which stays the IMPORTED symbol,
   * because that is what import-discovery seeds on — never appears as a call.
   *
   * This must be as NARROW as the contract it audits. `entities.get` returns a
   * two-field row (`entity`, `externalLinks`) unless `includeProfile` is set,
   * so a pattern matching every `.get(` would audit six fields against call
   * sites that never receive four of them and INVENT drops. Door discovery for
   * both real sites is pinned by KNOWN_POSITIVES, so a rename of the caller
   * variable fails loudly here rather than silently dropping a door.
   */
  callPattern?: string;
  /** Minimum fields a healthy extraction must find (non-vacuity). */
  fieldFloor: number;
  /**
   * How deep into the result type keys are extracted. 1 (default) audits only
   * top-level properties.
   *
   * WHY THIS IS A KNOB AND NOT A CONSTANT. Raising it is not free and not always
   * right: at depth 2 a door that forwards a parent's VALUE whole
   * (`writeReceipt: graph.writeReceipt`) still has every sub-key of that value on
   * the wire, so auditing those sub-keys by name INVENTS drops. The
   * {@link parentPassesThrough} rule below is what makes depth > 1 sound — a
   * nested key is only audited on a door that REBUILDS its parent. Depth is
   * raised where a real drop has happened inside a rebuilt sub-object
   * (`AgentScorecard.counts` / `.rates`) and left at 1 elsewhere. This is
   * COVERAGE SCOPE, not a field list: what is audited inside that scope is still
   * extracted from the type, never enumerated here.
   */
  fieldDepth?: number;
  /**
   * Extra roots walked for RE-PUBLISHERS: non-router modules that consume this
   * service's result and hand-assemble a NEW payload from it, which some door
   * then serves. Same defect shape as a door — a hand-written projection with
   * nothing forcing it to track its source — one module earlier in the chain.
   *
   * `services/diagnose/index.ts` is the live case: its `case "agent"` roster
   * re-projects `AgentScorecard` field by field, and dropped
   * `partiallyApproved`/`partialApproveRate` on the day they were added, so every
   * diagnose surface scored a gutted package as a full approval. No router file
   * imports the scorecard on that path, so a `routers/`-only walk can never see
   * it.
   *
   * This names WHERE to look, never WHAT to check: the walk inside the root is
   * recursive (RULE 1), the root must exist (RULE 2), and the field list stays
   * derived from the result type.
   */
  republisherRoots?: string[];
  /**
   * This result type COMPOSES named sub-shapes declared beside it
   * (`CapabilityCard.verbs: CapabilityCardVerb[]`). Field extraction stops at a
   * named type reference, so each sub-shape needs its own spec — and a
   * hand-kept list of which ones is the very defect this file exists to catch.
   * Setting this turns on a DERIVED completeness test: every exported type
   * reachable from this one, in the same file, that declares fields must have a
   * spec of its own. Add a sub-shape to the card and the tripwire reds until it
   * is audited.
   */
  auditSubShapes?: boolean;
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
  // The capability CATALOG is audited as TWO specs over one service because its
  // result nests a NAMED exported type: `CapabilityCard.verbs` is
  // `CapabilityCardVerb[]`, declared separately, so no depth setting on the card
  // can reach it. The verb row is where the drop that motivated this pair lived
  // — `intent` (the vendor-independent routing axis) was computed for 83/83
  // verbs and absent from the Hub REST response schema, so the whole intent
  // feature reached exactly one of its two doors.
  {
    key: "capability-catalog",
    file: join(API_SRC, "services/capabilities/capability-catalog.ts"),
    fn: "buildCapabilityCatalog",
    resultType: "CapabilityCard",
    fieldFloor: 8,
    auditSubShapes: true,
  },
  {
    key: "capability-catalog-verb",
    file: join(API_SRC, "services/capabilities/capability-catalog.ts"),
    fn: "buildCapabilityCatalog",
    resultType: "CapabilityCardVerb",
    fieldFloor: 8,
  },
  {
    key: "capability-catalog-connection",
    file: join(API_SRC, "services/capabilities/capability-catalog.ts"),
    fn: "buildCapabilityCatalog",
    resultType: "CapabilityCardConnection",
    fieldFloor: 5,
  },
  {
    key: "capability-catalog-verb-param",
    file: join(API_SRC, "services/capabilities/capability-catalog.ts"),
    fn: "buildCapabilityCatalog",
    resultType: "CapabilityCardVerbParam",
    fieldFloor: 4,
  },
  {
    key: "capability-catalog-install-param",
    file: join(API_SRC, "services/capabilities/capability-catalog.ts"),
    fn: "buildCapabilityCatalog",
    resultType: "CapabilityCardInstallParam",
    fieldFloor: 5,
  },
  {
    key: "agent-scorecard",
    file: join(API_SRC, "services/diagnose/agent-scorecard.ts"),
    typeFile: join(API_SRC, "services/diagnose/types.ts"),
    fn: "agentScorecard",
    resultType: "AgentScorecard",
    fieldFloor: 8,
    // `counts` and `rates` are INLINE anonymous objects, and the drop happened
    // inside them — a depth-1 audit sees only "counts" and cannot tell a whole
    // forward from a hand-rebuilt summary that lost two buckets.
    fieldDepth: 2,
    republisherRoots: [join(API_SRC, "services/diagnose")],
  },
  // The identity-wide ENTITY READ. Not a `services/` module — the envelope is
  // assembled inline in the `entities.get` tRPC procedure and declared only as
  // a zod output schema, which is why this spec needs `zodOutputAfter` and
  // `callPattern`. It was added after `effectivePropertiesByWorkspace` (83-93%
  // of an entity read, and the reason a `person` read truncates) was projected
  // away on the MCP door with nothing in this file able to notice: T4 audited
  // ten result types and the one an agent reads most was not among them.
  {
    key: "entity-get",
    file: join(API_SRC, "routers/entities.ts"),
    fn: "entitiesRouter",
    callPattern: "entityCaller\\.get\\(\\s*\\{[^}]*includeProfile",
    resultType: "entities.get output",
    zodOutputAfter: "get: podProcedure",
    fieldFloor: 5,
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
  // A moved root must fail through the RULE 2 existence assertions, which name
  // it — not through an ENOENT during module load, which aborts the whole file
  // and reports "no tests" rather than "scan root X moved".
  if (!existsSync(dir)) return out;
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
  // WORD-BOUNDED. `indexOf("export interface CapabilityCard")` finds
  // `CapabilityCardConnection` first and silently audits the WRONG TYPE — six
  // connection fields standing in for the eleven card fields, with every
  // non-vacuity assertion still green because a plausible-looking shape came
  // back. A prefix-matching extractor is a lie that reads like data.
  const iface = matchDecl(source, `export interface ${name}`);
  if (iface >= 0) {
    const open = source.indexOf("{", iface);
    return open < 0 ? "" : sliceBalanced(source, open);
  }
  const alias = matchDecl(source, `export type ${name}`);
  if (alias < 0) return "";
  const eq = source.indexOf("=", alias);
  if (eq < 0) return "";
  return sliceToStatementEnd(source, eq + 1);
}

/**
 * The `{ … }` of the first `.output(z.object({ … }))` declared after `anchor`.
 *
 * Whitespace-tolerant for the same reason `schemaRegions` is: Prettier breaks
 * `z\n  .object({`, and a pattern that cannot see that would return "" and turn
 * a real audit into an empty one (the non-vacuity floor catches it, loudly).
 */
function extractZodOutputBody(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  if (at < 0) return "";
  const m = /\.\s*output\s*\(\s*z\s*\.\s*object\s*\(/.exec(source.slice(at));
  if (!m) return "";
  const open = source.indexOf("{", at + m.index + m[0].length - 1);
  return open < 0 ? "" : sliceBalanced(source, open);
}

/** Index of `decl` where the character after it cannot continue an identifier. */
function matchDecl(source: string, decl: string): number {
  let from = 0;
  for (;;) {
    const at = source.indexOf(decl, from);
    if (at < 0) return -1;
    const next = source[at + decl.length];
    if (next === undefined || !/[\w$]/.test(next)) return at;
    from = at + 1;
  }
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
  fields: FieldRef[];
}

/**
 * One property of the result shape. `id` is the string a failure reports and an
 * {@link ACKNOWLEDGED_GAPS} entry is keyed on; `parent` is what makes the
 * nested-key rule below sound.
 */
interface FieldRef {
  /** Property key as written. */
  name: string;
  /** Enclosing property key, or null at the top level. */
  parent: string | null;
  /** `name`, or `parent.name` when nested. */
  id: string;
}

/**
 * Property keys declared at depth 1..`maxDepth`, string- and depth-aware, each
 * tagged with the key that encloses it.
 *
 * Depth is counted in BRACKETS of every kind, so a key inside a function-type
 * parameter list or an `Array<{…}>` element also counts as nested — which is
 * what we want: `rejectionReasons: Array<{ reason; count }>` really does declare
 * `reason`/`count` one level in.
 */
function keysUpToDepth(body: string, maxDepth: number): FieldRef[] {
  const keys: FieldRef[] = [];
  /** The key that opened each bracket level — `stack[d - 1]` is depth d's parent. */
  const stack: Array<string | null> = [];
  let depth = 0;
  let prev = "{";
  let lastKey: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (isQuote(ch)) {
      i = skipString(body, i);
      prev = '"';
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth += 1;
      stack.push(lastKey);
      lastKey = null;
      prev = ch;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      lastKey = stack.pop() ?? null;
      prev = ch;
      continue;
    }
    if (/\s/.test(ch)) continue;
    if (
      /[A-Za-z_$]/.test(ch) &&
      depth >= 1 &&
      depth <= maxDepth &&
      /[{;,]/.test(prev)
    ) {
      const m = /^[A-Za-z_$][\w$]*/.exec(body.slice(i))![0];
      const after = body.slice(i + m.length).match(/^\s*\??\s*:/);
      if (after) {
        const parent = depth > 1 ? (stack[depth - 1] ?? null) : null;
        keys.push({ name: m, parent, id: parent ? `${parent}.${m}` : m });
        lastKey = m;
      }
      i += m.length - 1;
      prev = "x";
      continue;
    }
    prev = ch;
  }
  return keys;
}

function extractMembers(
  body: string,
  isUnion: boolean,
  maxDepth: number
): ResultMember[] {
  if (!isUnion) {
    return [
      { discriminant: null, fields: uniqueRefs(keysUpToDepth(body, maxDepth)) },
    ];
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
          fields: uniqueRefs(keysUpToDepth(arm, maxDepth)),
        });
        start = -1;
      }
    }
  }
  return members;
}

function uniqueRefs(refs: FieldRef[]): FieldRef[] {
  const seen = new Map<string, FieldRef>();
  for (const r of refs) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

interface ResultShape {
  members: ResultMember[];
  /** Field IDS (`name`, or `parent.name` when nested) — what failures report. */
  fields: string[];
  refs: Map<string, FieldRef>;
  /** field id → the discriminants of the members declaring it (null = untagged). */
  owners: Map<string, Array<string | null>>;
}

function resultShapeOf(spec: ServiceSpec): ResultShape {
  const source = stripComments(
    readFileSync(spec.typeFile ?? spec.file, "utf8")
  );
  const body = spec.zodOutputAfter
    ? extractZodOutputBody(source, spec.zodOutputAfter)
    : extractTypeBody(source, spec.resultType);
  const isUnion =
    !spec.zodOutputAfter && source.includes(`export type ${spec.resultType}`);
  const members = extractMembers(body, isUnion, spec.fieldDepth ?? 1);
  const owners = new Map<string, Array<string | null>>();
  const refs = new Map<string, FieldRef>();
  for (const m of members) {
    for (const f of m.fields) {
      owners.set(f.id, [...(owners.get(f.id) ?? []), m.discriminant]);
      refs.set(f.id, f);
    }
  }
  return { members, fields: [...owners.keys()], refs, owners };
}

/** Every exported interface/type alias name declared in a source. */
function declaredTypeNames(source: string): string[] {
  return [
    ...source.matchAll(/export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/g),
  ].map((m) => m[1]!);
}

/**
 * Exported types reachable from `root` by NAME REFERENCE within one file —
 * `CapabilityCard` → `CapabilityCardVerb` → `CapabilityCardVerbParam`. Derived,
 * so a new sub-shape cannot be added without the completeness test noticing.
 */
function reachableShapes(source: string, root: string): string[] {
  const declared = new Set(declaredTypeNames(source));
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const body = extractTypeBody(source, name);
    for (const m of body.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const id = m[0];
      if (!declared.has(id) || seen.has(id)) continue;
      seen.add(id);
      queue.push(id);
    }
  }
  seen.delete(root);
  return [...seen];
}

// ── Door discovery (walk for importers — never a fixed path list) ────────────

type DoorRole = "trpc" | "hub_rest" | "mcp" | "republisher";

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

/**
 * The guard whose body IS this block, e.g. `if (input.agentId) {` →
 * `input.agentId`. Used ONLY to break a label collision, so it can never change
 * an id that was already unambiguous.
 */
function guardQualifier(src: string, blockOpen: number): string | null {
  let i = blockOpen - 1;
  while (i >= 0 && /\s/.test(src[i]!)) i -= 1;
  if (src[i] !== ")") return null;
  let depth = 0;
  for (; i >= 0; i -= 1) {
    if (src[i] === ")") depth += 1;
    else if (src[i] === "(") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (i < 0) return null;
  const cond = src.slice(i + 1, blockOpen).replace(/\)\s*$/, "");
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j]!)) j -= 1;
  if (!/\bif$/.test(src.slice(Math.max(0, j - 1), j + 1))) return null;
  return cond.replace(/\s+/g, "").slice(0, 48) || null;
}

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

function loadSources(dir: string): Array<{ file: string; source: string }> {
  return collectSources(dir).map((file) => ({
    file,
    source: readFileSync(file, "utf8"),
  }));
}

const ROUTER_SOURCES: Array<{ file: string; source: string }> =
  loadSources(ROUTERS_DIR);

/**
 * The corpus this spec is audited over: `routers/` always, plus its declared
 * REPUBLISHER roots. A file reached through a republisher root is a door by
 * construction (`forcedRole`) — `classify` would call it internal, which is
 * exactly the answer that let the diagnose roster's drop go unseen.
 */
function corpusFor(
  spec: ServiceSpec
): Array<{ file: string; source: string; forcedRole: DoorRole | null }> {
  const out = ROUTER_SOURCES.map((e) => ({
    ...e,
    forcedRole: null as DoorRole | null,
  }));
  const seen = new Set(out.map((e) => e.file));
  for (const root of spec.republisherRoots ?? []) {
    for (const e of loadSources(root)) {
      if (seen.has(e.file)) continue;
      seen.add(e.file);
      out.push({ ...e, forcedRole: "republisher" as DoorRole });
    }
  }
  return out;
}

function discoverDoors(spec: ServiceSpec): Discovery {
  const exposers = new Set(exposingModules(spec));
  const doors: Door[] = [];
  const internal: string[] = [];

  for (const { file, source, forcedRole } of corpusFor(spec)) {
    if (!importedPaths(file, source).some((p) => exposers.has(p))) continue;
    const stripped = stripComments(source);
    const role = forcedRole ?? classify(file, stripped);
    const rel = relative(API_SRC, file);
    const callRe = new RegExp(spec.callPattern ?? `\\b${spec.fn}\\s*\\(`, "g");
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
    const fileDoors: Array<{ door: Door; label: string; blockOpen: number }> =
      [];
    sites.forEach((m, n) => {
      const block = enclosingBlock(stripped, m.index!);
      if (!block || seen.has(block[0])) return;
      seen.add(block[0]);
      const label = callSiteLabel(stripped, block[0], n);
      fileDoors.push({
        label,
        blockOpen: block[0],
        door: {
          role,
          id: `${rel}:${label}`,
          region: `${stripped.slice(block[0], block[1] + 1)}\n${schemas}`,
          file: stripped,
        },
      });
    });
    // Two call sites in ONE function share its name (`diagnoseRouter` answers
    // `input.agentId` and `resolved.kind === "agent"` from separate blocks).
    // A collision means the second site is audited under the first's name and
    // one ACKNOWLEDGED entry silences both — so qualify the collided ones by
    // the guard that owns their block, which is SEMANTIC and survives a move.
    const labelCount = new Map<string, number>();
    for (const d of fileDoors)
      labelCount.set(d.label, (labelCount.get(d.label) ?? 0) + 1);
    fileDoors.forEach((d, n) => {
      if ((labelCount.get(d.label) ?? 0) > 1) {
        const q = guardQualifier(stripped, d.blockOpen) ?? `site${n}`;
        d.door.id = `${rel}:${d.label}#${q}`;
      }
      doors.push(d.door);
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

/**
 * `writeReceipt: graph.writeReceipt` / `{ …, writeReceipt, … }` — the field's
 * VALUE leaves the door whole, so everything inside it leaves too.
 *
 * This is what makes auditing nested keys sound rather than noisy. Judged by
 * NAME alone at depth 2, `/capture/structure` reads as dropping `ref`, `title`,
 * `created`, `linked`, `entityIds` and seven more — every one of which is on the
 * wire, inside the `writeReceipt` / `pendingDuplicateCandidates` values it
 * forwards verbatim. Eleven invented drops on one door is how a guard dies of
 * noise. A nested key is therefore only auditable on a door that REBUILDS its
 * parent (a zod `verbs: z.array(VerbSchema)` re-declaration, or the diagnose
 * roster flattening `counts`/`rates` into a summary row) — which is exactly
 * where a nested field CAN be forgotten.
 */
function forwardsFieldWhole(region: string, field: string): boolean {
  const f = field.replace(/\$/g, "\\$");
  return new RegExp(
    // `x: obj.x`, `x: await obj?.deep.x`
    `\\b${f}\\s*:\\s*(?:await\\s+)?[A-Za-z_$][\\w$]*(?:\\s*\\??\\.\\s*[\\w$]+)*\\s*\\??\\.\\s*${f}\\b` +
      // shorthand `{ …, x, … }` / `{ …, x }`
      `|\\{[^{}]{0,400}\\b${f}\\s*[,}]`
  ).test(region);
}

/** Whether the WHOLE service result is forwarded past this door untouched. */
function resultPassesThrough(
  door: Door,
  spec: ServiceSpec,
  shape: ResultShape,
  fieldId: string
): boolean {
  if (!forwardsWholeResult(door.region, spec.fn)) return false;
  if (doorDeclaresResponseSchema(door)) return false;
  const owners = shape.owners.get(fieldId) ?? [];
  // Covered by passthrough only if SOME owning member is not branched away.
  return owners.some((d) => d === null || !branchesOn(door.region, d));
}

function isCovered(
  door: Door,
  spec: ServiceSpec,
  shape: ResultShape,
  fieldId: string
): boolean {
  const ref = shape.refs.get(fieldId);
  const name = ref?.name ?? fieldId;
  if (isExplicit(door.region, name)) return true;
  if (ref?.parent) {
    return (
      resultPassesThrough(door, spec, shape, ref.parent) ||
      forwardsFieldWhole(door.region, ref.parent)
    );
  }
  return resultPassesThrough(door, spec, shape, fieldId);
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
  {
    service: "agent-scorecard",
    field: "mode",
    door: "services/diagnose/index.ts:diagnoseClass",
    reason:
      'STRUCTURAL — `mode` is the discriminant of a SINGLE-agent card (`mode: "agent"`), and a roster row is not one: it is an element of `detail.agents` inside a report that already carries `mode: "class", type: "agent"` two lines below in this same block. Copying the member discriminant onto each row would give one payload two conflicting modes.',
  },
  {
    service: "agent-scorecard",
    field: "sampled",
    door: "services/diagnose/index.ts:diagnoseClass",
    reason:
      "SAME VALUE, ALREADY ON THE ROW. `computeAgentScorecard` returns `sampled: total` and `counts: { total, … }` from the one local `total` — the row forwards it as `total`. Checkable in `agent-scorecard.ts` at the single return literal that builds both; if they ever diverge, that literal is the one place it can happen.",
  },
  {
    service: "agent-scorecard",
    field: "counts.approved",
    door: "services/diagnose/index.ts:diagnoseClass",
    reason:
      "RECOVERABLE EXACTLY FROM THIS ROW, no other surface involved: `approved = round(total * approveRate)`, and `total` + `approveRate` are both forwarded here. `rate(n) = Number((n/total).toFixed(4))` over the SAME denominator, and `SCORECARD_SCAN_LIMIT` bounds `total` below `10^decimals`, so the rounding resolves every integer. That bound is PINNED by the arithmetic-bound test, which reads both numbers out of `agent-scorecard.ts` — raise the scan limit past 10 000 and this entry fails instead of quietly becoming false. The row is a rate-ranked summary by design; the absolute bucket adds nothing it does not already determine.",
  },
  {
    service: "agent-scorecard",
    field: "counts.rejected",
    door: "services/diagnose/index.ts:diagnoseClass",
    reason:
      "RECOVERABLE EXACTLY FROM THIS ROW: `rejected = round(total * rejectRate)`, both forwarded here, same `rate()` denominator and the same PINNED `SCORECARD_SCAN_LIMIT < 10^decimals` bound that makes the rounding lossless (see the arithmetic-bound test). Note this is NOT true of `counts.pending` (there is no pendingRate) — which is why that one is forwarded rather than acknowledged.",
  },
  {
    service: "agent-scorecard",
    field: "counts.revised",
    door: "services/diagnose/index.ts:diagnoseClass",
    reason:
      "RECOVERABLE EXACTLY FROM THIS ROW: `revised = round(total * reviseRate)`, both forwarded here (reviseRate was added to the row in the same change that added this entry), same denominator and the same PINNED `SCORECARD_SCAN_LIMIT < 10^decimals` bound (see the arithmetic-bound test).",
  },
  // ── entity-get on `synap_detach_facet` ─────────────────────────────────────
  // These four share ONE reason, and it is a property of the CALL SITE, not of
  // any field: this block does not publish the entity read at all. It is a
  // lookup — entityId + facetSlug → facetId — feeding the governed
  // `entities.detachFacet` call below it. `classify` forces "mcp" from the file
  // path, which is right for the file and wrong for this block; rather than
  // teach the classifier to guess which blocks publish (it cannot), the four
  // are named here so a real drop on the door that DOES publish
  // (`read.ts:synap_get_entity`) still reads red.
  {
    service: "entity-get",
    field: "entity",
    door: "routers/mcp/handlers/entity.ts:synap_detach_facet",
    reason:
      "NOT A PUBLISHING DOOR — this block never emits the entity read. It calls `entityCaller.get` only to resolve entityId + facetSlug → facetId, then hands that id to the governed `entities.detachFacet` door. CHECKABLE in the block itself: every `ok(...)` inside it carries either `{ error }`, `{ error, candidates }` (facetId + workspaceId pairs), or the detachFacet outcome — no field of the entity read is on any of them.",
  },
  {
    service: "entity-get",
    field: "effectiveProperties",
    door: "routers/mcp/handlers/entity.ts:synap_detach_facet",
    reason:
      "NOT A PUBLISHING DOOR — same block, same reason as `entity` above: a facetSlug→facetId lookup, whose only emitted payloads are `{ error }` / `{ error, candidates }` / the detachFacet outcome. The property SCHEMA in particular has no bearing on detaching a role; nothing here reads it.",
  },
  {
    service: "entity-get",
    field: "effectivePropertiesByWorkspace",
    door: "routers/mcp/handlers/entity.ts:synap_detach_facet",
    reason:
      'NOT A PUBLISHING DOOR — same block, same reason. Note this is a DIFFERENT fact from the lean projection on `read.ts:synap_get_entity`, which DOES reach this field (it reads it to build `propertyOverlays`, and returns it whole on `detail: "full"`) and is therefore covered there rather than acknowledged.',
  },
  {
    service: "entity-get",
    field: "externalLinks",
    door: "routers/mcp/handlers/entity.ts:synap_detach_facet",
    reason:
      "NOT A PUBLISHING DOOR — same block, same reason as `entity` above. The lookup destructures `facets` and reads `f.profile.slug` / `f.facet.id`; import provenance is not part of resolving which facet to detach and is never emitted here.",
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

  /**
   * SELF-GUARD for type-name matching.
   *
   * `indexOf("export interface CapabilityCard")` lands on
   * `CapabilityCardConnection`, so the card spec silently audited the CONNECTION
   * shape — six fields where eleven were expected, every non-vacuity assertion
   * green because a plausible shape came back. An extractor that reads the wrong
   * type is worse than one that reads none: it produces confident nonsense.
   */
  it("type extraction is WORD-BOUNDED (a prefix must not stand in for the type)", () => {
    const src =
      "export interface Card {\n  only: string;\n}\n" +
      "export interface CardVerb {\n  a: string;\n  b: string;\n}\n";
    expect(
      keysUpToDepth(extractTypeBody(src, "Card"), 1).map((f) => f.id)
    ).toEqual(["only"]);
    expect(
      keysUpToDepth(extractTypeBody(src, "CardVerb"), 1).map((f) => f.id)
    ).toEqual(["a", "b"]);
  });

  /**
   * SELF-GUARD for the nested-key soundness rule.
   *
   * Auditing sub-keys by NAME alone invents drops wherever a door forwards the
   * PARENT's value whole — measured, that is 11 phantom gaps on
   * `/capture/structure` alone, which is enough noise to kill a guard. The
   * parent rule is what makes `fieldDepth > 1` usable, so its two shapes are
   * asserted directly.
   */
  it("a forwarded parent VALUE covers its nested keys", () => {
    expect(
      forwardsFieldWhole(
        "return { writeReceipt: graph.writeReceipt };",
        "writeReceipt"
      ),
      "an explicit whole-value forward must count"
    ).toBe(true);
    expect(
      forwardsFieldWhole(
        "return { ...rest, writeReceipt, applied };",
        "writeReceipt"
      ),
      "shorthand is the same forward"
    ).toBe(true);
    expect(
      forwardsFieldWhole("verbs: z.array(VerbSchema),", "verbs"),
      "a REBUILT parent must NOT vouch for its children — that is the only " +
        "case where a nested field can actually be forgotten"
    ).toBe(false);
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

  /**
   * DERIVED completeness for composed shapes. A spec-per-sub-shape list that
   * nobody forces to track the type is a hand-maintained projection — the exact
   * defect one level up. This walks the type graph instead.
   */
  it.each(SERVICES.filter((s) => s.auditSubShapes))(
    "$key: every named sub-shape of $resultType has a spec of its own",
    (spec) => {
      const source = stripComments(
        readFileSync(spec.typeFile ?? spec.file, "utf8")
      );
      const audited = new Set(SERVICES.map((s) => s.resultType));
      const missing = reachableShapes(source, spec.resultType).filter(
        (name) =>
          !audited.has(name) &&
          // A field-less shape (a string-union alias like
          // `CapabilityCardStatus`) has nothing for a door to drop.
          extractMembers(
            extractTypeBody(source, name),
            source.includes(`export type ${name}`),
            1
          ).some((m) => m.fields.length > 0)
      );
      expect(
        missing,
        `${spec.resultType} composes these named shapes, declared in the same ` +
          `file, and no SERVICES entry audits their fields — a door can drop ` +
          `every field of one and this tripwire stays green:\n  ` +
          missing.join("\n  ")
      ).toEqual([]);
    }
  );

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
    expect(
      existsSync(spec.typeFile ?? spec.file),
      `${spec.typeFile} does not exist — the result type moved. Update SERVICES.`
    ).toBe(true);
    for (const root of spec.republisherRoots ?? []) {
      expect(
        existsSync(root),
        `Republisher scan root ${root} does not exist — it moved. Update ` +
          `SERVICES; do NOT let this tripwire scan an empty set and pass.`
      ).toBe(true);
    }
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
    // The drop this pair was added for: `intent` is declared in the Hub REST
    // catalog's own VerbSchema. If the engine stops seeing that schema, every
    // verb field would read as "dropped" instead.
    [
      "capability-catalog-verb",
      "intent",
      "routers/hub-protocol/rest/capabilities-catalog.ts:/capabilities/catalog",
    ],
    // Passthrough on the tRPC twin (`return buildCapabilityCatalog({…})`, no
    // response schema) — the door that was never the problem.
    ["capability-catalog", "anatomy", "routers/capabilities.ts:catalog"],
    // NESTED, explicit on a REPUBLISHER: the roster row names
    // `partiallyApproved` directly. Guards both the depth-2 extraction and the
    // republisher-root discovery at once.
    [
      "agent-scorecard",
      "counts.partiallyApproved",
      "services/diagnose/index.ts:diagnoseClass",
    ],
    // NESTED, covered because the WHOLE result is forwarded (`return
    // agentScorecard({…})`). If the parent rule broke, this reads red rather
    // than every sub-key of a passthrough door reporting a phantom drop.
    [
      "agent-scorecard",
      "counts.total",
      'services/diagnose/index.ts:diagnoseRouter#resolved.kind==="agent"',
    ],
    // Both `entity-get` doors, pinned. This spec is reached through a
    // `callPattern` on a LOCAL VARIABLE name (`entityCaller.get({… includeProfile`)
    // rather than an imported symbol, so a rename of that variable would
    // otherwise drop a whole door from the matrix in silence — the documented
    // way a source-scanning tripwire dies. These two make that read RED.
    ["entity-get", "facets", "routers/mcp/handlers/read.ts:synap_get_entity"],
    [
      "entity-get",
      "facets",
      "routers/mcp/handlers/entity.ts:synap_detach_facet",
    ],
    // The lean projection's SIGNPOST source: `read.ts:synap_get_entity` reads
    // `effectivePropertiesByWorkspace` to build `propertyOverlays` and returns
    // it whole on `detail: "full"`. If this ever reads red, the lean shape has
    // stopped consulting the field it claims to signpost.
    [
      "entity-get",
      "effectivePropertiesByWorkspace",
      "routers/mcp/handlers/read.ts:synap_get_entity",
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

  /**
   * PIN for the arithmetic in the `agent-scorecard.counts.*` acknowledgements.
   *
   * Those three entries are the only ones in this file whose reason rests on a
   * NUMERIC BOUND rather than on structure: `approved`/`rejected`/`revised` are
   * dropped from the diagnose roster because each is exactly
   * `round(total × <its rate>)` from values the row DOES carry. That recovery is
   * lossless only while the rounding resolution beats one unit:
   * `rate()` keeps `toFixed(D)` digits, so the worst-case error in
   * `total × rate` is `total × 0.5 × 10^-D`, and the recovery is exact while
   * that stays below 0.5 — i.e. while `SCORECARD_SCAN_LIMIT < 10^D`.
   *
   * Today that is 500 < 10^4, with three orders of magnitude of headroom. Raise
   * the scan limit past 10 000 (or drop a decimal from `rate`) and three
   * acknowledged gaps silently stop being true — the exact "a claim nobody
   * checks" shape this file's header warns about. Both numbers are read out of
   * the service's own source, so neither can be changed without answering here.
   */
  it("the counts.* acknowledgements' arithmetic bound still holds", () => {
    const file = join(API_SRC, "services/diagnose/agent-scorecard.ts");
    const src = stripComments(readFileSync(file, "utf8"));
    const limit = /SCORECARD_SCAN_LIMIT\s*=\s*(\d+)/.exec(src);
    const digits = /\(\s*n\s*\/\s*total\s*\)\.toFixed\(\s*(\d+)\s*\)/.exec(src);
    expect(
      limit,
      `SCORECARD_SCAN_LIMIT was not found in ${file} — it was renamed or moved, ` +
        `so the bound the counts.* acknowledgements rest on is no longer being ` +
        `checked. Re-point this test; do NOT delete it.`
    ).toBeTruthy();
    expect(
      digits,
      `The \`rate()\` rounding was not found in ${file} — same problem: the ` +
        `acknowledgements claim a LOSSLESS recovery and nothing would verify it.`
    ).toBeTruthy();
    const scanLimit = Number(limit![1]);
    const decimals = Number(digits![1]);
    expect(
      scanLimit,
      `SCORECARD_SCAN_LIMIT is ${scanLimit} and rate() keeps ${decimals} ` +
        `decimals, so round(total x rate) can be off by one and ` +
        `counts.approved / counts.rejected / counts.revised are NO LONGER ` +
        `recoverable from the roster row. Either forward those three counts on ` +
        `the roster (services/diagnose/index.ts, case "agent") or rewrite their ` +
        `ACKNOWLEDGED_GAPS reasons — they are currently asserting something ` +
        `that has stopped being true.`
    ).toBeLessThan(10 ** decimals);
  });

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
