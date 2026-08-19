/**
 * TRIPWIRE — every governed write door must have its approval half.
 *
 * A mutation that files a proposal can return `{ status: "proposed" }`. If no
 * approval half exists for that `${targetType}/${proposalType}` key, approving
 * the proposal falls to the star-slash-star catch-all — which, for a gate-made
 * proposal, does NOT throw. The gate always stamps
 * `requestId`/`targetType`/`changeType` (`permission-check.ts`), so
 * `isRequestShapedProposalData` is always true and the catch-all takes its EMIT
 * branch: `.validated` fires, the status flips to APPROVED, and it returns
 * `{ success: true }`. The reviewer sees a GREEN approval and NOTHING HAPPENS.
 *
 * Silent success is worse than a throw — a throw would surface the gap the
 * first time anyone approved. This has happened three times in this codebase
 * (`project/update`, `playbook/update`, and the create-side variant where the
 * gate carried only `{ name }` so an approved create materialized an empty
 * shell). It is invisible to typecheck, to every direct-path test, and to any
 * test that exercises the human path — because the human path never proposes.
 *
 * ── WHAT CHANGED (2026-08-19) ───────────────────────────────────────────────
 * This file used to pin a HAND-TYPED array of 8 keys out of ~90 doors — ~9%
 * coverage, and it could only ever find what someone remembered to add. (Its
 * own docstring argued that deriving the list would make the test vacuous. That
 * is true only if you derive the LEFT side from the RIGHT side. Deriving the
 * two sides from INDEPENDENT sources is not vacuous — it is the whole test.)
 *
 *   LEFT  = `GOVERNED_WRITE_DOORS` (@synap/governance-policy) — the vocabulary
 *           of keys a proposal can be FILED under. `PermissionCheckOpts` is
 *           typed as an intersection with the pair union derived from
 *           `GATE_WRITE_DOORS`, so a call site cannot invent a door without
 *           declaring it. That is what makes the left side enumerable from the
 *           TYPE SYSTEM rather than from a regex that rots.
 *   RIGHT = read LIVE, from THREE independent approval halves (see below).
 *
 * Assertion: LEFT ⊆ RIGHT ∪ {@link ACKNOWLEDGED_GAPS}, the gap count never
 * grows, and a listed gap that has since been CLOSED fails ("remove the entry").
 *
 * ── THE THREE APPROVAL HALVES (all read live; none hand-listed) ─────────────
 *  1. `proposalExecRegistry` — exact composite key, or the proposalType-only
 *     key (`messaging.external.send`), which `resolve()` tries before the
 *     wildcard. Read from the LIVE registry after `registerApproveExecutors()`,
 *     so an executor a sibling branch adds is counted without touching this file.
 *  2. The MATERIALIZER's per-subject ACTION GUARDS, not its `case` labels. This
 *     distinction is the point: `case "workspace"` exists, but
 *     `materializeWorkspace` early-returns unless `action === "join"`, and
 *     `materializeRelation` unless `action === "create"`. Counting case labels
 *     would score three severed doors as wired.
 *  3. The INLINE branches in `apply-approval.ts` that run BEFORE the registry
 *     (`proposal.proposalType === "governance.widen_lane"`, ...). All five
 *     `governance.*` doors are handled there and nowhere else — a scanner that
 *     read only the registry would report five phantom orphans.
 *
 * ── LIMIT — READ THIS BEFORE TRUSTING IT ────────────────────────────────────
 * This proves an approval half is REGISTERED/REACHABLE, never that it writes
 * the right rows. `playbook/update` had an executor that stored only `{ id }`;
 * this tripwire would have called that door wired. Payload sufficiency is a
 * different (integration) test.
 *
 * ── ANTI-STALENESS (the documented `tripwires-lose-coverage-silently` failure) ─
 * Copied from the proven template `cross-door-verb-parity.test.ts`:
 *   1. Scan directory ROOTS RECURSIVELY / name single files explicitly.
 *   2. Assert every scanned path EXISTS — a moved file fails loudly instead of
 *      scanning nothing and passing.
 *   3. SELF-GUARD on a known-positive per source — a broken parser reads red,
 *      not "everything is a gap" (or worse, "everything is covered").
 *   4. Assert the corpus SIZE per source — a file that still exists but was
 *      emptied, or a parser whose regex stopped matching, fails.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  GOVERNED_WRITE_DOORS,
  GATE_WRITE_DOORS,
  DIRECT_PROPOSAL_DOORS,
} from "@synap/governance-policy";
import { proposalExecRegistry } from "../routers/proposals/execution-registry.js";
import { registerApproveExecutors } from "../routers/proposals/approve-executors.js";

const API_SRC = join(__dirname, "..");
const BACKEND_PACKAGES = join(API_SRC, "../..");
const JOBS_SRC = join(BACKEND_PACKAGES, "jobs/src");

const MATERIALIZER = join(JOBS_SRC, "workers/materializer.ts");
const APPLY_APPROVAL = join(API_SRC, "routers/proposals/apply-approval.ts");

// ── LEFT: the declared vocabulary ────────────────────────────────────────────

const LEFT: string[] = Object.keys(GOVERNED_WRITE_DOORS).sort();

// ── RIGHT #2: the materializer's ACTION GUARDS ───────────────────────────────

/**
 * Parse `materializer.ts` into the `${subjectType}/${action}` pairs it will
 * actually apply.
 *
 * Two guard shapes appear in that file and BOTH must be read:
 *   - positive: `if (action === "create") { ... } else if (action === "update")`
 *   - negative: `if (action !== "join") { warn; return; }`  ← an ALLOWLIST OF ONE
 * The negative form is the one that severs doors, and it is the form a naive
 * `action === ` scan misses entirely.
 */
function parseMaterializerPairs(src: string): Set<string> {
  const subjectToFn = new Map<string, string>();
  for (const m of src.matchAll(/case "(\w+)":([\s\S]*?)break;/g)) {
    const fn = m[2].match(/await (materialize\w+)\(/);
    if (fn) subjectToFn.set(m[1], fn[1]);
  }
  // Fall-through labels (`case "facet": case "entity_facet":`) share the body
  // of the label that carries the call.
  for (const m of src.matchAll(
    /case "(\w+)":\s*\n\s*(?:\/\/[^\n]*\n\s*)*case "(\w+)":/g
  )) {
    const target = subjectToFn.get(m[2]);
    if (target) subjectToFn.set(m[1], target);
  }

  const pairs = new Set<string>();
  for (const [subject, fn] of subjectToFn) {
    const at = src.indexOf(`async function ${fn}(`);
    if (at < 0) continue;
    const after = src.slice(at + 10).search(/\nasync function /);
    const body = src.slice(at, after < 0 ? src.length : at + 10 + after);
    const negative = [...body.matchAll(/action !== "([\w.]+)"/g)].map(
      (x) => x[1]
    );
    const positive = [...body.matchAll(/action === "([\w.]+)"/g)].map(
      (x) => x[1]
    );
    // A negative guard is an allowlist and OVERRIDES the positive matches
    // inside it; an unguarded function is not counted as covering anything
    // (we cannot prove which actions it handles, and guessing "all" would
    // manufacture coverage — the exact failure mode this file exists to catch).
    for (const action of negative.length ? negative : positive) {
      pairs.add(`${subject}/${action}`);
    }
  }
  return pairs;
}

// ── RIGHT #3: inline branches in apply-approval.ts ───────────────────────────

/** proposalTypes handled inline, BEFORE the executor registry is consulted. */
function parseInlineApprovalTypes(src: string): Set<string> {
  return new Set(
    [...src.matchAll(/proposal\.proposalType === "([\w.]+)"/g)].map((m) => m[1])
  );
}

// ── Creation-door completeness scan (anti-rot for the DIRECT half) ───────────

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  "__tripwires__",
  "__tests__",
]);

/** RULE 1: recursive directory walk — never a file-path list. */
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
    if (name.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

interface ScanRoot {
  dir: string;
  fileFloor: number;
}
const SCAN_ROOTS: ScanRoot[] = [
  { dir: API_SRC, fileFloor: 300 },
  { dir: JOBS_SRC, fileFloor: 40 },
];

/**
 * Literal `targetType` + `proposalType` pairs written anywhere in the api/jobs
 * sources — the shape every direct proposal insert
 * (`insertPendingProposal` / `createPendingProposal` / bespoke) has to write.
 *
 * The GATE half needs no scan: `PermissionCheckOpts` pins the pair to
 * `GATE_WRITE_DOORS` at compile time, which is strictly stronger. This scan
 * exists only for the doors the type system cannot reach, so that
 * `DIRECT_PROPOSAL_DOORS` cannot silently fall behind the code.
 */
function scanDirectProposalPairs(sources: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sources) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(
      /targetType:\s*"(\w+)"[\s\S]{0,600}?proposalType:\s*"([\w.]+)"/g
    )) {
      const key = `${m[1]}/${m[2]}`;
      if (!found.has(key)) found.set(key, file);
    }
  }
  return found;
}

// ── Acknowledged gaps ────────────────────────────────────────────────────────

interface Gap {
  /** `${targetType}/${proposalType}`. */
  door: string;
  /** WHY this door has no approval half. One line. Required. */
  reason: string;
}

const SEVERED =
  "SEVERED (seeded 2026-08-19, NOT triaged): no exact executor, no materializer " +
  "action guard, no inline apply-approval branch. An approved proposal on this " +
  "door hits the catch-all and silently succeeds. Listed so the ratchet can hold " +
  "while these are worked through — this is an admission, not a justification.";

/**
 * Doors with no approval half TODAY. Every entry must carry a reason, and the
 * count may only ever go DOWN ({@link GAP_CEILING}).
 *
 * Seeded from the live state on 2026-08-19 by running this scan. They are NOT
 * justified keeps: each one is a real severance of the exact class described in
 * the header. Closing one means writing the executor and DELETING its row —
 * the "no stale gap" test fails if you leave it.
 */
const ACKNOWLEDGED_GAPS: Gap[] = [
  { door: "agent/updateCapabilities", reason: SEVERED },
  { door: "apiKey/create", reason: SEVERED },
  { door: "apiKey/update", reason: SEVERED },
  { door: "artifact/create", reason: SEVERED },
  { door: "artifact/setState", reason: SEVERED },
  { door: "bento/arrange", reason: SEVERED },
  { door: "capability/attach", reason: SEVERED },
  { door: "capability/create", reason: SEVERED },
  { door: "cell/update", reason: SEVERED },
  { door: "context/link", reason: SEVERED },
  {
    door: "document/user_edit",
    reason:
      "JUSTIFIED KEEP, not a severance — apply-approval.ts branch B3 applies it, " +
      'but that branch keys on `targetType === "document"` PLUS the payload ' +
      "predicate `isDocumentContentProposalData`, which a proposalType-keyed scan " +
      "cannot see. Teaching the parser to treat a bare targetType branch as " +
      "coverage would score every future `document/*` door as wired, so this is " +
      "acknowledged instead of widening the detector.",
  },
  { door: "entity/capture.graph", reason: SEVERED },
  { door: "entity/import.graph", reason: SEVERED },
  { door: "focus_session/grant_capability", reason: SEVERED },
  { door: "playbook_run/update", reason: SEVERED },
  { door: "proactive/recap", reason: SEVERED },
  { door: "relation/update", reason: SEVERED },
  { door: "role/create", reason: SEVERED },
  { door: "role/update", reason: SEVERED },
  { door: "skill/update", reason: SEVERED },
  { door: "tool/update", reason: SEVERED },
  { door: "vault/vault.request", reason: SEVERED },
  { door: "whiteboard/place", reason: SEVERED },
  { door: "widget/register", reason: SEVERED },
  { door: "workspaceMember/add", reason: SEVERED },
  { door: "workspaceMember/remove", reason: SEVERED },
  { door: "workspaceMember/updateRole", reason: SEVERED },
];

/**
 * The ratchet. Seeded at the length of the list above; it may only ever be
 * LOWERED. Raising it is how this contract would quietly erode, so any PR that
 * raises it is doing the thing this file exists to prevent.
 */
const GAP_CEILING = 27;

// ── Load the sources ─────────────────────────────────────────────────────────

const materializerSrc = existsSync(MATERIALIZER)
  ? readFileSync(MATERIALIZER, "utf8")
  : "";
const applyApprovalSrc = existsSync(APPLY_APPROVAL)
  ? readFileSync(APPLY_APPROVAL, "utf8")
  : "";

const MATERIALIZED = parseMaterializerPairs(materializerSrc);
const INLINE_TYPES = parseInlineApprovalTypes(applyApprovalSrc);

const SCAN_SOURCES = SCAN_ROOTS.filter((r) => existsSync(r.dir)).flatMap((r) =>
  collectSources(r.dir)
);
const DIRECT_PAIRS_IN_SOURCE = scanDirectProposalPairs(SCAN_SOURCES);

/** Is this door covered by ANY of the three approval halves? Read live. */
function isCovered(door: string): boolean {
  const slash = door.indexOf("/");
  const proposalType = door.slice(slash + 1);
  if (proposalExecRegistry.resolveExact(door)) return true;
  // resolve() tries the proposalType-only key before the wildcard.
  if (proposalExecRegistry.resolveExact(proposalType)) return true;
  if (MATERIALIZED.has(door)) return true;
  if (INLINE_TYPES.has(proposalType)) return true;
  return false;
}

// ── The tripwire ─────────────────────────────────────────────────────────────

describe("governed write doors have an approval half", () => {
  beforeAll(() => {
    registerApproveExecutors();
  });

  // RULE 2 — a moved/renamed source must fail loudly, not parse nothing.
  it.each([
    ["materializer", MATERIALIZER],
    ["apply-approval", APPLY_APPROVAL],
  ])("the %s source exists at the path this test parses", (_name, path) => {
    expect(
      existsSync(path),
      `${path} does not exist — it was moved or renamed. Update the constant. ` +
        `Do NOT let this tripwire parse an empty string and report green.`
    ).toBe(true);
  });

  it.each(SCAN_ROOTS)("the scan root $dir exists", (root) => {
    expect(existsSync(root.dir), `Scan root missing: ${root.dir}`).toBe(true);
  });

  // RULE 4 — a source that still exists but got emptied, or a parser whose
  // regex stopped matching, must fail rather than silently score zero.
  it("each parsed source yields a non-trivial corpus", () => {
    expect(
      MATERIALIZED.size,
      "The materializer parser found (almost) no action guards — the file was " +
        "restructured and the regexes no longer match. Every 'covered' verdict " +
        "below is untrustworthy until the parser is fixed."
    ).toBeGreaterThan(8);
    expect(
      INLINE_TYPES.size,
      "The apply-approval inline-branch parser found (almost) nothing."
    ).toBeGreaterThan(3);
    expect(
      SCAN_SOURCES.length,
      `Scanned only ${SCAN_SOURCES.length} source files across api + jobs.`
    ).toBeGreaterThan(SCAN_ROOTS.reduce((n, r) => n + r.fileFloor, 0));
    expect(LEFT.length).toBeGreaterThan(80);
  });

  // RULE 3 — self-guard, one KNOWN POSITIVE per approval half. If a parser or
  // the registry lookup breaks, these read red instead of the gap list either
  // exploding (looks like a wall of new severances) or collapsing (looks clean).
  it("SELF-GUARD: the registry half is readable (entity/create)", () => {
    expect(proposalExecRegistry.resolveExact("entity/create")).toBeDefined();
  });

  it("SELF-GUARD: the materializer parser reads NEGATIVE guards (workspace/join)", () => {
    // `materializeWorkspace` guards with `if (action !== "join") return;`.
    // If this fails, the parser is only seeing `action === ` and is silently
    // scoring severed doors as wired.
    expect(MATERIALIZED.has("workspace/join")).toBe(true);
    expect(
      MATERIALIZED.has("workspace/update"),
      'The materializer parser thinks `case "workspace"` covers every action. ' +
        "It does not — `materializeWorkspace` handles ONLY 'join'. Reading case " +
        "labels instead of action guards is the exact mistake this guard exists for."
    ).toBe(false);
  });

  it("SELF-GUARD: the inline apply-approval parser works (governance.widen_lane)", () => {
    expect(INLINE_TYPES.has("governance.widen_lane")).toBe(true);
  });

  it("SELF-GUARD: an unregistered key resolves to nothing", () => {
    // Guards against the whole file becoming vacuous (e.g. if a future change
    // made `resolveExact` fall back to the wildcard).
    expect(
      proposalExecRegistry.resolveExact("nonexistent-target/nonexistent-action")
    ).toBeUndefined();
    expect(isCovered("nonexistent-target/nonexistent-action")).toBe(false);
  });

  // ── The contract ───────────────────────────────────────────────────────────

  it("every governed write door is covered or acknowledged", () => {
    const acknowledged = new Set(ACKNOWLEDGED_GAPS.map((g) => g.door));
    const unexplained = LEFT.filter(
      (door) => !isCovered(door) && !acknowledged.has(door)
    );
    expect(
      unexplained,
      `These governed write doors can file a proposal that NOTHING applies on ` +
        `approval — the catch-all flips it to APPROVED, emits .validated, and ` +
        `returns success while the change never lands:\n  ` +
        `${unexplained.join("\n  ")}\n` +
        `Either write the approval half (an executor in ` +
        `routers/proposals/executors/, a materializer action guard, or an ` +
        `apply-approval branch), or add an ACKNOWLEDGED_GAPS entry saying why ` +
        `— and lower nothing: the ceiling only goes down.`
    ).toEqual([]);
  });

  it("the acknowledged-gap count never grows", () => {
    expect(
      ACKNOWLEDGED_GAPS.length,
      `ACKNOWLEDGED_GAPS has ${ACKNOWLEDGED_GAPS.length} entries but the ` +
        `ceiling is ${GAP_CEILING}. A new severed door was acknowledged instead ` +
        `of wired. Write the approval half; do not raise the ceiling.`
    ).toBeLessThanOrEqual(GAP_CEILING);
  });

  it("no acknowledged gap is STALE (it has since been wired)", () => {
    const closed = ACKNOWLEDGED_GAPS.filter((g) => isCovered(g.door)).map(
      (g) => g.door
    );
    expect(
      closed,
      `These doors are listed as acknowledged gaps but they now HAVE an ` +
        `approval half. Delete the entry and lower GAP_CEILING to ` +
        `${ACKNOWLEDGED_GAPS.length - closed.length}, or the table rots into a ` +
        `list of things that used to be true:\n  ${closed.join("\n  ")}`
    ).toEqual([]);
  });

  it("every acknowledged gap names a declared door and carries a reason", () => {
    const declared = new Set(LEFT);
    const dead = ACKNOWLEDGED_GAPS.filter((g) => !declared.has(g.door)).map(
      (g) => g.door
    );
    expect(
      dead,
      `These ACKNOWLEDGED_GAPS entries name a door that is not in ` +
        `GOVERNED_WRITE_DOORS (renamed or removed) — a dead entry silences ` +
        `nothing and hides the rename:\n  ${dead.join("\n  ")}`
    ).toEqual([]);
    const reasonless = ACKNOWLEDGED_GAPS.filter(
      (g) => g.reason.trim().length < 20
    ).map((g) => g.door);
    expect(
      reasonless,
      "A gap without a real reason is a silenced failure"
    ).toEqual([]);
  });

  // ── Anti-rot for the half the type system cannot reach ─────────────────────

  it("every direct proposal insert in the source is a DECLARED door", () => {
    const undeclared = [...DIRECT_PAIRS_IN_SOURCE.entries()]
      .filter(([door]) => !(door in GOVERNED_WRITE_DOORS))
      .map(([door, file]) => `${door}  (${file})`);
    expect(
      undeclared,
      `These \`targetType\`/\`proposalType\` pairs are written in the sources ` +
        `but are NOT declared in GOVERNED_WRITE_DOORS, so this tripwire never ` +
        `checked whether they have an approval half. Add them to ` +
        `DIRECT_PROPOSAL_DOORS in @synap/governance-policy:\n  ` +
        `${undeclared.join("\n  ")}`
    ).toEqual([]);
  });

  it("the two door maps do not overlap and together form the vocabulary", () => {
    const overlap = Object.keys(GATE_WRITE_DOORS).filter(
      (k) => k in DIRECT_PROPOSAL_DOORS
    );
    expect(
      overlap,
      `A door is declared in BOTH GATE_WRITE_DOORS and DIRECT_PROPOSAL_DOORS; ` +
        `the spread that builds GOVERNED_WRITE_DOORS silently keeps one:\n  ` +
        `${overlap.join("\n  ")}`
    ).toEqual([]);
    expect(LEFT.length).toBe(
      Object.keys(GATE_WRITE_DOORS).length +
        Object.keys(DIRECT_PROPOSAL_DOORS).length
    );
  });
});
