/**
 * `focus_sessions` VISIBILITY RULE (0241).
 *
 * Until the temporal fold landed, focus sessions were owner-private BY
 * BEHAVIOUR and undeclared: the routers, the MCP handlers and the Hub REST
 * doors each hand-inlined `eq(focusSessions.userId, …)`, and
 * `hydration-floor-owner-private.test.ts` named it as one of the tables whose
 * semantics nobody had stated. Unclassified is not the same as safe.
 *
 * Declaring it matters NOW because sessions became graph NEIGHBOURS: an object
 * a caller can see can point at a session, so the session's own floor is what
 * stops one user's goal text ("Close the Acme renewal") appearing in another
 * user's graph. `scopedDb` also refuses to read an unregistered table at all.
 *
 * The proof compiles the registered predicate with PgDialect — the same
 * technique as `two-user-floor.test.ts` / `floor-leak-fixes.test.ts` — because
 * "a rule exists" is not the assertion; "the rule binds the CALLER and gates the
 * NULL-workspace branch by owner" is.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { focusSessions } from "@synap/database/schema";
// Importing the access barrel runs registry.ts's side effects.
import { isRegistered } from "./index.js";
import { getVisibilityEntry, visibilityPredicate } from "./visibility.js";
import type { AccessContext } from "./context.js";

const dialect = new PgDialect();
const A = "user-A";
const B = "user-B";

const ctx = (userId: string, workspaceLens?: string) =>
  ({ userId, workspaceLens }) as unknown as AccessContext;

describe("focus_sessions visibility rule", () => {
  it("is registered — scopedDb can read it, and it is no longer 'unclassified'", () => {
    expect(isRegistered(focusSessions)).toBe(true);
  });

  it("declares a NULL workspace to mean a PERSONAL session, never pod-wide", () => {
    const { rule } = getVisibilityEntry(focusSessions);
    // `workspace` (not `workspaceOwned`) would admit every NULL-workspace row to
    // EVERYONE — and a session with no workspace is the most personal row there
    // is, not shared substrate.
    expect(rule.kind).toBe("workspaceOwned");
    expect((rule as { nullWorkspaceMeans?: string }).nullWorkspaceMeans).toBe(
      "ownerPrivate"
    );
  });

  it("floors every row on the CALLER's user id and binds no other identity", () => {
    const { rule } = getVisibilityEntry(focusSessions);
    const compiled = dialect.sqlToQuery(visibilityPredicate(rule, ctx(A))!);

    expect(compiled.sql).toMatch(/user_id"?\s*=/);
    // The decisive check: A's predicate can never carry B's id, whatever the
    // lens does. This is what a leak looks like when it happens.
    expect(compiled.params).toContain(A);
    expect(compiled.params).not.toContain(B);
  });

  it("keeps the owner floor when a workspace lens is active", () => {
    const { rule } = getVisibilityEntry(focusSessions);
    const ws = "dddddddd-4444-4444-8444-444444444444";
    const compiled = dialect.sqlToQuery(visibilityPredicate(rule, ctx(A, ws))!);

    // A lens NARROWS; it must never replace the owner gate — otherwise every
    // member of a shared workspace would read every other member's sessions.
    expect(compiled.params).toContain(A);
    expect(compiled.params).toContain(ws);
    expect(compiled.sql).toMatch(/user_id"?\s*=/);
  });
});
