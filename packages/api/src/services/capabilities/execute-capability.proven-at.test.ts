import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `skills.proven_at` — the proof-it-ran stamp.
 *
 * WHAT THIS ASSERTS, AND WHY THAT SHAPE. The defect this column exists to
 * prevent is a capability that reads as "fixed" without ever having done the
 * work. The mirror-image defect — a column declared on the wire and written by
 * nobody — is the single most repeated failure in this codebase, and a test
 * that only checked "the writer function exists" would pass on it. So these
 * tests drive the REAL `runResolvedSkill` through its real kind-branch and
 * assert that the UPDATE is ISSUED, against the right table, carrying a real
 * Date, under the `proven_at IS NULL` first-write floor — and that the three
 * outcomes which did NOT do the work issue nothing.
 *
 * WHAT IT DOES NOT COVER: `db` is a recorder, so this proves the statement is
 * issued and what it contains, not that Postgres applies it. The column's
 * existence on a live pod is the job of migration 0254 + its `schema-coherence`
 * entry, not of this file.
 */

const updates: Array<{ table: unknown; values: unknown; where: unknown }> = [];

vi.mock("./execute-provider-verb.js", () => ({
  executeProviderVerb: vi.fn(async () => ({ ran: "provider" })),
}));
vi.mock("../skills/execute-skill-via-is.js", () => ({
  executeSkillViaIS: vi.fn(async () => ({
    success: true,
    result: { ran: "is" },
  })),
}));
vi.mock("@synap/database", async (importActual) => {
  const actual = await importActual<typeof import("@synap/database")>();
  return {
    ...actual,
    getWorkspaceMembership: vi.fn(),
    db: {
      update: (table: unknown) => ({
        set: (values: unknown) => ({
          where: async (where: unknown) => {
            updates.push({ table, values, where });
          },
        }),
      }),
    },
  };
});

import { PgDialect } from "drizzle-orm/pg-core";
import {
  runResolvedSkill,
  type ResolvedSkillRow,
} from "./execute-capability.js";
import { BUILTIN_VERBS } from "./builtin-verbs.js";
import { executeProviderVerb } from "./execute-provider-verb.js";
import { skills } from "@synap/database";

const ctx = { userId: "u1", workspaceId: null };

function row(overrides: Partial<ResolvedSkillRow>): ResolvedSkillRow {
  return {
    id: "s1",
    name: "verb",
    kind: "code",
    providerSpec: null,
    ...overrides,
  };
}

describe("skills.proven_at — stamped on the FIRST genuine success", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updates.length = 0;
    for (const k of Object.keys(BUILTIN_VERBS)) delete BUILTIN_VERBS[k];
  });

  it("REACHABILITY: a successful run issues the stamp, against `skills`, with a real Date, floored on proven_at IS NULL", async () => {
    BUILTIN_VERBS["entity.create"] = vi.fn(async () => ({ id: "e1" }));
    const before = Date.now();

    const out = await runResolvedSkill(
      row({ kind: "builtin", name: "entity.create" }),
      {},
      ctx
    );

    expect(out.kind).toBe("run");
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(skills);

    // The VALUE arrives — not merely the key.
    const values = updates[0].values as { provenAt?: unknown };
    expect(values.provenAt).toBeInstanceOf(Date);
    expect((values.provenAt as Date).getTime()).toBeGreaterThanOrEqual(before);

    // The FIRST-WRITE FLOOR is in the statement itself (not a read-then-write),
    // so a second success cannot move the timestamp and two concurrent runs
    // cannot race. Rendered to SQL because that is the only honest way to see
    // a drizzle condition without a live database.
    const sql = new PgDialect().sqlToQuery(updates[0].where as never).sql;
    expect(sql).toContain("proven_at");
    expect(sql.toLowerCase()).toContain("is null");
    expect(sql).toContain("id");
  });

  it("a run that was only PROPOSED does NOT stamp — the effect is queued for a human, not performed", async () => {
    vi.mocked(executeProviderVerb).mockResolvedValueOnce({
      proposed: true,
      proposalId: "p1",
    } as never);

    const out = await runResolvedSkill(
      row({
        kind: "declarative",
        name: "gmail.send",
        providerSpec: { transport: "http", method: "POST" } as never,
      }),
      {},
      ctx
    );

    // It really does flow through as a SUCCESS outcome — which is exactly why
    // the exclusion has to be explicit rather than implied by `kind`.
    expect(out.kind).toBe("run");
    expect(updates).toHaveLength(0);
  });

  it("a FAILED run does not stamp", async () => {
    vi.mocked(executeProviderVerb).mockResolvedValueOnce({
      success: false,
      error: "boom",
    } as never);

    const out = await runResolvedSkill(
      row({
        kind: "declarative",
        name: "gmail.send",
        providerSpec: { transport: "http", method: "POST" } as never,
      }),
      {},
      ctx
    );

    expect(out.kind).toBe("error");
    expect(updates).toHaveLength(0);
  });

  it("a verb with no handler (not_found) does not stamp", async () => {
    const out = await runResolvedSkill(
      row({ kind: "builtin", name: "no.such.verb" }),
      {},
      ctx
    );
    expect(out.kind).toBe("not_found");
    expect(updates).toHaveLength(0);
  });

  it("a stamp failure NEVER breaks the already-delivered run", async () => {
    // The run has already happened by the time the stamp is attempted; a
    // telemetry write must not turn a delivered run into a thrown error.
    BUILTIN_VERBS["entity.create"] = vi.fn(async () => ({ id: "e1" }));
    const { db } = await import("@synap/database");
    const spy = vi
      .spyOn(db as unknown as { update: () => unknown }, "update")
      .mockImplementation(() => {
        throw new Error('column "proven_at" does not exist');
      });

    const out = await runResolvedSkill(
      row({ kind: "builtin", name: "entity.create" }),
      {},
      ctx
    );

    expect(out).toEqual({ kind: "run", skillId: "s1", result: { id: "e1" } });
    spy.mockRestore();
  });
});
