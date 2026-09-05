/**
 * The review queue's DEFAULT population is LENS ∪ OWNERSHIP — on EVERY door.
 *
 * ── THE MEASURED SPLIT ─────────────────────────────────────────────────────
 * `orient`/`diagnose` reported 16-17 pending while `proposals.list` and
 * `synap proposals` reported 12, with no explanation, across three external
 * test passes. Cause: `proposals.workspace_id` is `text` with NO foreign key,
 * so orphaned/unjoinable workspace ids are real (4 such rows live). The
 * diagnose family already floored on `or(userVisibleWhere, authoredByUser)`;
 * the review-queue doors floored on the bare workspace lens, which silently
 * DROPS a caller's own rows whose workspace they cannot join.
 *
 * ── WHY UNION AND NOT OWNERSHIP ────────────────────────────────────────────
 * `canReviewProposal` (../review-authority.ts) clears an `admin`/`owner`
 * workspace member regardless of authorship, so a workspace admin is EXPECTED
 * to review a teammate's proposal. Replacing the lens with ownership would
 * delete that queue — a review-coverage regression. The union keeps every row
 * the lens showed and ADDS the caller's own.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 * `authoredByUser` carries no membership term (see the tests below), so the
 * union can never admit another human's rows. It widens what you SEE, never
 * what you may DO — `assertProposalVisibleTo` and `canReviewProposal` are
 * untouched.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const API_SRC = join(process.cwd(), "src");
const read = (rel: string): string => readFileSync(join(API_SRC, rel), "utf8");

/** Blank out comments so a doc-comment can never satisfy a code assertion. */
const strip = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (_m, p1: string) => p1);

describe("proposalUserFloor is the ONE union floor", () => {
  const src = strip(read("routers/proposals/scope-conditions.ts"));

  it("is defined exactly once, as lens OR ownership", () => {
    expect(
      (src.match(/export function proposalUserFloor\(/g) ?? []).length
    ).toBe(1);
    const body = src.slice(
      src.indexOf("export function proposalUserFloor("),
      src.indexOf("export interface ProposalScopeInput") === -1
        ? undefined
        : src.indexOf("export interface ProposalScopeInput")
    );
    expect(body).toMatch(
      /userVisibleWhere\(\s*proposals\.workspaceId,\s*userId/
    );
    expect(body).toMatch(/authoredByUser\(userId\)/);
    // UNION, not replacement: both terms inside one `or(...)`.
    expect(body).toMatch(/or\(/);
  });

  it("the no-lens branch of the builder USES it (not a bare lens)", () => {
    const builder = src.slice(
      src.indexOf("export function buildProposalScopeConditions("),
      src.indexOf("export async function resolveAutomationStepRunIds")
    );
    expect(builder).toContain("proposalUserFloor(userId)");
    // The bare lens must not survive as the default population.
    expect(builder).not.toMatch(/userVisibleWhere\(\s*proposals\.workspaceId/);
  });
});

describe("every review-queue door floors on the SAME union", () => {
  it("Hub `listProposals` uses proposalUserFloor, not a second copy", () => {
    const src = strip(read("routers/hub-protocol/proposals.ts"));
    expect(src).toContain("proposalUserFloor(ctx.userId as string)");
    // No second definition, and no reverted bare lens.
    expect(src).not.toMatch(/userVisibleWhere\(\s*proposals\.workspaceId/);
    expect(src).not.toContain("function proposalUserFloor");
  });

  it("Hub keeps workspaceId as an AND on top of the floor, never a replacement", () => {
    const src = strip(read("routers/hub-protocol/proposals.ts"));
    const q = src.slice(src.indexOf("proposalUserFloor(ctx.userId"));
    // The floor is pushed first, then the workspace equality is PUSHED (added),
    // never assigned over the floor. This door has no editor+ gate, so a
    // floor-replacing three-state here would let any caller name any workspace.
    expect(q).toMatch(
      /if \(input\.workspaceId\) \{\s*conditions\.push\(eq\(proposals\.workspaceId, input\.workspaceId\)\)/
    );
  });
});

describe("the union does not widen an access floor", () => {
  const src = strip(read("services/agent-identity-service.ts"));

  it("authoredByUser has NO workspace-membership term", () => {
    const body = src.slice(
      src.indexOf("export function authoredByUser("),
      src.indexOf("export async function getAgentFocusWorkspaceId")
    );
    expect(body).not.toContain("userVisibleWhere");
    expect(body).not.toContain("workspaceMembers");
    expect(body).not.toContain("workspaceId");
  });

  it("its agent branches are floored on THIS user's own agent lineage", () => {
    const lineage = src.slice(
      src.indexOf("function ownAgentUserIds("),
      src.indexOf("export function ownAgentUserFilter(")
    );
    expect(lineage).toMatch(/eq\(users\.userType, "agent"\)/);
    expect(lineage).toMatch(/eq\(users\.createdByUserId, userId\)/);
  });

  it("review AUTHORITY is untouched — the union changes reads, not rights", () => {
    const authority = strip(read("routers/proposals/review-authority.ts"));
    expect(authority).not.toContain("proposalUserFloor");
    expect(authority).not.toContain("authoredByUser");
  });
});
