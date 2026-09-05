/**
 * `synap_list_proposals` omitted proposals authored by the caller's OWN agents.
 *
 * Measured live before the fix: 4 of 6 pending rows returned. The 2 hidden rows
 * were authored by an agent-user whose `users.createdByUserId` IS the calling
 * human — but they carry the AGENT's id in `proposals.createdBy` (the column is
 * overloaded: "userId or agentUserId that authored this proposal"), so a bare
 * `eq(proposals.createdBy, caller)` dropped them.
 *
 * The floor is now "me OR an agent I created", in THREE branches: `createdBy`
 * = me, `agentUserId` IN my lineage, and `createdBy` IN my lineage. The third
 * is not needed by any row on the pod today — it exists because the column's
 * documented contract permits an agent id in `createdBy` with `agentUserId`
 * NULL. What must stay true, and is asserted here:
 *
 *  1. the author floor carries ALL THREE branches;
 *  2. EVERY lineage branch resolves through the same subquery, floored on
 *     `users.created_by_user_id = caller` AND `users.user_type = 'agent'` — it
 *     can never admit ANOTHER human's agents, and it carries no
 *     workspace-membership term (that lens would show a teammate's unreviewed
 *     queue — `utils/pending-capture-dedup.ts`);
 *  3. the session-pack branch is unchanged (floors on `focusSessions.userId`);
 *  4. orient's `pendingReview` aggregate floors over the SAME population, so
 *     `count` and `oldestDays` are never computed over different sets.
 *
 * What is deliberately NOT asserted: any live pending COUNT, and any agreement
 * between this queue, orient, and `synap_diagnose type:"proposal"`. Diagnose is
 * workspace-floored (`services/diagnose/global.ts`); after this fix all three
 * happen to read the same number on a single-user pod, through two different
 * predicates. Pinning that coincidence would be a green-on-a-coincidence test
 * that goes red — correctly — the day a second human joins. Shape only.
 *
 * Why predicate-level: there is no local Postgres in this environment. Compiling
 * the WHERE is the technique the access/tripwire suites already use
 * (`access/two-user-floor.test.ts`) and it proves the floor structurally — the
 * bound owner id IS the caller's own, never the other user's. The wiring half
 * (which code path composes it) is asserted against the source.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { eq, or, type SQL } from "drizzle-orm";
import { proposals } from "@synap/database/schema";
import { ownAgentUserFilter } from "../agent-identity-service.js";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql);

const here = dirname(fileURLToPath(import.meta.url));
const servicePath = join(here, "proposals-service.ts");
const discoverPath = join(here, "../discover/discover.ts");

// Two distinct humans on the same pod.
const ME = "user-me";
const TEAMMATE = "user-teammate";

/** The floor exactly as `listCreatedProposals` composes it. */
const authorFloor = (userId: string) =>
  or(
    eq(proposals.createdBy, userId),
    ownAgentUserFilter(proposals.agentUserId, userId),
    ownAgentUserFilter(proposals.createdBy, userId)
  )!;

describe("proposal author floor = me OR an agent I created", () => {
  it("admits rows by createdBy, by agentUserId lineage, AND by createdBy lineage", () => {
    const { sql } = compile(authorFloor(ME));
    expect(sql).toContain('"created_by"');
    expect(sql).toContain('"agent_user_id"');
    // Each lineage branch is a semi-join over users, not an N+1 per-row gate.
    expect(sql).toMatch(/agent_user_id"?\s+in\s+\(select/i);
    expect(sql).toMatch(/created_by"?\s+in\s+\(select/i);
    // Exactly two lineage subqueries — agentUserId AND the createdBy overload.
    expect(sql.match(/in\s+\(select/gi)).toHaveLength(2);
  });

  it("floors EVERY lineage subquery on created_by_user_id = caller and user_type = agent", () => {
    const { sql, params } = compile(authorFloor(ME));
    // Both lineage subqueries carry both halves of the floor — the third branch
    // widens the COLUMN it reads, never the SET it reads from.
    expect(sql.match(/"created_by_user_id"/g)).toHaveLength(2);
    expect(sql.match(/"user_type"/g)).toHaveLength(2);
    expect(params.filter((p) => p === "agent")).toHaveLength(2);
    // The ONLY user id bound anywhere in the predicate is the caller's.
    expect(params).toContain(ME);
    expect(params).not.toContain(TEAMMATE);
  });

  it("binds a different caller's id and nothing of mine (symmetry)", () => {
    const { params } = compile(authorFloor(TEAMMATE));
    expect(params).toContain(TEAMMATE);
    expect(params).not.toContain(ME);
  });

  it("carries no workspace term (this queue is the lineage lens, not the workspace lens)", () => {
    const { sql } = compile(authorFloor(ME));
    expect(sql).not.toContain("workspace_members");
    expect(sql).not.toContain("workspace_id");
  });

  it("has ONE definition of the lineage set (ownAgentUserFilter)", () => {
    const src = readFileSync(servicePath, "utf8");
    expect(src).toMatch(/ownAgentUserFilter\(proposals\.agentUserId/);
    // No re-derived copy of the users subquery in this file — the CALL, not a
    // prose mention of the column in a comment.
    expect(src).not.toMatch(/eq\(users\.createdByUserId/);
    expect(src).not.toMatch(/\.from\(users\)/);
  });
});

describe("listCreatedProposals wiring", () => {
  const src = readFileSync(servicePath, "utf8");

  it("composes all three branches on the non-session path", () => {
    expect(src).toMatch(/const authorFloor = or\(/);
    expect(src).toMatch(/eq\(proposals\.createdBy, params\.createdBy\)/);
    expect(src).toMatch(
      /ownAgentUserFilter\(proposals\.agentUserId, params\.createdBy\)/
    );
    expect(src).toMatch(
      /ownAgentUserFilter\(proposals\.createdBy, params\.createdBy\)/
    );
    expect(src).toMatch(/const conditions = \[authorFloor\]/);
  });

  it("leaves the session-pack branch floored on session OWNERSHIP", () => {
    const sessionIdx = src.indexOf("if (params.sessionId)");
    // Boundary is the author-floor COMMENT block, not the statement — the
    // comment names the helper, and the point is that the session branch's CODE
    // never touches it.
    const floorIdx = src.indexOf("// AUTHOR FLOOR");
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(floorIdx).toBeGreaterThan(sessionIdx);
    const sessionBranch = src.slice(sessionIdx, floorIdx);
    expect(sessionBranch).toMatch(
      /eq\(focusSessions\.userId, params\.createdBy\)/
    );
    expect(sessionBranch).toMatch(
      /eq\(proposals\.sessionId, params\.sessionId\)/
    );
    // The lineage branch must NOT have leaked into the session pack.
    expect(sessionBranch).not.toMatch(/ownAgentUserFilter/);
  });
});

describe("orient pendingReview aggregate matches the list population", () => {
  it("counts over the same author floor (count and oldestDays agree)", () => {
    const src = readFileSync(discoverPath, "utf8");
    expect(src).toMatch(/ownAgentUserFilter\(proposals\.agentUserId, userId\)/);
    expect(src).toMatch(/ownAgentUserFilter\(proposals\.createdBy, userId\)/);
    // Both aggregates come from the SAME `.where(...)`, so widening one without
    // the other is structurally impossible here.
    expect(src).toMatch(/min\(\$\{proposals\.createdAt\}\)/);
  });
});

describe("the in-flight dedup scan shares the SAME author floor", () => {
  /*
   * `findPendingSignalMatches` flags a duplicate an agent is ABOUT to file.
   * It floored on `createdBy = <human>` while `createdBy` is overloaded, so an
   * agent could not see ITS OWN in-flight duplicate — blind to the majority
   * row shape (measured: 4 of 6 pending) and to the team pod's 32 duplicate
   * clusters. Widened to the same lineage predicate as the queue.
   *
   * The file's stated guarantee — "never another user's queue" — is the thing
   * these assertions defend. It is preserved by CONSTRUCTION, not by comment:
   * `ownAgentUserFilter` floors on `users.createdByUserId = me`.
   */
  const dedupPath = join(here, "../../utils/pending-capture-dedup.ts");

  it("uses the shared lineage helper, not a re-derived subquery", () => {
    const src = readFileSync(dedupPath, "utf8");
    expect(src).toMatch(
      /ownAgentUserFilter\(proposals\.agentUserId, params\.userId\)/
    );
    expect(src).toMatch(
      /ownAgentUserFilter\(proposals\.createdBy, params\.userId\)/
    );
    // No re-derived copy of the users subquery: ONE definition of the set.
    expect(src).not.toMatch(/eq\(users\.createdByUserId/);
    expect(src).not.toMatch(/\.from\(users\)/);
  });

  it("carries NO workspace term — a workspace floor is what it rules out", () => {
    const src = readFileSync(dedupPath, "utf8");
    // This is the boundary the file's own comment defends, and the trap that
    // was caught three separate times in one session. A membership term here
    // would leak a teammate's unreviewed queue through a dedup hint.
    expect(src).not.toMatch(/workspaceMembers/);
    expect(src).not.toMatch(/userVisibleWhere/);
    expect(src).not.toMatch(/eq\(proposals\.workspaceId/);
  });

  it("still floors STRICTLY on pending — an approved row is already committed", () => {
    const src = readFileSync(dedupPath, "utf8");
    expect(src).toMatch(/eq\(proposals\.status, ProposalStatus\.PENDING\)/);
  });
});

describe("EVERY author floor in the dedup/recall file uses the shared helper", () => {
  /*
   * THREE functions in `utils/pending-capture-dedup.ts` floor on proposal
   * authorship, and I fixed exactly ONE of them — the classic "fixed the list,
   * not the class". The one left broken was the RECALL lane
   * (`findPendingTextMatches`), which made it the amnesia the product exists to
   * prevent: an agent asking about work it had just proposed got "No
   * information found" while that row sat pending in the same queue. Verified
   * live against the pod.
   *
   * The third (`findPriorCaptureGraphProposal`) is named BY NAME in
   * `routers/capture.ts`'s attribution post-mortem as a consumer this column's
   * overload would break — so it was a documented, predicted miss.
   *
   * Assert the DENOMINATOR, not a list: count the narrow floors and require
   * zero. A test that named the three functions would go green the moment a
   * fourth appeared.
   */
  const dedupPath = join(here, "../../utils/pending-capture-dedup.ts");

  it("scans a real file with several author floors", () => {
    const src = readFileSync(dedupPath, "utf8");
    expect(src.length).toBeGreaterThan(2000);
    // 3 sites x 3 branches today; the point is that it is plural, not the 9.
    expect((src.match(/ownAgentUserFilter\(/g) ?? []).length).toBeGreaterThan(
      5
    );
  });

  it("has ZERO bare `createdBy = caller` author floors left", () => {
    const src = readFileSync(dedupPath, "utf8")
      // strip comments so prose about the OLD floor never reads as code
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/gm, (_m, p1) => p1);

    // A bare floor is one NOT immediately preceded by `or(` — inside an `or`
    // it is the first branch of the lineage predicate, which is correct.
    const bare = [
      ...src.matchAll(
        /([\s\S]{0,40})eq\(proposals\.createdBy, params\.userId\)/g
      ),
    ].filter((m) => !/or\(\s*$/.test(m[1])).length;

    expect(
      bare,
      "A bare `eq(proposals.createdBy, params.userId)` author floor remains. " +
        "`createdBy` is overloaded (userId OR agentUserId), so it cannot see " +
        "an agent's own rows — which is the amnesia bug. Use the lineage " +
        "predicate: or(createdBy = me, ownAgentUserFilter(agentUserId), " +
        "ownAgentUserFilter(createdBy))."
    ).toBe(0);
  });
});

describe("recall and dedup lanes have DIFFERENT type floors, on purpose", () => {
  /*
   * `findPendingSignalMatches` (dedup) KEEPS `CAPTURE_GRAPH_PROPOSAL_TYPES`: it
   * compares create-ops to avoid filing a duplicate, so it must only consider
   * rows whose `operations[]` it can read.
   *
   * `findPendingTextMatches` (recall) has NO type floor: it answers "is there
   * pending work bearing on this question?". Measured live, the graph-only
   * floor admitted 7 of 16 pending rows, so an agent asking about a workspace
   * with a pending `join` was told nothing was pending.
   *
   * A future reader will be tempted to unify them — they sit in one file and
   * look like near-duplicates. They are not. This pins the asymmetry and says
   * why, so unifying has to be a decision rather than a tidy-up.
   */
  const dedupPath = join(here, "../../utils/pending-capture-dedup.ts");
  const src = readFileSync(dedupPath, "utf8");
  const slice = (from: string, to: string): string =>
    src.slice(src.indexOf(from), src.indexOf(to));

  it("reads two real, distinct function bodies", () => {
    const dedupFn = slice(
      "export async function findPendingSignalMatches",
      "export function extractQueryTerms"
    );
    const recallFn = slice(
      "export async function findPendingTextMatches",
      "export function computeCaptureGraphIdempotencyKey"
    );
    expect(dedupFn.length).toBeGreaterThan(200);
    expect(recallFn.length).toBeGreaterThan(200);
  });

  it("DEDUP keeps the capture-graph type floor", () => {
    const dedupFn = slice(
      "export async function findPendingSignalMatches",
      "export function extractQueryTerms"
    );
    expect(
      dedupFn,
      "the dedup lane must keep CAPTURE_GRAPH_PROPOSAL_TYPES — it reads " +
        "operations[] to compare create-ops, and cannot do that for a row shape " +
        "it does not understand."
    ).toContain("CAPTURE_GRAPH_PROPOSAL_TYPES");
  });

  it("RECALL has no type floor", () => {
    const recallFn = slice(
      "export async function findPendingTextMatches",
      "export function computeCaptureGraphIdempotencyKey"
    );
    // Strip comments: the WHY is written in prose right there and names the const.
    const code = recallFn
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/gm, (_m, p1) => p1);
    expect(
      code,
      "the recall lane must NOT filter by proposal type — every proposal " +
        "carries a summary and the scorer already falls back to it, so a type " +
        "floor here only hides pending work from the agent that asked about it."
    ).not.toContain("CAPTURE_GRAPH_PROPOSAL_TYPES");
  });
});

/**
 * A surface that ADVERTISES outside-lens rows must be able to RESOLVE them.
 *
 * ── THE LIVE CONTRADICTION ─────────────────────────────────────────────────
 * Found by dogfooding the deployed pod, not by any test. Whole-pod health says,
 * verbatim:
 *
 *   "4 more of yours sit outside your workspace lens (unresolvable placement)
 *    — list proposals to see them"
 *
 * …because `diagnose/global.ts` counts them on the OWNERSHIP floor
 * (`authoredByUser`, no membership term). The user then lists them, picks one,
 * and asks `diagnose({ id })` — which probed proposals on the bare WORKSPACE
 * lens and answered "No diagnosable object found for id …". The product told
 * the user those rows exist and then denied they existed.
 *
 * ── WHY THIS TEST IS NARROW ON PURPOSE ─────────────────────────────────────
 * There are ~29 `userVisibleWhere(proposals.workspaceId, …)` call sites across
 * ~17 files, and MOST ARE CORRECT: `userVisibleWhere` is the right floor for a
 * LENS question ("what is in my workspaces"). It is wrong only for an
 * OWNERSHIP question ("what is mine"). A blanket "every proposal query needs an
 * author branch" rule would be a standing invitation to widen access floors —
 * the opposite of safe.
 *
 * So this pins the one invariant that is unambiguously true: the ADVERTISER
 * (global.ts) and the RESOLVER (resolve-object-kind.ts) must agree. It is
 * derived from the advertisement's own existence — delete `mineOutsideLens` and
 * the obligation lifts by itself.
 */
describe("advertising outside-lens rows obliges resolving them", () => {
  const globalPath = join(here, "../diagnose/global.ts");
  const resolverPath = join(here, "../diagnose/resolve-object-kind.ts");

  const strip = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/gm, (_m, p1) => p1);

  it("both files exist", () => {
    expect(existsSync(globalPath), globalPath).toBe(true);
    expect(existsSync(resolverPath), resolverPath).toBe(true);
  });

  it("global health still ADVERTISES outside-lens rows (the premise)", () => {
    // NON-VACUITY: if the advertisement is ever removed, this whole obligation
    // is moot — and this test must say so loudly rather than pass on absence.
    const src = strip(readFileSync(globalPath, "utf8"));
    expect(
      src,
      "`mineOutsideLens` is gone from whole-pod health. If that was deliberate, " +
        "delete this describe block too — it exists only to keep the resolver " +
        "honest about rows the summary promises."
    ).toContain("mineOutsideLens");
  });

  /*
   * BOTH HALVES. `diagnose({id})` runs two queries: `resolve-object-kind.ts`
   * FINDS the row, then `index.ts` diagnoseObject LOADS it. Fixing only the
   * resolver changed the error from "No diagnosable object found for id …" to
   * "Proposal not found" — still broken, and this test passed on that half-fix
   * because it scanned one file. Scanning the path, not a file, is the point.
   *
   * `diagnoseClass` (also in index.ts) is deliberately NOT a counter-example:
   * it lists on the lens and separately COUNTS ownership as `mineOutsideLens`,
   * disclosing the gap instead of hiding it. That is why the assertion is
   * "ownership appears at least as often as the lens" per file rather than
   * "every lens hit is paired" — a file may legitimately do both.
   */
  const idPath: Array<[string, string]> = [
    ["resolve-object-kind.ts", resolverPath],
    ["diagnose/index.ts", join(here, "../diagnose/index.ts")],
  ];

  it.each(idPath)(
    "%s reaches a proposal the caller AUTHORED outside their lens",
    (_label, path) => {
      expect(existsSync(path), path).toBe(true);
      const src = strip(readFileSync(path, "utf8"));

      const lensHits = (
        src.match(/userVisibleWhere\(\s*proposals\.workspaceId/g) ?? []
      ).length;
      const ownershipHits = (src.match(/authoredByUser\(/g) ?? []).length;

      expect(
        lensHits,
        "this file no longer queries proposals by workspace lens at all — " +
          "the matcher is stale, not satisfied."
      ).toBeGreaterThan(0);

      expect(
        ownershipHits,
        `floors on the workspace lens at ${lensHits} site(s) but reaches the ` +
          `ownership floor at ${ownershipHits}. Whole-pod health advertises ` +
          "rows OUTSIDE that lens, so a bare-lens query on the diagnose id " +
          "path denies rows the same tool just told the user to go read."
      ).toBeGreaterThanOrEqual(lensHits);
    }
  );
});
