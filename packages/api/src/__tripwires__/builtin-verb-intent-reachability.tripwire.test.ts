/**
 * TRIPWIRE — every callable verb an agent could reach is ROUTABLE by intent.
 *
 * ── THE HOLE THIS GUARDS ────────────────────────────────────────────────────
 * The guards that already exist on this axis are all CONVERGENCE guards: they
 * prove `provides` matches what was derived, and that the catalog matches the
 * definition. Every one of them answers "do the two sides AGREE?", which two
 * mirrored implementations of the same wrong rule satisfy perfectly. None of
 * them asked the question that actually mattered:
 *
 *     Can an agent that asks `intent: "send_message"` REACH `messaging.send`?
 *
 * That was a live, verified production hole. `list_capabilities({intent})` on a
 * real pod returned ONLY `gmail_send` — the Synap Core builtin `messaging.send`,
 * always installed, was ABSENT. The cause was not a bug in any of those
 * converging halves: it was missing DATA. `SYNAP_CORE_DEFINITION` declares
 * `tools: []`, so there is no tool catalog for the routing axis to be derived
 * from, and migration 0292's backfill — which derives from that catalog — could
 * not reach the row either. Every consistency check passed, happily, over a
 * completely unreachable verb.
 *
 * ── WHY THIS IS A REACHABILITY CLAIM AND NOT A SHAPE CLAIM ──────────────────
 * A shape guard says "the `intent` field exists" or "the value parses". Both
 * were already true of an unreachable verb, which is exactly why they missed it.
 * This guard instead asks the router ITSELF, and asserts the value ARRIVES:
 *
 *   1. It parses each definition skill's declared `intent` with
 *      `resolveVerbIntent` — the REAL single writer's own validation function,
 *      imported, not reimplemented. A value the router would reject fails here.
 *   2. It then pushes the row through `foldVerbsByIntent` — the REAL reverse
 *      index the discovery door reads — and asserts the skill's OWN verb id
 *      comes back OUT under the intent it declared. The value must SURVIVE the
 *      round trip through the machinery that does the routing; declaring a field
 *      is not reaching the index.
 *   3. A callable verb with NO declared intent is not silently allowed to be
 *      invisible: it must appear in `INTENTIONALLY_UNROUTABLE` with a written
 *      reason, and the set of names is asserted EXACTLY (both directions), so
 *      adding a routable verb is what breaks the build, not removing an entry.
 *
 * ── WHY SOURCE, NOT IMPORT (and how that is not a vacuity hole) ─────────────
 * Importing `ensure-synap-core.ts` pulls `@synap/database` and the whole router
 * graph into the test process. The scanned definition is therefore read from its
 * AST, EXACTLY as `synap-core-risky-verbs-reenter-a-governed-door.test.ts`
 * already does for the same file. To stop the parser being a vacuity hole, it
 * REFUSES anything it cannot read exactly (a spread, a computed key, a
 * non-literal name or intent) rather than skipping it — an unreadable element
 * is a FAILURE. Every scan carries a non-vacuity floor, and the hunt is
 * positive-controlled against a literal sample.
 *
 * The CP's shipped capability templates are the OTHER producer of builtin-
 * reachable skills, and they are a separate repository. They are covered by
 * `synap-control-plane-api/src/seeds/capability-template-intent-coverage.test.ts`
 * against the same closed vocabulary. This file asserts the pod-side half and
 * the seam between them; see "WHAT IT DOES NOT COVER".
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { resolveVerbIntent } from "../services/capabilities/create-from-definition.js";
import { foldVerbsByIntent } from "../services/capabilities/capability-intent-index.js";
import { isAbstractVerb } from "@synap/database/schema";
import type { RegistryCapability } from "../services/capabilities/capability-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPABILITIES_DIR = resolve(HERE, "../services/capabilities");
const CORE_DEF_FILE = resolve(CAPABILITIES_DIR, "ensure-synap-core.ts");

// ── THE VOCABULARY THE ROUTER ACTUALLY SERVES ────────────────────────────────
// `resolveVerbIntent` accepts a value when it is in the TS seed union
// (`isAbstractVerb`) OR in the `capability_intents` table, which the applier
// reads and passes as `known`. `publish_post` is a 0284 ROW, deliberately not
// a seed-union member — so a guard that models the vocabulary as the union
// alone rejects a perfectly valid annotation.
//
// These are DERIVED from the migration SQL that populates the table, not
// hand-listed: a hand list here would be a second mirror to fall behind, and
// the point of the exercise is to have exactly one. Only the
// `INSERT INTO "capability_intents"` VALUES list is scanned — matching a whole
// migration would pick up the CHECK constraint's `IN ('read','write','act')`
// and invent three phantom intents.
// HERE = packages/api/src/__tripwires__ → ../../ = packages/ → database/migrations
const MIGRATIONS_DIR = resolve(HERE, "../../../database/migrations");

function deriveSeededIntents(): Set<string> {
  const dir = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const slugs = new Set<string>();
  let sawTable = false;
  for (const file of dir) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const at = sql.indexOf('INSERT INTO "capability_intents"');
    if (at === -1) continue;
    sawTable = true;
    const insert = sql.slice(at);
    for (const m of insert.matchAll(
      /\(\s*'([a-z][a-z0-9_]*)'\s*,\s*'(?:read|write|act)'\s*,/g
    )) {
      slugs.add(m[1]);
    }
  }
  // The anchor must have been found — a renamed table would otherwise yield an
  // empty set, and an empty set compared against a full vocabulary passes for
  // the wrong reason.
  if (!sawTable) {
    throw new Error(
      'TRIPWIRE CANNOT RUN: no migration inserts into "capability_intents" — ' +
        "the vocabulary would silently be EMPTY and every check below vacuous."
    );
  }
  return slugs;
}

const SEEDED_INTENTS = deriveSeededIntents();

/**
 * The set the applier hands `resolveVerbIntent` as `known`, PLUS the seed union
 * it also accepts. Membership mirrors the router's own `isAbstractVerb(raw) ||
 * known?.has(raw)` test exactly.
 */
function routerKnows(value: string): boolean {
  return isAbstractVerb(value) || SEEDED_INTENTS.has(value);
}

/**
 * Call the real writer with the argument shape the real applier uses: the
 * `known` set is only supplied when a declared value is outside the seed
 * (`knownIntentSetFor` returns undefined otherwise), and passing it either way
 * is behaviourally identical because `isAbstractVerb` is checked first.
 */
function resolveAsApplierWould(skill: ScannedSkill): string | undefined {
  return (
    resolveVerbIntent(
      { name: skill.name, kind: "builtin", intent: skill.intent } as never,
      SEEDED_INTENTS
    ) ?? undefined
  );
}

// ---------------------------------------------------------------------------
// AST helpers — lifted in spirit from the sibling tripwire that already parses
// this exact file, so there is ONE idiom for reading a definition off disk.
// Every reader THROWS on a shape it cannot see exactly. A reader that returned
// null here would silently shrink the scanned set, which is the exact failure
// mode every non-vacuity assertion below exists to catch.
// ---------------------------------------------------------------------------

function parse(file: string): ts.SourceFile {
  if (!existsSync(file)) {
    throw new Error(`TRIPWIRE CANNOT RUN: source file not found: ${file}`);
  }
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );
}

function findVarInitializer(
  sf: ts.SourceFile,
  name: string
): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Strip `x satisfies T` / `x as T` / `(x)` wrappers. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    else if (ts.isParenthesizedExpression(e)) e = e.expression;
    else return e;
  }
}

function objectLiteralOf(
  expr: ts.Expression
): ts.ObjectLiteralExpression | null {
  const e = unwrap(expr);
  if (ts.isObjectLiteralExpression(e)) return e;
  if (ts.isCallExpression(e) && e.arguments.length === 1) {
    const a = unwrap(e.arguments[0] as ts.Expression);
    if (ts.isObjectLiteralExpression(a)) return a;
  }
  return null;
}

function propertyNameOf(p: ts.ObjectLiteralElementLike): string | null {
  const n = p.name;
  if (!n) return null;
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isStringLiteral(n)) return n.text;
  return null; // computed / numeric → refused by callers
}

/** Read a string-literal property, or `undefined` when the key is absent. */
function stringPropOf(
  obj: ts.ObjectLiteralExpression,
  key: string
): string | undefined {
  const prop = obj.properties.find((p) => propertyNameOf(p) === key);
  if (!prop) return undefined;
  if (!ts.isPropertyAssignment(prop)) {
    throw new Error(
      `property "${key}" is not a plain property assignment — the scan ` +
        `cannot read it exactly; widen this parser rather than guessing.`
    );
  }
  const init = unwrap(prop.initializer);
  if (ts.isStringLiteral(init)) return init.text;
  // A non-literal (a variable, a template expression) must NOT be read as
  // "absent": that would turn a present-but-computed intent into a silent skip.
  throw new Error(
    `property "${key}" is not a string literal — the scan cannot read it ` +
      `exactly; widen this parser rather than letting it disappear.`
  );
}

// ---------------------------------------------------------------------------
// 1. DERIVE the scanned set from the definition on disk
// ---------------------------------------------------------------------------

interface ScannedSkill {
  name: string;
  kind: string;
  /** The literal as written, or undefined when the key is absent. */
  intent: string | undefined;
}

function readCoreSkills(): ScannedSkill[] {
  const sf = parse(CORE_DEF_FILE);
  const def = findVarInitializer(sf, "SYNAP_CORE_DEFINITION");
  if (!def) throw new Error("SYNAP_CORE_DEFINITION not found in source");
  const obj = objectLiteralOf(def);
  if (!obj) throw new Error("SYNAP_CORE_DEFINITION is not an object literal");
  const skillsProp = obj.properties.find((p) => propertyNameOf(p) === "skills");
  if (!skillsProp || !ts.isPropertyAssignment(skillsProp)) {
    throw new Error("SYNAP_CORE_DEFINITION.skills not found");
  }
  const arr = unwrap(skillsProp.initializer);
  if (!ts.isArrayLiteralExpression(arr)) {
    throw new Error("SYNAP_CORE_DEFINITION.skills is not an array literal");
  }
  return arr.elements.map((el, i) => {
    const e = unwrap(el as ts.Expression);
    if (!ts.isObjectLiteralExpression(e)) {
      throw new Error(
        `skills[${i}] is not an object literal (spread/computed?) — the scan ` +
          `cannot see it; widen this parser rather than letting it disappear.`
      );
    }
    const name = stringPropOf(e, "name");
    if (name === undefined) {
      throw new Error(
        `skills[${i}] has no literal "name" — cannot identify it`
      );
    }
    return {
      name,
      kind: stringPropOf(e, "kind") ?? "builtin",
      intent: stringPropOf(e, "intent"),
    };
  });
}

const ALL = readCoreSkills();
/**
 * A teaching skill is PROSE an agent loads, not a verb it can route to. It is
 * excluded from the reachability requirement for the same reason
 * `resolveVerbIntent` is never consulted for it: there is nothing to dispatch.
 */
const CALLABLE = ALL.filter((s) => s.kind !== "instruction");

// ---------------------------------------------------------------------------
// 2. THE PINNED EXEMPTIONS — a decision, not an oversight
// ---------------------------------------------------------------------------

/**
 * Callable verbs that deliberately declare NO intent, each with the reason no
 * value in the closed vocabulary describes what it does.
 *
 * The unifying reason is that these verbs are POD-INTERNAL: they read or mutate
 * Synap's own graph, config and sessions and never reach the outside world.
 * Every value in the vocabulary (`ABSTRACT_VERBS` + `publish_post`) describes
 * either acquiring information from an external corpus, acting outward on a
 * provider, bridging external data into the pod, or standing up a connection —
 * and none of them is "administer this pod". Forcing a fit would send an agent
 * to a verb that does something else entirely, which is strictly worse than
 * being unroutable, because a wrong intent is a CONFIDENT wrong answer.
 *
 * This is asserted in BOTH directions below: a new callable verb without an
 * intent fails here, and deleting an entry from this table without adding the
 * intent also fails here. Neither direction can drift silently.
 */
const INTENTIONALLY_UNROUTABLE: Record<string, string> = {
  // ── channel plumbing: the internal machinery UNDER send_message ─────────
  "channel.create":
    "Creates a durable conversation container, not a time-bound calendar commitment. schedule_event would send a 'book a meeting' agent to a chat room.",
  "channel.resolve":
    "Reads a local binding between a context object and its channel. No external record is fetched, so neither fetch_record nor list_records describes it.",
  "channel.ensure":
    "Find-or-create of a local thread binding — internal plumbing that exists so messaging.send has a channel. Enriching entities is not what it does.",
  "channel.bind":
    "Sets a local association and explicitly never posts. It is not a send, and it does not acquire anything.",
  "feed.read":
    "Reads messages already stored in the pod. Enumerating a kind's records would misdescribe a channel's history.",
  // ── graph + facet bookkeeping: pod-internal structure ──────────────────
  "graph.relations": "Reads relation edges already in the pod graph.",
  "graph.link":
    "Links two pod-internal entities. Nothing external is involved.",
  "entity_facet.list": "Reads an entity's local role-facets.",
  "entity_facet.attach":
    "Attaches a role hat to an entity. enrich_entity means adding FACTS, not roles.",
  "entity_facet.update":
    "Updates a role-facet's status. Same reasoning as attach.",
  "entity_facet.detach": "Removes a role-facet. Same reasoning as attach.",
  "entity.delete":
    "A pod-internal removal. The vocabulary has no member for deletion, and mapping it to entity.update (enrich_entity) would describe a materially different act.",
  // ── documents: local reads and local edits ─────────────────────────────
  "document.read": "Reads a document already in the pod.",
  "document.update":
    "Edits a document already in the pod. capture_into_pod means bringing one IN, which this does not do.",
  "document.freeze_charts":
    "Rewrites chart embeds into snapshots in a local string. Read-only, pod-local, no artifact produced for a consumer.",
  "document.stamp_diagnostics":
    "Writes an advisory diagnostics stamp onto a pod-local document.",
  // ── configuration revision: the pod administering itself ───────────────
  "playbook.update": "Revises a playbook definition stored in the pod.",
  "playbook.archive": "Retires a playbook stored in the pod.",
  "automation.update": "Revises an automation's stored definition.",
  "automation.activate":
    "Switches a pod-local automation on and computes its next run time.",
  "automation.pause": "Switches a pod-local automation off.",
  "view.update": "Revises a view's stored definition.",
  "cell.update": "Patches a cell instance's stored config.",
  "skill.update_rule": "Revises a standing rule stored in the pod.",
  "profile.propose_retire":
    "Proposes retiring a kind or role. Pod schema administration.",
  "property_def.propose_retire":
    "Proposes retiring a property definition. Pod schema administration.",
  // ── marketplace authoring: creates a DRAFT, installs nothing ───────────
  "market.scaffold":
    "Authors a new marketplace package as a local draft document. It installs nothing and connects nothing, so connect_account would be a false claim.",
  // ── connection PROBING: repair is a human act, not a connect ──────────
  "connector.health_check":
    "Probes an EXISTING connection and nudges a human to repair it. connect_account establishes a NEW authorization; this verb never does.",
  // ── governance calibration: pod-internal, no external world ───────────
  "governance.recommend_tighten":
    "Scans rejected proposals in the pod and files an internal calibration proposal.",
  "governance.recommend_raise_ceiling":
    "Scans agent write volume in the pod and files an internal ceiling proposal.",
  "governance.recommend_raise_proposal_cap":
    "Scans pending-proposal counts in the pod and files an internal cap proposal.",
  "governance.recommend_tighten_posture":
    "Scans rejected proposals by channel in the pod and files an internal posture proposal.",
  "automation.recommend_health":
    "Scans automations that have never produced a run row and files an advisory proposal.",
};

// ---------------------------------------------------------------------------
// 3. THE ROUTER ITSELF — imported, never reimplemented
// ---------------------------------------------------------------------------

/**
 * A synthetic registry row shaped exactly like the one
 * `buildVerbStates` produces for a skill, carrying the value the COLUMN would
 * hold. The `intent` on it is the router's own output from `resolveVerbIntent`,
 * so this cannot drift from what the writer would actually persist.
 */
function registryRowFor(
  skill: ScannedSkill,
  resolvedIntent: string | undefined
): RegistryCapability {
  return {
    id: "synap-core",
    name: "Synap Core",
    verbs: [
      {
        id: skill.name,
        label: skill.name,
        kind: "action",
        effectiveExecMode: "auto",
        backingSkillExecutable: true,
        ...(resolvedIntent ? { intent: resolvedIntent } : {}),
      },
    ],
  } as unknown as RegistryCapability;
}

describe("Synap Core builtins — intent REACHABILITY (not just presence)", () => {
  // ── non-vacuity ──────────────────────────────────────────────────────────
  it("POSITIVE CONTROL: the scan really read the definition, and can still see an intent literal", () => {
    // If the directory moved, the parser stopped matching, or the walk began
    // skipping elements, every assertion below would pass on a tiny or empty
    // set. Pin a floor, and prove the hunt can still SEE the value it looks for.
    expect(ALL.length).toBeGreaterThan(40);
    expect(CALLABLE.length).toBeGreaterThan(40);
    expect(ALL.length).toBe(CALLABLE.length); // Synap Core declares no prose skills

    // The literal sample: the scan must be able to read a real declared intent
    // out of the source, not merely confirm the key is absent everywhere.
    const annotated = ALL.filter((s) => s.intent !== undefined);
    expect(annotated.length).toBeGreaterThan(0);
    expect(ALL.map((s) => s.intent).filter(Boolean)).toContain("send_message");
    // And it must be able to tell annotated from unannotated at all.
    expect(ALL.some((s) => s.intent === undefined)).toBe(true);
  });

  it("POSITIVE CONTROL: the router round trip can actually return a match", () => {
    // Proves the machinery below is not vacuous: a row that DOES declare an
    // intent must come back out of `foldVerbsByIntent` under that intent. If
    // this ever returns [], every later "it reached the index" assertion is
    // meaningless, because the index is simply not serving.
    const index = foldVerbsByIntent([
      registryRowFor(
        { name: "probe.verb", kind: "builtin", intent: "send_message" },
        "send_message"
      ),
    ]);
    const hits = index.get("send_message") ?? [];
    expect(hits.map((h) => h.verbId)).toEqual(["probe.verb"]);
  });

  it("POSITIVE CONTROL: the derived vocabulary is real, and covers a ROW slug the seed union does not", () => {
    // The migration scan is the one hand-off that could silently yield an empty
    // or seed-only set. `publish_post` is the discriminating member: it is a
    // 0284 ROW and deliberately NOT in the TS seed union, so if the scan only
    // ever found the union, `routerKnows("publish_post")` would be false and
    // every membership assertion below would be quietly testing the wrong set.
    expect(SEEDED_INTENTS.size).toBeGreaterThan(10);
    expect(routerKnows("send_message")).toBe(true); // seed union member
    expect(SEEDED_INTENTS.has("publish_post")).toBe(true); // 0284 row
    expect(isAbstractVerb("publish_post")).toBe(false); // …and it is NOT a seed member
    expect(routerKnows("publish_post")).toBe(true); // the union of the two
  });

  // ── the reachability claim ────────────────────────────────────────────────
  it("every declared intent is one the ROUTER accepts (resolveVerbIntent does not throw)", () => {
    // The real single writer's own validation, called directly. A typo, or a
    // slug the router cannot serve, throws HERE rather than being persisted
    // into the catalog as a value nothing can ever match.
    const rejected: string[] = [];
    for (const skill of CALLABLE) {
      if (skill.intent === undefined) continue;
      try {
        resolveAsApplierWould(skill);
      } catch {
        rejected.push(`${skill.name}: ${skill.intent}`);
      }
    }
    expect(rejected).toEqual([]);
  });

  it("a declared intent ACTUALLY REACHES the reverse index under its own verb id", () => {
    // THE assertion that would have caught the `messaging.send` hole. The value
    // must survive the round trip through the machinery that does the routing:
    // declared → resolved by the real writer → folded by the real index → out
    // again as this verb's id. Declaring a field is not reaching the index.
    const rows: RegistryCapability[] = [];
    for (const skill of CALLABLE) {
      if (skill.intent === undefined) continue;
      rows.push(registryRowFor(skill, resolveAsApplierWould(skill)));
    }
    const index = foldVerbsByIntent(rows);

    const unreachable: string[] = [];
    for (const skill of CALLABLE) {
      if (skill.intent === undefined) continue;
      const hits = index.get(skill.intent) ?? [];
      if (!hits.some((h) => h.verbId === skill.name)) {
        unreachable.push(
          `${skill.name} declared "${skill.intent}" but is absent`
        );
      }
    }
    expect(unreachable).toEqual([]);
  });

  it("the vocabulary is still closed — no value is a private string smuggled past the router", () => {
    // Guards the OTHER direction: an annotation must be a value the router can
    // serve, never a private string that happens to be syntactically fine.
    // Membership is the router's OWN test (seed union ∪ seeded table rows), so
    // this cannot disagree with `resolveVerbIntent` about what is valid.
    const routed = new Set(
      foldVerbsByIntent(
        CALLABLE.filter((s) => s.intent !== undefined).map((s) =>
          registryRowFor(s, s.intent as string)
        )
      ).keys()
    );
    const notInVocabulary = [...routed].filter((i) => !routerKnows(i));
    expect(notInVocabulary).toEqual([]);
    expect(routed.size).toBeGreaterThan(0);
  });

  // ── the un-routable set is a RECORDED decision, in both directions ───────
  it("an UNANNOTATED callable verb is surfaced, never silently invisible", () => {
    // The half of the hole that a "field exists" guard cannot see: a verb with
    // no intent at all is not a parse error, it is a verb an agent can never
    // find. Each one must be pinned above WITH A REASON — and the pinned set
    // must match the actual set EXACTLY, so neither adding a quietly-unroutable
    // verb nor deleting a pinned entry passes.
    const actualUnroutable = CALLABLE.filter((s) => s.intent === undefined)
      .map((s) => s.name)
      .sort();
    const pinned = Object.keys(INTENTIONALLY_UNROUTABLE).sort();
    expect(actualUnroutable).toEqual(pinned);

    // Every exemption states a reason. An empty string would satisfy the type
    // and defeat the point of the table.
    const unreasoned = Object.entries(INTENTIONALLY_UNROUTABLE)
      .filter(([, why]) => why.trim().length < 20)
      .map(([name]) => name);
    expect(unreasoned).toEqual([]);
  });

  it("every pinned exemption names a verb that actually EXISTS in the definition", () => {
    // Guards the table against rot in the other direction: a pinned name that
    // was renamed away would leave the previous test comparing two lists that
    // happen to agree, while the real reason no longer applies to anything.
    const names = new Set(ALL.map((s) => s.name));
    const dangling = Object.keys(INTENTIONALLY_UNROUTABLE).filter(
      (n) => !names.has(n)
    );
    expect(dangling).toEqual([]);
  });
});

/**
 * ── WHAT THIS GUARD DOES **NOT** COVER (measured, not implied) ──────────────
 *
 * a. IT IS NOT BEHAVIOURAL. It proves the value survives `resolveVerbIntent` →
 *    `foldVerbsByIntent`, which is the routing PATH in isolation. It does NOT
 *    prove `listCapabilities` returns the Synap Core rows to a given caller: a
 *    visibility-floor bug (a pod-wide row hidden under an active workspace lens)
 *    would leave this green while the verb is still unreachable in production.
 *    That layer is covered by `capability-registry.skill-visibility.tripwire`.
 *
 * b. IT COVERS THE POD'S OWN BUILTINS ONLY. The CP's shipped capability
 *    templates (a different repository) are the other producer of callable
 *    skills, and they are covered by
 *    `synap-control-plane-api/src/seeds/capability-template-intent-coverage.test.ts`
 *    against the same closed vocabulary. Neither file can see the other's
 *    directory, so a slug registered in one pod migration and not the other
 *    mirror is caught by the vocabulary-parity tripwire
 *    (`intent-vocabulary-one-ssot.tripwire.test.ts`), not here.
 *
 * c. IT DOES NOT JUDGE WHETHER AN INTENT IS THE *RIGHT* ONE. Reachability is a
 *    structural claim: "a value that was declared actually arrives". A
 *    confidently WRONG intent (`entity.update` tagged `enrich_entity` when it
 *    should have been something else) is fully green here and will send agents
 *    to the wrong verb. Only review catches that; no structural guard can,
 *    because the wrong value is indistinguishable from the right one.
 *
 * d. IT DOES NOT PROVE THE COLUMN IS WRITTEN. The definition carrying an intent
 *    is what the applier READS; that it lands on `skills.intent`, and that the
 *    registry's `buildVerbStates` prefers the column, are the single-writer and
 *    reader concerns covered by the existing intent-index tripwires. This file
 *    deliberately reuses `resolveVerbIntent` rather than re-deriving, so it
 *    cannot disagree with the writer, but it also cannot catch a writer that
 *    stopped calling it.
 *
 * e. THE EXEMPTION TABLE IS HAND-KEPT BY CONSTRUCTION. Unlike the scanned
 *    SET (which is derived from the definition, so a new verb joins by
 *    existing), the exemption list cannot be derived — "should this verb have
 *    an intent" is a judgement, not a computable fact. It is mitigated by
 *    asserting the two lists agree EXACTLY in both directions plus a
 *    reason-length floor, but a peer adding a verb and a matching exemption
 *    entry in one commit satisfies it. The value of the table is that the
 *    REASON is written down where the next reader will see it.
 */
