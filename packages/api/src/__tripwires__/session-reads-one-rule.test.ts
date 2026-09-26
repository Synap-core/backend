/**
 * TRIPWIRE — every focus-session READ uses the ONE session read rule.
 *
 * Decision D1 (2026-09-26): a session's title/goal/status/progress is CONTENT,
 * readable by its owner and — on a human door — a human seat on its own room.
 * That rule is `sessionReadableWhere` (`access/session-visibility.ts`), which
 * the access registry's `focusSessions` VisibilityRule, `sessionListConditions`
 * and `projectPathConditions` all wrap.
 *
 * The defect this pins: seven readers (run ledger, run detail, workflow place,
 * diagnose, resolve, proposal spine, link gate) plus the graph hydration floored
 * `focus_sessions` on the WORKSPACE (`ownerPrivateVisibleWhere` /
 * `userVisibleWhere`) — so every workspace member read every colleague's
 * session titles. A workspace floor applied to a `focusSessions` column is that
 * mistake by construction, so it fails here anywhere outside the access layer.
 *
 * The scanned set is DERIVED (every non-test `.ts` under api/src, jobs/src and
 * database/src), never hand-listed: a new file joins by existing.
 *
 * What this does NOT see, measured by reading the matcher:
 *   - a floor on an ALIASED table (`alias(focusSessions, "fs")`) or on raw SQL
 *     naming `focus_sessions` — neither form exists outside the access layer
 *     today; a new one would pass silently.
 *   - a session read with NO floor at all (`eq(focusSessions.id, x)` only):
 *     that is an absence, which a regex cannot tell from a write door or a
 *     job-internal read. `session-readers-d1.pglite.test.ts` covers the known
 *     readers behaviourally.
 *   - an owner floor (`eq(focusSessions.userId, …)`) — deliberately allowed:
 *     it is narrower than the rule (write doors, agent doors, owner nudges).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const API_SRC = join(__dirname, "..");
const PACKAGES = join(API_SRC, "../..");
const ROOTS = [
  API_SRC,
  join(PACKAGES, "jobs/src"),
  join(PACKAGES, "database/src"),
];

/** The access layer DEFINES the rule — it is the one place a workspace floor
 *  on `focusSessions` belongs (the member branch's workspace floor). */
const ACCESS_LAYER = join(API_SRC, "access") + sep;

/**
 * Justified exemptions: repo-relative path → why. EMPTY today — every session
 * read outside the access layer goes through the rule. Adding one needs a
 * reason a reviewer can check; "the test was red" is not one.
 */
const EXEMPT: Readonly<Record<string, string>> = {};

/**
 * A workspace floor applied to a `focusSessions` column: the helper name, an
 * open paren, then `focusSessions.` or `(t as typeof focusSessions).` —
 * whitespace (incl. newlines) allowed between. Both ends pinned: the helper
 * name as a whole word, and the column access dot.
 */
const WORKSPACE_FLOOR_ON_SESSIONS =
  /\b(ownerPrivateVisibleWhere|userVisibleWhere|workspaceLensWhere)\(\s*(?:\(\s*\w+\s+as\s+typeof\s+focusSessions\s*\)|focusSessions)\s*\./g;

/**
 * A hand-rolled document floor (`ownerPrivateVisibleWhere` on `documents`)
 * bypasses `accessScopeWhere`'s session-document narrowing, so a SESSION's
 * designated document (titled with the session) would read on the workspace
 * rule. Such a file must also apply `sessionDocumentReadableWhere`.
 * Granularity is the FILE, not the call site: a second document floor in a
 * file that already applies the narrowing once stays green.
 */
const HAND_DOCUMENT_FLOOR =
  /\bownerPrivateVisibleWhere\(\s*(?:\(\s*\w+\s+as\s+typeof\s+documents\s*\)|documents)\s*\./;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__")
      continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    )
      out.push(p);
  }
  return out;
}

function offenders(src: string): string[] {
  return [...src.matchAll(WORKSPACE_FLOOR_ON_SESSIONS)].map((m) => m[0]);
}

describe("session reads use the ONE session read rule (decision D1)", () => {
  const files = ROOTS.flatMap((r) => walk(r));

  it("the matcher still sees every shape it hunts (planted samples)", () => {
    expect(
      offenders(
        "ownerPrivateVisibleWhere(\n  focusSessions.workspaceId, focusSessions.userId, u)"
      )
    ).toHaveLength(1);
    expect(
      offenders("userVisibleWhere(focusSessions.workspaceId, userId)")
    ).toHaveLength(1);
    expect(
      offenders(
        "ownerPrivateVisibleWhere(\n (t as typeof focusSessions).workspaceId, x, y)"
      )
    ).toHaveLength(1);
    expect(
      offenders("workspaceLensWhere(focusSessions.workspaceId, userId, lens)")
    ).toHaveLength(1);
    // …and not what it must allow.
    expect(
      offenders(
        "ownerPrivateVisibleWhere(documents.workspaceId, documents.userId, u)"
      )
    ).toHaveLength(0);
    expect(offenders("sessionReadableWhere({ userId, roster })")).toHaveLength(
      0
    );
  });

  it("scans a plausible set (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(500);
    const sessionFiles = files.filter((f) =>
      readFileSync(f, "utf8").includes("focusSessions")
    );
    expect(sessionFiles.length).toBeGreaterThan(50);
    // The access layer itself is visible to the scan, and DOES carry the
    // shape — so the exclusion below is excluding something real.
    const access = files.filter((f) => f.startsWith(ACCESS_LAYER));
    expect(
      access.some((f) => offenders(readFileSync(f, "utf8")).length > 0)
    ).toBe(true);
  });

  it("no workspace floor on focusSessions outside the access layer", () => {
    const found: string[] = [];
    for (const f of files) {
      if (f.startsWith(ACCESS_LAYER)) continue;
      const rel = relative(PACKAGES, f);
      if (EXEMPT[rel]) continue;
      for (const hit of offenders(readFileSync(f, "utf8"))) {
        found.push(`${rel}: ${hit.replace(/\s+/g, " ")}`);
      }
    }
    expect(
      found,
      "A session's title/goal/status is CONTENT (decision D1). Read it through " +
        "`sessionReadableWhere` (access/session-visibility.ts) — pass " +
        "`roster: rosterReadFor(ctx)` on a human tRPC door, nothing on an agent " +
        "door — never through a workspace floor."
    ).toEqual([]);
  });

  it("a hand-rolled documents floor also applies the session-document narrowing", () => {
    // Planted samples: the matcher still sees both shapes.
    expect(
      HAND_DOCUMENT_FLOOR.test(
        "ownerPrivateVisibleWhere(\n documents.workspaceId, x, y)"
      )
    ).toBe(true);
    expect(
      HAND_DOCUMENT_FLOOR.test(
        "ownerPrivateVisibleWhere((t as typeof documents).workspaceId"
      )
    ).toBe(true);
    const hand = files.filter((f) =>
      HAND_DOCUMENT_FLOOR.test(readFileSync(f, "utf8"))
    );
    // Non-vacuity: display, graph, link gate carry one today.
    expect(hand.length).toBeGreaterThanOrEqual(3);
    const missing = hand
      .filter(
        (f) =>
          !readFileSync(f, "utf8").includes("sessionDocumentReadableWhere(")
      )
      .map((f) => relative(PACKAGES, f));
    expect(
      missing,
      "A session's document is session content (decision D1): AND " +
        "`sessionDocumentReadableWhere(documents.id, reader)` onto a hand-rolled " +
        "documents floor, or read through `accessScopeWhere({ documentFollowsEntity })`."
    ).toEqual([]);
  });

  it("every exemption still names a live file", () => {
    for (const rel of Object.keys(EXEMPT)) {
      expect(() => statSync(join(PACKAGES, rel))).not.toThrow();
    }
  });
});
