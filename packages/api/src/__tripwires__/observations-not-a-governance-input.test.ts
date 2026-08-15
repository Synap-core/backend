import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * OBSERVATIONS-ARE-NOT-A-GOVERNANCE-INPUT TRIPWIRE (§06-Q5)
 *
 * INVARIANT: no governance / trust / oversight reader may key on OBSERVATION
 * rows. An observation is an unauthenticated-webhook-class fact ("a commit
 * landed") appended by any hub-protocol.write key. If a governance metric ever
 * counted them, an agent could move its own oversight numbers by RECORDING
 * facts — the exact loop governance exists to close. The unified trigger hop
 * (an observation can now FIRE an automation) does not weaken this: a fired
 * automation's THEN-actions are still governed against the producer, and the
 * observation itself remains invisible to every governance READER.
 *
 * The invariant holds today via THREE structural properties. This gate freezes
 * all three at source level (à la the other __tripwires__), so a future edit
 * that quietly makes an observation a governance input trips here first.
 *
 *  (1) Observations set `agentUserId` but NEVER `isAgent`. Every ceiling reader
 *      (`countAgentWritesTodayUtc`, `recommend-raise-ceiling`) ANDs on
 *      `is_agent = true`, so an observation is excluded from an agent's
 *      daily-write ceiling. Recording a fact must never cost an agent its
 *      right to act.
 *  (2) `RESERVED_SUBJECT_TYPES` blocks a caller from claiming a subjectType a
 *      governance reader keys on (routing-memory, workflow-place, scorecard).
 *  (3) `OBSERVATION_NAMESPACES` is disjoint from any first-party / governance
 *      namespace, and observations never create `proposals` (the row every
 *      scorecard / scanner / recommender keys on).
 */

// Resolve source paths relative to THIS test file (robust to the runner's cwd —
// which is the repo root under a `--root packages/api` invocation, not the
// package dir). This file lives at packages/api/src/__tripwires__/.
const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, ".."); // packages/api/src
const DB_SRC = join(HERE, "..", "..", "..", "database", "src"); // packages/database/src
const read = (abs: string) => readFileSync(abs, "utf8");

const OBSERVATIONS = read(
  join(API_SRC, "routers/hub-protocol/observations.ts")
);

// OBSERVATION_NAMESPACES is DECLARED in @synap-core/types (events/unified.ts) and
// only re-exported by the door — the automation authoring door's
// `validateEventPattern` lives there and must accept the same namespaces, and a
// second copy in the api package would drift. Property 3a therefore reads the
// declaration site, not the re-export.
const TYPES_SRC = join(HERE, "..", "..", "..", "types", "src"); // packages/types/src
const UNIFIED_EVENTS = read(join(TYPES_SRC, "events/unified.ts"));

describe("§06-Q5: observations are not a governance input", () => {
  // ── Property 1: the ceiling readers still floor on is_agent = true ─────────
  const CEILING_READERS: Array<{ label: string; abs: string }> = [
    {
      label: "countAgentWritesTodayUtc (resolve-agent-governance-decision.ts)",
      abs: join(DB_SRC, "utils/resolve-agent-governance-decision.ts"),
    },
    {
      label: "recommend-raise-ceiling.ts",
      abs: join(API_SRC, "services/proposals/recommend-raise-ceiling.ts"),
    },
  ];

  for (const reader of CEILING_READERS) {
    it(`${reader.label} still ANDs on eq(events.isAgent, true)`, () => {
      const src = read(reader.abs);
      // Scope the assertion to the ceiling COUNT query where possible, so a
      // stray `is_agent = true` elsewhere in the file can't mask the floor being
      // removed from the count itself (the brittleness of a bare file-wide
      // `includes`). `countAgentWritesTodayUtc` is the count reader in
      // resolve-agent-governance-decision.ts; scope to its body. For the other
      // reader (no single well-known fn name) fall back to the file-wide check.
      // Match the DEFINITION only (`export async function …`), never a
      // doc-comment mention — recommend-raise-ceiling.ts references the name in
      // prose but defines its own query, so it correctly falls back to file-wide.
      const countFn = src.match(
        /export async function countAgentWritesTodayUtc[\s\S]*?\n}/
      )?.[0];
      const haystack = countFn ?? src;
      expect(
        haystack.includes("eq(events.isAgent, true)"),
        `${reader.label}: must keep the is_agent=true floor on the ceiling count, else observations (which fill agentUserId) would burn an agent's write ceiling`
      ).toBe(true);
    });
  }

  it("observations set agentUserId but never STAMP isAgent on the event", () => {
    // The header documents `isAgent` at length; what is forbidden is SETTING it
    // (an `isAgent:` key in the createSynapEvent payload). Attribution via
    // `agentUserId` is required and present.
    expect(OBSERVATIONS).toMatch(/agentUserId/);
    expect(
      /isAgent\s*:/.test(OBSERVATIONS),
      "observations.ts must NOT stamp `isAgent:` — that would make an observation count toward an agent's governed-write ceiling"
    ).toBe(false);
  });

  // ── Property 2: RESERVED_SUBJECT_TYPES is a superset of the governance-keyed
  //    subjectTypes ────────────────────────────────────────────────────────
  it("RESERVED_SUBJECT_TYPES blocks every subjectType a governance/oversight reader keys on", () => {
    // subjectTypes that first-party governance / trust / feed readers select on:
    //   ai_decision / ai_correction → routing-threshold + routing-memory
    //   focus_session               → workflow-place feed (no userId floor)
    //   proposal                    → scorecard / scanner / recommenders
    //   entity                      → first-party domain surface
    const MUST_RESERVE = [
      "ai_decision",
      "ai_correction",
      "focus_session",
      "proposal",
      "entity",
    ];
    // Scope the check to the RESERVED_SUBJECT_TYPES Set literal so a mention in
    // a comment elsewhere cannot satisfy it.
    const block = OBSERVATIONS.match(
      /RESERVED_SUBJECT_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/
    );
    expect(
      block,
      "RESERVED_SUBJECT_TYPES Set literal must exist"
    ).not.toBeNull();
    const body = block![1];
    for (const t of MUST_RESERVE) {
      expect(
        body.includes(`"${t}"`),
        `RESERVED_SUBJECT_TYPES must include "${t}" — a governance reader keys on it, so a forged observation could pose as first-party signal`
      ).toBe(true);
    }
  });

  // ── Property 3a: observation namespaces are disjoint from governance/first-
  //    party namespaces ──────────────────────────────────────────────────────
  // LIMITATION (named, not fixed): this freezes a HARDCODED forbidden set — it
  // proves the currently-known governance/first-party namespaces stay out of
  // OBSERVATION_NAMESPACES, but a NEW governance namespace added later would not
  // be caught here until it is added to FORBIDDEN. The stronger structural check
  // — "no governance reader file SELECTs an OBSERVATION_NAMESPACE" — needs a
  // cross-file scan of every reader and is deferred as over-scope for this gate.
  it("OBSERVATION_NAMESPACES is disjoint from every first-party/governance namespace", () => {
    const block = UNIFIED_EVENTS.match(
      /OBSERVATION_NAMESPACES\s*=\s*\[([\s\S]*?)\]\s*as const/
    );
    expect(
      block,
      "OBSERVATION_NAMESPACES array literal must exist"
    ).not.toBeNull();
    const declared = Array.from(block![1].matchAll(/"([a-z0-9]+)"/g)).map(
      (m) => m[1]
    );
    expect(declared.length).toBeGreaterThan(0);
    // Namespaces that a first-party domain or a governance reader would treat as
    // authoritative. An observation may NEVER live under one of these.
    const FORBIDDEN = new Set([
      "entity",
      "workspace",
      "proposal",
      "focus",
      "focus_session",
      "ai",
      "ai_decision",
      "ai_correction",
      "agent",
      "agentrun",
      "governance",
      "user",
      "member",
    ]);
    for (const ns of declared) {
      expect(
        FORBIDDEN.has(ns),
        `OBSERVATION_NAMESPACES may not contain "${ns}" — it collides with a first-party/governance namespace`
      ).toBe(false);
    }
  });

  // ── Property 3b: the observations door never creates a proposal ────────────
  it("observations.ts never creates a proposal (the row governance readers key on)", () => {
    for (const door of [
      "insertPendingProposal",
      "createPendingProposal",
      "createProposal",
      ".insert(proposals",
    ]) {
      expect(
        OBSERVATIONS.includes(door),
        `observations.ts must not reference ${door} — an observation reports a fact, it never files a proposal`
      ).toBe(false);
    }
  });
});
