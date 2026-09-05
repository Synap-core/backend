import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TRIPWIRE — a PRE-FILTER must never be stricter than the AUTHORITY GATE it
 * sits in front of.
 *
 * ── THE DEFECT, REPRODUCED LIVE ─────────────────────────────────────────────
 * On the deployed pod, the SAME caller, SAME door, SAME proposal:
 *
 *   synap_reject_proposal("dc46aa36-fd4c-4ba9-ab0c-84852c3b32f2")  → SUCCESS
 *   synap_reject_proposal("dc46aa36")                              → "No proposal matches"
 *
 * The full uuid succeeded because `computeCanReviewApproval`
 * (routers/proposals/review-authority.ts) treats membership and ownership as
 * ALTERNATIVES — `canReviewProposal({ memberRole, isOwner })`. That row's
 * workspace had been deleted, so there was no membership; the caller was the
 * owner, so the gate allowed it.
 *
 * The prefix path went through `resolveProposalId`, which pre-filtered on
 * `userVisibleWhere` — MEMBERSHIP ONLY. Its comment called that
 * "disambiguation, not authorization". That was inverted: a filter that denies
 * rows the real gate would allow IS authorization, just undeclared, stricter,
 * and invisible.
 *
 * ── WHY A TRIPWIRE AND NOT JUST THE FIX ─────────────────────────────────────
 * The floors here are HAND-COPIED between files, which is how they diverged in
 * the first place. Nothing typed can see it: both predicates compile, both are
 * individually correct, and the divergence only shows on rows where membership
 * and ownership disagree — which requires an orphaned `workspaceId`, possible
 * only because `proposals.workspace_id` is `text` with NO foreign key.
 *
 * So this pins the RELATIONSHIP, not the text: wherever a proposal id is
 * resolved before an authority check, the resolver must reach the ownership
 * floor too. It cannot be satisfied by widening past the union — see the
 * oracle note on `resolveProposalId` itself.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, "..");

/** Every door that resolves a proposal id BEFORE an authority check runs. */
const ID_RESOLVERS: Array<{ label: string; path: string }> = [
  {
    label: "Hub REST resolveProposalId (MCP reject/revise + 6 REST routes)",
    path: join(API_SRC, "routers/hub-protocol/rest/_shared.ts"),
  },
  {
    label: "diagnose resolveObjectKind (the polymorphic id prober)",
    path: join(API_SRC, "services/diagnose/resolve-object-kind.ts"),
  },
  {
    label: "diagnose object loader",
    path: join(API_SRC, "services/diagnose/index.ts"),
  },
];

const strip = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (_m, p1) => p1);

describe("tripwire: a proposal pre-filter is never stricter than its gate", () => {
  it("the authority gate still treats ownership as an ALTERNATIVE to membership", () => {
    // NON-VACUITY + the premise. If the gate ever stops honouring ownership,
    // every assertion below is arguing for a widening nobody needs — and that
    // must fail loudly here rather than silently keep widening resolvers.
    const gate = join(API_SRC, "routers/proposals/review-authority.ts");
    expect(existsSync(gate), `missing authority gate: ${gate}`).toBe(true);
    const src = strip(readFileSync(gate, "utf8"));
    expect(
      /isOwner/.test(src),
      "`review-authority.ts` no longer mentions `isOwner`. If ownership was " +
        "removed as a review path, the resolvers below should be narrowed to " +
        "match — not left wide. Re-derive this tripwire against the new gate."
    ).toBe(true);
  });

  it.each(ID_RESOLVERS)(
    "$label pairs the workspace lens with the ownership floor",
    ({ path }) => {
      expect(existsSync(path), `missing resolver: ${path}`).toBe(true);
      const src = strip(readFileSync(path, "utf8"));

      const lensHits = (
        src.match(/userVisibleWhere\(\s*proposals\.workspaceId/g) ?? []
      ).length;
      const ownershipHits = (src.match(/authoredByUser\(/g) ?? []).length;

      expect(
        lensHits,
        "this resolver no longer floors proposals on the workspace lens at " +
          "all — the matcher is stale, not satisfied."
      ).toBeGreaterThan(0);

      expect(
        ownershipHits,
        `floors on the workspace lens at ${lensHits} site(s) but reaches the ` +
          `ownership floor at ${ownershipHits}. A membership-only pre-filter ` +
          "denies rows that `computeCanReviewApproval` would ALLOW on " +
          "ownership grounds (it treats the two as alternatives), so the " +
          "caller can act on a row by full id and be told it does not exist " +
          "when addressing it any other way. Pair each with `authoredByUser`."
      ).toBeGreaterThanOrEqual(lensHits);
    }
  );

  it("resolveProposalId records WHY widening past the union would be an oracle", () => {
    // The predicate is safe only because both halves have a list door behind
    // them. That reasoning is the guard against a future "helpful" third term,
    // and it is worth strictly more than the predicate itself — so it must not
    // be deleted while the widening stays.
    const src = readFileSync(ID_RESOLVERS[0]!.path, "utf8");
    expect(
      /oracle/i.test(src),
      "the oracle rationale is gone from `resolveProposalId`. Restore it: the " +
        "union is safe BECAUSE each half is already listable by this caller. " +
        "A third term without a list door behind it turns this resolver into " +
        "an existence oracle for rows the caller cannot see."
    ).toBe(true);
  });
});
