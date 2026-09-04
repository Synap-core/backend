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
import { readFileSync } from "node:fs";
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
