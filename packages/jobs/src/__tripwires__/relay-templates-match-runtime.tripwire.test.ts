/**
 * TRIPWIRE — the relay automation TEMPLATES must be authorable against the
 * RUNTIME they will actually execute on.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A flow definition is DATA (`nodes: z.unknown()`), so an authoring↔runtime
 * mismatch is never an error — it is a SILENT NO-OP that reports
 * `status: active` / `run: completed` forever. Three instances of that one
 * defect class were found in ONE file (`relay-app/src/lib/relay-automations.ts`)
 * on 2026-09-03:
 *
 *   1. `input`/`prompt` node keys vs the executor's `inputMapping`/
 *      `promptOverride`.
 *   2. `steps["query-1"].output.count` vs a resolver that only split on "."
 *      → constant `false`, ~40 wasted runs across two flows.
 *   3. `eventPattern: "message.create.completed"` — an event the runtime never
 *      emits → 0 runs in 48 days.
 *
 * BOTH SIDES ARE DERIVED FROM SOURCE. Nothing here is hand-listed except the
 * QUARANTINE below, which is a shrinking ratchet, not a vocabulary.
 *
 * Idiom precedent: `packages/api/src/__tripwires__/
 * external-link-registers-identity-signal.test.ts` (discovers its set by
 * scanning) and `capability-drift.projection-parity.tripwire.test.ts` (parses
 * the applier's own `.set({…})` out of source).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  matchPattern,
  MESSAGE_ALIAS_EVENT_TYPES,
} from "../workers/automation-trigger-matcher.js";
import { parseContextPath } from "../workers/context-path.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** …/synap-backend/packages/jobs/src/__tripwires__ → …/synap-backend */
const BACKEND_ROOT = join(HERE, "..", "..", "..", "..");
/** The repos sit side by side under one code root. */
const RELAY_TEMPLATES = join(
  BACKEND_ROOT,
  "..",
  "relay-app",
  "src",
  "lib",
  "relay-automations.ts"
);

/**
 * Read the templates, or FAIL. Skipping on absence is the exact failure mode
 * this file exists to prevent: a tripwire that proves nothing while reporting
 * green is worse than no tripwire. If the sibling repo is not checked out, the
 * message says so instead of quietly passing.
 */
function readTemplates(): string {
  try {
    return readFileSync(RELAY_TEMPLATES, "utf8");
  } catch {
    throw new Error(
      `Cannot read the relay automation templates at ${RELAY_TEMPLATES}. ` +
        `This tripwire validates them against this package's runtime, so an ` +
        `unreadable file means it proved NOTHING — it fails rather than skips. ` +
        `Check out relay-app as a sibling of synap-backend.`
    );
  }
}

// ── The RUNTIME side, derived ─────────────────────────────────────────────
/** An `a.b` / `a.b.c` dotted event name. */
const EVENT_NAME_RE = /^[a-z][A-Za-z_]*\.[a-z_]+(\.[a-z_]+)?$/;
/** A string literal used as an event `type:` / `eventType:` — i.e. EMITTED. */
const EMITTED_PROP_RE = /\b(?:type|eventType)\s*:\s*[`"']([^`"']+)[`"']/g;
/** `emitSideEffects({ subjectType: "x", …, action: "y" … })` → `x.y.completed`. */
const EMIT_CALL_RE = /emitSideEffects\(\s*\{([\s\S]{0,400}?)\}/g;
const SUBJECT_TYPE_RE = /subjectType:\s*["'`]([a-zA-Z_]+)["'`]/;
const ACTION_RE = /\baction:\s*["'`]([a-zA-Z_]+)["'`]/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        ["node_modules", "dist", "__tests__", "__tripwires__"].includes(
          entry.name
        )
      )
        continue;
      sourceFiles(p, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Every event type the backend actually EMITS.
 *
 * Deliberately NOT the `SubjectType × EventAction × EventPhase` product: that
 * grammar is what `validateEventPattern` (the authoring door) checks, and
 * `message.create.completed` PASSES it — "message" is a real SubjectType,
 * "create" a real action. The door was never the check that could have caught
 * defect 3. Only "does anything emit it" can.
 *
 * Deliberately NOT a scan for bare event-shaped literals either: the
 * hand-maintained Admin-UI `worker-registry.ts` DECLARES
 * `outputs: ["message.create.completed"]` for three workers that emit no such
 * event, so a bare-literal corpus would have certified the very defect.
 */
function emittedEventTypes(): Set<string> {
  const types = new Set<string>(MESSAGE_ALIAS_EVENT_TYPES);
  for (const pkg of ["api", "jobs", "database"]) {
    for (const file of sourceFiles(
      join(BACKEND_ROOT, "packages", pkg, "src")
    )) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = EMITTED_PROP_RE.exec(src)))
        if (EVENT_NAME_RE.test(m[1])) types.add(m[1]);
      while ((m = EMIT_CALL_RE.exec(src))) {
        const subject = SUBJECT_TYPE_RE.exec(m[1]);
        const action = ACTION_RE.exec(m[1]);
        if (subject && action)
          types.add(`${subject[1]}.${action[1]}.completed`);
      }
    }
  }
  return types;
}

// ── The AUTHORED side, derived ────────────────────────────────────────────
function authored(re: RegExp, src: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const g = new RegExp(re.source, "g");
  while ((m = g.exec(src))) out.push(m[1]);
  return out;
}

/** The roots a `StepContext` actually has (automation-executor-types.ts). */
const CONTEXT_ROOTS = ["trigger", "steps", "automation", "loop", "item"];

/**
 * QUARANTINE — authored references that do NOT resolve, kept visible on purpose.
 *
 * This is a RATCHET, not a vocabulary: the test asserts the set is exactly what
 * is still in the templates, so removing a broken reference forces an entry out,
 * and adding a new broken one fails. `{{now()}}` / `{{now(-30d)}}` are instance
 * 4 of the same class — `resolveTemplate` has no function grammar at all, so
 * both render `""`. Fixing them means DECIDING to add a function grammar to the
 * template language, which is a design decision, not a typo fix.
 */
const UNRESOLVABLE_AUTHORED_REFS = ["now()", "now(-30d)"];

/**
 * Comments are PROSE, not authored data — the templates file documents the node
 * grammar in its own header (`steps.stepId.output.field`), and a scan that read
 * those would report defects that do not exist. Strip them once, up front.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("relay automation templates match the runtime", () => {
  const src = stripComments(readTemplates());

  it("the derived emitted-event corpus is real (never vacuously green)", () => {
    const emitted = emittedEventTypes();
    expect(emitted.size).toBeGreaterThan(50);
    // Anchors: if the scan silently stopped finding things, these go first.
    for (const anchor of [
      "entity.create.completed",
      "entity.update.completed",
      "external_message.received.completed",
      "channel_message.created.completed",
    ]) {
      expect([...emitted]).toContain(anchor);
    }
  });

  it("every authored eventPattern matches an event the runtime EMITS", () => {
    const emitted = [...emittedEventTypes()];
    const patterns = authored(/eventPattern:\s*'([^']+)'/, src);
    expect(patterns.length).toBeGreaterThan(0);
    const dead = patterns.filter(
      (pattern) => !emitted.some((type) => matchPattern(type, pattern))
    );
    expect(dead).toEqual([]);
  });

  it("every authored {{reference}} parses and is rooted in the StepContext", () => {
    const refs = [...new Set(authored(/\{\{([^{}]+)\}\}/, src))];
    expect(refs.length).toBeGreaterThan(0);
    const broken = refs.filter((ref) => {
      const segments = parseContextPath(ref);
      return !segments || !CONTEXT_ROOTS.includes(segments[0]);
    });
    // Exact equality both ways: a fixed reference must leave the quarantine.
    expect(broken.sort()).toEqual([...UNRESOLVABLE_AUTHORED_REFS].sort());
  });

  it("every `steps.<id>` reference names a node authored in the same file", () => {
    // The check that makes the DOT form of defect 2 impossible: the hyphenated
    // node id `query-1` cannot be written `steps.query-1.output` — that parses
    // and is rooted, so parse+root alone would pass it, yet it resolves the
    // segment "query" and misses forever. Node ids are read from the templates
    // themselves, so this can never drift from what the flows declare.
    const nodeIds = new Set(authored(/\bid:\s*'([^']+)'/, src));
    expect(nodeIds.size).toBeGreaterThan(0);
    const references = [
      ...authored(/\{\{([^{}]+)\}\}/, src),
      ...authored(/iteratorExpression:\s*'([^']+)'/, src),
      ...authored(/expression:\s*'([^']+)'/, src)
        .map((e) => /^(.+?)\s*(?:===|!==|==|!=|>=|<=|>|<)\s*.+$/.exec(e)?.[1])
        .filter((v): v is string => Boolean(v)),
    ];
    const unknown = [
      ...new Set(
        references
          .map((ref) => parseContextPath(ref))
          .filter(
            (segs): segs is string[] => Boolean(segs) && segs![0] === "steps"
          )
          .map((segs) => segs[1])
          .filter((id) => id === undefined || !nodeIds.has(id))
      ),
    ];
    expect(unknown).toEqual([]);
  });

  it("every authored condition/iterator path parses and is rooted too", () => {
    const paths = [
      ...authored(/iteratorExpression:\s*'([^']+)'/, src),
      // A `condition` node's expression is `left <op> right`; the left operand
      // is always a context path. `expression:` is also the CRON field and the
      // transform field, so only take the ones that look like a comparison.
      ...authored(/expression:\s*'([^']+)'/, src)
        .map((e) => /^(.+?)\s*(?:===|!==|==|!=|>=|<=|>|<)\s*.+$/.exec(e)?.[1])
        .filter((v): v is string => Boolean(v)),
    ];
    expect(paths.length).toBeGreaterThan(0);
    const broken = paths.filter((p) => {
      const segments = parseContextPath(p);
      return !segments || !CONTEXT_ROOTS.includes(segments[0]);
    });
    expect(broken).toEqual([]);
  });
});
