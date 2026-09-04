import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * TRIPWIRE (T5) — governed-propose PROSE must be derived, not hardcoded.
 *
 * Sibling of `cross-door-field-parity.test.ts` (T4) and
 * `routers/mcp/tools/manifest-freshness.test.ts`. Those two guard the FIELDS a
 * door emits and the SCHEMA a tool advertises. Neither looks at the sentence —
 * and the sentence is what an agent actually reads and acts on.
 *
 * ── THE FAILURE THIS CATCHES ────────────────────────────────────────────────
 * `checkPermissionOrPropose` has TWO proposed outcomes, not one:
 *   • a CONTENT proposal for the write the caller asked for; and
 *   • a WORKSPACE-JOIN gate (`proposalType === "join"`,
 *     `maybeCreateWorkspaceJoinProposal` in `utils/permission-check.ts`) filed
 *     INSTEAD of that write, when an agent is not yet a member of the
 *     workspace. That degradation is deliberate and correct.
 * A door that answers BOTH with a hardcoded `message: "<X> proposed for
 * review"` narrates, on the join path, a write that was never proposed. The
 * discriminator is not missing — `proposalType` is usually returned ONE LINE
 * BELOW the sentence that ignores it. An external agent reading
 * "Entity creation proposed for review" plus a `proposedEntityId` that resolves
 * to nothing built an entirely wrong root-cause theory from it; that is the
 * concrete damage, not a hypothetical.
 *
 * It is the same family as the "PHANTOM ENVELOPE ID FIX" comment in
 * `routers/entities/create.ts` (a proposed response must not carry a top-level
 * `id` that looks materialized) — applied there to `id` and, for years, not to
 * the prose or to `proposedEntityId` on the join branch.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 * Inside a GOVERNED-PROPOSE BRANCH, a `message`/`hint`/`note` assigned a STRING
 * LITERAL that asserts a specific write is pending must be DERIVED from the
 * discriminator — `proposedMessageFor(...)`, `isJoinGate(...)`, an explicit
 * `proposalType === "join"`, or `JOIN_GATE_*` — or carry an
 * {@link ACKNOWLEDGED} entry.
 *
 * Merely FORWARDING `proposalType: perm.proposalType` does NOT count as
 * consulting it. That is precisely the shape the defect wore: the truth present
 * in the payload, the prose ignoring it.
 *
 * ── WHAT IS DERIVED (mandatory, and asserted) ───────────────────────────────
 * 1. The CORPUS is walked RECURSIVELY from `src/routers/` and `src/services/`.
 *    Never a file list: a hardcoded list goes green over a fresh hole the
 *    moment code moves — a documented failure mode in this repo.
 * 2. The BRANCH SET is DISCOVERED by scanning for `"proposalId" in <ident>`
 *    guards and brace-matching to the end of the block. Split a handler out,
 *    add a new governed door, and it is audited on the next run.
 * 3. NON-VACUITY: the corpus, the discovered branch set and the subset of
 *    branches carrying literal prose are each asserted non-trivial, and a
 *    SELF-GUARD pins branches known to be compliant — so a broken scanner reads
 *    RED rather than green-over-nothing.
 *
 * ── WHAT A REGEX CAN AND CANNOT PROVE ───────────────────────────────────────
 * This proves a STRING LITERAL APPEARS inside a propose branch and that the
 * words `proposedMessageFor` / `isJoinGate` / `proposalType ===` do or do not
 * appear in the same block. It does NOT prove the derivation is applied to THAT
 * message, on the right branch, with the right wording, or that the resulting
 * sentence is true. A door could call `proposedMessageFor` on one field and
 * hardcode another and read green. It also cannot see a template literal or a
 * message assembled from a variable — those are invisible here, and this file
 * does not claim otherwise.
 *
 * The guarantee is one-directional and that is the useful direction: what it
 * reports RED is a branch where a write-asserting sentence is written by hand
 * with nothing in the block consulting the discriminator. It under-reports; by
 * construction it never invents a violation that isn't one.
 *
 * It also cannot prove a branch is REACHABLE by a join gate (that needs
 * `agentUserId` + `workspaceId` at the call site, resolved at runtime). Doors
 * that cannot receive one are handled as ACKNOWLEDGED entries stating that,
 * naming what would have to change — never as a silent exemption.
 *
 * ── ON ACKNOWLEDGEMENT ENTRIES — READ BEFORE ADDING ONE ─────────────────────
 * An entry states WHAT IS MISSING and WHY IT IS STILL MISSING. It must never
 * assert a fact this test cannot verify. A reason of the shape "COVERED —
 * handled elsewhere" has caused real, months-long damage in this tree twice
 * (the CP drift test's `get_document` exemption): the entry made the miss
 * PERMANENT and self-certifying. Prefer "not yet fixed, owned by X".
 *
 * Entries are SELF-CLEANING: an entry whose branch now derives its prose FAILS
 * ("remove it"), and an entry whose (file, message) pair is no longer found in
 * the corpus FAILS (the code moved and the entry now silences nothing).
 */

const API_SRC = join(__dirname, "..");
const SCAN_ROOTS = [join(API_SRC, "routers"), join(API_SRC, "services")];

// ── Corpus ───────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
      continue;
    }
    if (!p.endsWith(".ts")) continue;
    if (p.endsWith(".test.ts") || p.endsWith(".tripwire.ts")) continue;
    out.push(p);
  }
  return out;
}

/** Strip line + block comments so prose in a comment never reads as code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1);
}

interface Branch {
  file: string;
  /** 1-based line of the guard. */
  line: number;
  body: string;
}

/**
 * Discover governed-propose branches: `if ("proposalId" in <ident>) { … }` and
 * the `result.status === "proposed" && … .proposalId` variant Hub doors use.
 * The block is brace-matched, so the region never bleeds into the sibling code
 * that follows it (an over-long region invents violations from unrelated
 * strings such as "Capability not found").
 */
/*
 * THREE branch shapes, not one. The first cut of this file matched only
 * `"proposalId" in x` and `status === "proposed"`, which SILENTLY exempted
 * every door written the other two ways — including
 * `mcp/handlers/session.ts`'s `case "proposed":`, which IS join-gate
 * reachable (its service threads `agentUserId`). A guard that reports green
 * over ground it never scanned is the exact defect this file exists to catch,
 * one level up; and it falsified this file's own claim that "add a new
 * governed door, and it is audited on the next run". Widen the shapes here —
 * never narrow the corpus to make the list shorter.
 */
const GUARD =
  /"proposalId"\s+in\s+\w+|status\s*===?\s*"proposed"|"granted"\s+in\s+\w+\s*&&\s*!\w+\.granted|case\s+"proposed"\s*:/;

function discoverBranches(file: string): Branch[] {
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw);
  const lines = src.split("\n");
  const found: Branch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!GUARD.test(lines[i])) continue;
    // Find the opening brace of the guarded block (same line or the next few).
    let open = -1;
    for (let j = i; j < Math.min(i + 4, lines.length); j++) {
      const idx = lines[j].indexOf("{");
      if (idx >= 0) {
        open = j;
        break;
      }
    }
    if (open < 0) continue;
    let depth = 0;
    let started = false;
    const body: string[] = [];
    let end = open;
    outer: for (let j = open; j < Math.min(open + 200, lines.length); j++) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") depth--;
      }
      body.push(lines[j]);
      end = j;
      if (started && depth <= 0) break outer;
    }
    if (!started || depth > 0) continue;
    found.push({ file, line: i + 1, body: body.join("\n") });
    i = end;
  }
  return found;
}

/** A sentence that asserts a specific write is pending. */
const WRITE_ASSERTING =
  /proposed|awaiting approval|requires approval|proposal created|pending approval/i;

/** Prose slots an agent reads. */
const PROSE_KEY = /\b(message|hint|note)\s*:\s*(?:\n\s*)?"([^"\\]{8,300})"/g;

/**
 * The block CONSULTS the discriminator. Bare forwarding
 * (`proposalType: perm.proposalType`) is deliberately NOT accepted — that is
 * the exact shape of the defect.
 */
const CONSULTS =
  /proposedMessageFor\s*\(|isJoinGate\s*\(|JOIN_GATE_|proposalType\s*===/;

interface Violation {
  file: string;
  line: number;
  message: string;
}

function scan(): {
  branches: Branch[];
  violations: Violation[];
  files: string[];
} {
  const files = SCAN_ROOTS.flatMap((r) => walk(r));
  const branches = files.flatMap((f) => discoverBranches(f));
  const violations: Violation[] = [];
  for (const b of branches) {
    if (CONSULTS.test(b.body)) continue;
    PROSE_KEY.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PROSE_KEY.exec(b.body))) {
      const text = m[2];
      if (!WRITE_ASSERTING.test(text)) continue;
      violations.push({
        file: relative(API_SRC, b.file),
        line: b.line,
        message: text,
      });
    }
  }
  return { branches, violations, files };
}

// ── Acknowledged, still-open cases ───────────────────────────────────────────
//
// Keyed by (file, exact message literal) — NOT by line number, which every
// unrelated edit shifts. Each entry says what is missing and why it is still
// missing. None of them claims the case is handled elsewhere.

interface Ack {
  file: string;
  message: string;
  reason: string;
}

const ACKNOWLEDGED: Ack[] = [
  {
    file: "routers/proposals/executors/skill.ts",
    message: "Skill approval unexpectedly re-proposed",
    reason:
      "Not a governed-write door: this is the APPROVAL executor, which calls " +
      "the skill insert with `agentUserId: undefined` (visible ~7 lines above " +
      "the throw). `maybeCreateWorkspaceJoinProposal` returns null without an " +
      "agentUserId, so this branch cannot receive a join gate; the string is a " +
      "defensive INTERNAL_SERVER_ERROR for a re-entrant propose that should be " +
      "impossible. Left as-is deliberately — this scanner cannot read the " +
      "`agentUserId: undefined` argument, so the entry, not the code, records " +
      "why. If that argument ever becomes a real agent id, this reason is " +
      "wrong and the case must be re-examined.",
  },
  {
    file: "routers/workspaces/invites.ts",
    message: "Member addition requires approval.",
    reason:
      "Not join-gate reachable: `agentUserId` appears ZERO times in this file " +
      "(verified by grep), and `maybeCreateWorkspaceJoinProposal` returns null " +
      "without one — so this branch can only ever carry a CONTENT proposal and " +
      "the sentence is true as written. Recorded rather than converted because " +
      "this scanner cannot see which arguments reach `checkPermissionOrPropose`. " +
      "NOT a claim that the wording is ideal, and NOT coverage: the moment this " +
      "file threads an agentUserId, this reason is false and the case must be " +
      "re-examined. Surfaced only after the GUARD was widened to the " +
      '`"granted" in perm` shape — it was silently unscanned before.',
  },
  {
    file: "routers/workspaces/invites.ts",
    message: "Member removal requires approval.",
    reason:
      "Not join-gate reachable: `agentUserId` appears ZERO times in this file " +
      "(verified by grep), and `maybeCreateWorkspaceJoinProposal` returns null " +
      "without one — so this branch can only ever carry a CONTENT proposal and " +
      "the sentence is true as written. Recorded rather than converted because " +
      "this scanner cannot see which arguments reach `checkPermissionOrPropose`. " +
      "NOT a claim that the wording is ideal, and NOT coverage: the moment this " +
      "file threads an agentUserId, this reason is false and the case must be " +
      "re-examined. Surfaced only after the GUARD was widened to the " +
      '`"granted" in perm` shape — it was silently unscanned before.',
  },
  {
    file: "routers/workspaces/invites.ts",
    message: "Role update requires approval.",
    reason:
      "Not join-gate reachable: `agentUserId` appears ZERO times in this file " +
      "(verified by grep), and `maybeCreateWorkspaceJoinProposal` returns null " +
      "without one — so this branch can only ever carry a CONTENT proposal and " +
      "the sentence is true as written. Recorded rather than converted because " +
      "this scanner cannot see which arguments reach `checkPermissionOrPropose`. " +
      "NOT a claim that the wording is ideal, and NOT coverage: the moment this " +
      "file threads an agentUserId, this reason is false and the case must be " +
      "re-examined. Surfaced only after the GUARD was widened to the " +
      '`"granted" in perm` shape — it was silently unscanned before.',
  },
  {
    file: "routers/workspaces.ts",
    message: "Workspace creation requires approval.",
    reason:
      "Not join-gate reachable: `agentUserId` appears ZERO times in this file " +
      "(verified by grep), and `maybeCreateWorkspaceJoinProposal` returns null " +
      "without one — so this branch can only ever carry a CONTENT proposal and " +
      "the sentence is true as written. Recorded rather than converted because " +
      "this scanner cannot see which arguments reach `checkPermissionOrPropose`. " +
      "NOT a claim that the wording is ideal, and NOT coverage: the moment this " +
      "file threads an agentUserId, this reason is false and the case must be " +
      "re-examined. Surfaced only after the GUARD was widened to the " +
      '`"granted" in perm` shape — it was silently unscanned before.',
  },
  {
    file: "routers/workspaces.ts",
    message: "Workspace update requires approval.",
    reason:
      "Not join-gate reachable: `agentUserId` appears ZERO times in this file " +
      "(verified by grep), and `maybeCreateWorkspaceJoinProposal` returns null " +
      "without one — so this branch can only ever carry a CONTENT proposal and " +
      "the sentence is true as written. Recorded rather than converted because " +
      "this scanner cannot see which arguments reach `checkPermissionOrPropose`. " +
      "NOT a claim that the wording is ideal, and NOT coverage: the moment this " +
      "file threads an agentUserId, this reason is false and the case must be " +
      "re-examined. Surfaced only after the GUARD was widened to the " +
      '`"granted" in perm` shape — it was silently unscanned before.',
  },
  {
    file: "routers/workspaces.ts",
    message: "Workspace start change requires approval.",
    reason:
      "Not join-gate reachable: `agentUserId` appears ZERO times in this file " +
      "(verified by grep), and `maybeCreateWorkspaceJoinProposal` returns null " +
      "without one — so this branch can only ever carry a CONTENT proposal and " +
      "the sentence is true as written. Recorded rather than converted because " +
      "this scanner cannot see which arguments reach `checkPermissionOrPropose`. " +
      "NOT a claim that the wording is ideal, and NOT coverage: the moment this " +
      "file threads an agentUserId, this reason is false and the case must be " +
      "re-examined. Surfaced only after the GUARD was widened to the " +
      '`"granted" in perm` shape — it was silently unscanned before.',
  },
  {
    file: "routers/workspaces.ts",
    message: "Intelligence service update requires approval.",
    reason:
      "Not join-gate reachable: `agentUserId` appears ZERO times in this file " +
      "(verified by grep), and `maybeCreateWorkspaceJoinProposal` returns null " +
      "without one — so this branch can only ever carry a CONTENT proposal and " +
      "the sentence is true as written. Recorded rather than converted because " +
      "this scanner cannot see which arguments reach `checkPermissionOrPropose`. " +
      "NOT a claim that the wording is ideal, and NOT coverage: the moment this " +
      "file threads an agentUserId, this reason is false and the case must be " +
      "re-examined. Surfaced only after the GUARD was widened to the " +
      '`"granted" in perm` shape — it was silently unscanned before.',
  },
  {
    file: "routers/workspaces.ts",
    message: "Workspace deletion requires approval.",
    reason:
      "Not join-gate reachable: `agentUserId` appears ZERO times in this file " +
      "(verified by grep), and `maybeCreateWorkspaceJoinProposal` returns null " +
      "without one — so this branch can only ever carry a CONTENT proposal and " +
      "the sentence is true as written. Recorded rather than converted because " +
      "this scanner cannot see which arguments reach `checkPermissionOrPropose`. " +
      "NOT a claim that the wording is ideal, and NOT coverage: the moment this " +
      "file threads an agentUserId, this reason is false and the case must be " +
      "re-examined. Surfaced only after the GUARD was widened to the " +
      '`"granted" in perm` shape — it was silently unscanned before.',
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TRIPWIRE — governed-propose prose is derived, not hardcoded", () => {
  const { branches, violations, files } = scan();

  it("NON-VACUITY: the corpus and the discovered branch set are non-trivial", () => {
    expect(files.length).toBeGreaterThan(150);
    expect(branches.length).toBeGreaterThan(50);
    // Branches carrying ANY string literal — if this collapses, the body
    // extractor broke and every "no violations" result below is vacuous.
    // DELIBERATELY not counted on the PROSE_KEY regex: fixing a door moves its
    // literal INSIDE `proposedMessageFor(...)`, so a prose-slot counter would
    // shrink toward zero exactly as the codebase gets healthier — a non-vacuity
    // check that dies of success is not one.
    const withLiteral = branches.filter((b) => /"[^"\\]{8,}"/.test(b.body));
    expect(withLiteral.length).toBeGreaterThan(30);
    // …and the DERIVED set: branches that do consult the discriminator. If the
    // CONSULTS detector breaks, this reads red rather than reporting every
    // fixed door as a fresh violation.
    const derived = branches.filter((b) => CONSULTS.test(b.body));
    expect(derived.length).toBeGreaterThan(10);
  });

  it("SELF-GUARD: known-compliant branches are detected as deriving their prose", () => {
    // These were fixed by deriving the message from `proposalType`. If the
    // CONSULTS detector breaks, this reads RED — instead of the whole suite
    // going green over a broken engine.
    const compliant = [
      "routers/entities/mutate.ts",
      "routers/entities/facets.ts",
      "routers/hub-protocol/documents.ts",
      "services/focus-sessions/create-session.ts",
    ];
    for (const rel of compliant) {
      const abs = join(API_SRC, rel);
      expect(existsSync(abs), `${rel} moved — update this self-guard`).toBe(
        true
      );
      const mine = branches.filter((b) => b.file === abs);
      expect(
        mine.length,
        `no propose branch discovered in ${rel}`
      ).toBeGreaterThan(0);
      expect(
        mine.some((b) => CONSULTS.test(b.body)),
        `${rel} no longer derives its proposed-branch prose from proposalType`
      ).toBe(true);
    }
  });

  it("SELF-GUARD: brace matching keeps a branch region tight", () => {
    // A region that bleeds past its block picks up unrelated strings. Assert no
    // discovered body is absurdly long (the guard is 200 lines; real propose
    // branches are ~5-25).
    const huge = branches.filter((b) => b.body.split("\n").length > 60);
    expect(huge.map((b) => `${relative(API_SRC, b.file)}:${b.line}`)).toEqual(
      []
    );
  });

  it("every write-asserting message in a propose branch is derived or acknowledged", () => {
    const unacknowledged = violations.filter(
      (v) =>
        !ACKNOWLEDGED.some((a) => a.file === v.file && a.message === v.message)
    );
    expect(
      unacknowledged.map(
        (v) => `${v.file}:${v.line} — ${JSON.stringify(v.message)}`
      ),
      "A governed-propose branch hardcodes a sentence asserting a specific " +
        "write is pending, while nothing in the block consults `proposalType`. " +
        "On a workspace-JOIN gate that sentence is FALSE — the write was never " +
        "proposed. Derive it with `proposedMessageFor(perm.proposalType, …)` " +
        "(utils/permission-check.ts), omit any pre-allocated id on the join " +
        "path, or add an ACKNOWLEDGED entry saying why it is still open."
    ).toEqual([]);
  });

  it("acknowledgement entries are self-cleaning", () => {
    const stale = ACKNOWLEDGED.filter(
      (a) =>
        !violations.some((v) => v.file === a.file && v.message === a.message)
    );
    expect(
      stale.map((a) => `${a.file} — ${JSON.stringify(a.message)}`),
      "This case is no longer reported (fixed, or the code moved and the entry " +
        "now silences nothing). Remove the ACKNOWLEDGED entry."
    ).toEqual([]);
  });

  it("acknowledgement reasons never claim coverage this test cannot verify", () => {
    const banned = /\bCOVERED\b|handled elsewhere|covered elsewhere/i;
    expect(
      ACKNOWLEDGED.filter((a) => banned.test(a.reason)).map((a) => a.file)
    ).toEqual([]);
    for (const a of ACKNOWLEDGED) {
      expect(a.reason.length, `reason too thin for ${a.file}`).toBeGreaterThan(
        30
      );
    }
  });
});
