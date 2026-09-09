/**
 * `POST /setup/agent` — resolving `linkedUserId` from an email or name.
 *
 * WHY THIS EXISTS. On a pod with more than one human the door refuses to guess
 * which human an agent acts for — correctly, since binding to the wrong one
 * mis-attributes every write that agent later makes. But it accepted ONLY a
 * uuid, which is the single identifier an operator does not have to hand; the
 * practical effect was that `eve auth renew` could not be completed at all
 * without a psql query. It now takes an email or a name.
 *
 * THE RULE THESE PIN: resolve only on an UNAMBIGUOUS match, and refuse
 * otherwise. "Zero matches" and "several matches" are both refusals, because
 * the failure mode of a best guess here is silent and permanent — the agent
 * binds to a human nobody chose and every later write is attributed to them.
 *
 * These test the matcher in isolation, mirroring the handler's rule. That is a
 * convergence guard and it is stated as such: it proves the RULE is right, not
 * that the handler calls it. The handler's own path needs a live pod (its auth
 * reaches the database before this branch), so the wiring is covered by the
 * `eve auth renew --linked-user` round trip, not here.
 */

import { describe, expect, it } from "vitest";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Human {
  id: string;
  email: string;
  name: string | null;
}

/** The handler's rule, in one place, so the cases below are readable. */
function resolveLinkedUser(
  raw: string,
  humans: Human[]
): { ok: true; id: string } | { ok: false; reason: "none" | "ambiguous" } {
  const value = raw.trim();
  if (UUID_RE.test(value)) return { ok: true, id: value };

  const needle = value.toLowerCase();
  const byEmail = humans.filter((u) => u.email.toLowerCase() === needle);
  const byName = humans.filter((u) => (u.name ?? "").toLowerCase() === needle);
  // Email first: it is unique in the schema, a name is not.
  const hits = byEmail.length > 0 ? byEmail : byName;

  if (hits.length === 0) return { ok: false, reason: "none" };
  if (hits.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, id: hits[0]!.id };
}

const ANTOINE: Human = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "antoine@example.test",
  name: "Antoine",
};
const OTHER: Human = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "someone@example.test",
  name: "Antoine", // deliberately the SAME name — see the ambiguity case
};

describe("resolveLinkedUser", () => {
  it("passes a uuid straight through", () => {
    expect(resolveLinkedUser(ANTOINE.id, [ANTOINE, OTHER])).toEqual({
      ok: true,
      id: ANTOINE.id,
    });
  });

  it("resolves an email", () => {
    expect(resolveLinkedUser(ANTOINE.email, [ANTOINE, OTHER])).toEqual({
      ok: true,
      id: ANTOINE.id,
    });
  });

  it("resolves an email case-insensitively", () => {
    // Operators type addresses however their mail client displays them.
    expect(resolveLinkedUser("ANTOINE@Example.TEST", [ANTOINE, OTHER])).toEqual(
      {
        ok: true,
        id: ANTOINE.id,
      }
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveLinkedUser("  antoine@example.test  ", [ANTOINE])).toEqual({
      ok: true,
      id: ANTOINE.id,
    });
  });

  it("resolves a name when it is unique", () => {
    const solo = { ...OTHER, name: "Someone Else" };
    expect(resolveLinkedUser("Someone Else", [ANTOINE, solo])).toEqual({
      ok: true,
      id: solo.id,
    });
  });

  it("REFUSES an ambiguous name rather than picking one", () => {
    // The discriminating case. Both humans are named "Antoine"; a rule that
    // took the first match would bind the agent to whichever row sorted first
    // and mis-attribute every write it made afterwards — silently, forever.
    expect(resolveLinkedUser("Antoine", [ANTOINE, OTHER])).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("prefers an EMAIL match over a name match", () => {
    // email is unique in the schema; name is not. A value that is somehow both
    // must resolve by the unique one.
    const weird: Human = {
      id: "33333333-3333-4333-8333-333333333333",
      email: "x@example.test",
      name: "antoine@example.test",
    };
    expect(resolveLinkedUser("antoine@example.test", [ANTOINE, weird])).toEqual(
      {
        ok: true,
        id: ANTOINE.id,
      }
    );
  });

  it("refuses an unknown value", () => {
    expect(resolveLinkedUser("nobody@example.test", [ANTOINE])).toEqual({
      ok: false,
      reason: "none",
    });
  });

  it("does not treat a malformed uuid as a uuid", () => {
    // Would otherwise be passed through unresolved and fail later, deep in the
    // mint, as a foreign-key error rather than a clear "no such human".
    expect(resolveLinkedUser("11111111-1111-4111-8111", [ANTOINE])).toEqual({
      ok: false,
      reason: "none",
    });
  });
});
