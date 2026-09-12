import { describe, it, expect } from "vitest";
import { toSafeToolError } from "../tool-errors.js";

/**
 * A DETERMINISTIC database rejection must not be advertised as retryable.
 *
 * MEASURED (2026-09-12, live pod): every structured `synap_capture` create died
 * with `insert or update on table "entities" violates foreign key constraint
 * "entities_source_proposal_id_fkey"`. `toSafeToolError` classified it as a
 * generic storage fault and told the model "This is a pod-side fault … Retry
 * once." A 23xxx integrity violation will fail IDENTICALLY on every retry, so
 * that advice burns a call and makes a permanent defect read as flakiness.
 *
 * These cases pin the classification and the DISCLOSURE boundary: the constraint
 * NAME is actionable schema vocabulary and is allowed out; the query, the bound
 * parameters and postgres's `detail` (which quotes the offending row values)
 * never are.
 */

/** The shape postgres.js throws — SQLSTATE in `code`, name in `constraint_name`. */
function pgError(fields: Record<string, unknown>) {
  return Object.assign(
    new Error(
      'insert or update on table "entities" violates foreign key constraint "entities_source_proposal_id_fkey"'
    ),
    { name: "PostgresError", severity: "ERROR", ...fields }
  );
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("");

describe("toSafeToolError — integrity violations are not retryable", () => {
  it("classifies a foreign-key violation as deterministic and names the constraint", () => {
    const result = toSafeToolError(
      pgError({
        code: "23503",
        constraint_name: "entities_source_proposal_id_fkey",
        table_name: "entities",
        detail:
          'Key (source_proposal_id)=(abc-123) is not present in table "proposals".',
      }),
      "synap_capture"
    );

    expect(result.isError).toBe(true);
    const text = textOf(result as never);
    expect(text).toContain("data-integrity rule");
    expect(text).toContain("entities_source_proposal_id_fkey");
    expect(text).toMatch(/do not retry/i);
    // The WRONG advice must be gone — this is the whole point of the branch.
    expect(text).not.toMatch(/Retry once/);
  });

  it("discloses the constraint name and NOTHING else from the driver error", () => {
    const text = textOf(
      toSafeToolError(
        pgError({
          code: "23503",
          constraint_name: "entities_source_proposal_id_fkey",
          detail:
            'Key (source_proposal_id)=(abc-123) is not present in table "proposals".',
          query:
            'insert into "entities" ("id","source_proposal_id") values ($1,$2)',
          parameters: ["e-1", "abc-123"],
        }),
        "synap_capture"
      ) as never
    );
    expect(text).not.toContain("insert into");
    expect(text).not.toContain("abc-123");
    expect(text).not.toContain("Key (source_proposal_id)");
    expect(text).not.toContain("$1");
  });

  it("covers the rest of class 23, not just foreign keys", () => {
    for (const [code, constraint] of [
      ["23505", "entities_slug_unique"],
      ["23502", "entities_title_not_null"],
      ["23514", "entities_kind_check"],
      ["23P01", "sessions_no_overlap"],
    ] as const) {
      const text = textOf(
        toSafeToolError(
          pgError({ code, constraint_name: constraint }),
          "synap_create_entity"
        ) as never
      );
      expect(text, `SQLSTATE ${code}`).toContain("data-integrity rule");
      expect(text, `SQLSTATE ${code}`).toContain(constraint);
    }
  });

  it("finds an integrity error wrapped one level deep in `cause` (drizzle)", () => {
    const wrapped = Object.assign(new Error("Failed query: insert into ..."), {
      query: 'insert into "entities" ...',
      cause: pgError({
        code: "23503",
        constraint_name: "entities_source_proposal_id_fkey",
      }),
    });
    const text = textOf(toSafeToolError(wrapped, "synap_capture") as never);
    expect(text).toContain("entities_source_proposal_id_fkey");
    expect(text).not.toMatch(/Retry once/);
    expect(text).not.toContain("insert into");
  });

  it("still names the class when the driver gives no constraint name", () => {
    const text = textOf(
      toSafeToolError(pgError({ code: "23503" }), "synap_capture") as never
    );
    expect(text).toContain("data-integrity rule");
    expect(text).toMatch(/do not retry/i);
    // No empty parenthetical where the name would have been, and no dangling
    // "report the constraint name above" pointing at a name that is not there.
    expect(text).not.toContain("database ()");
    expect(text).not.toContain("constraint name above");
  });

  it("refuses a constraint 'name' that is not an identifier", () => {
    const text = textOf(
      toSafeToolError(
        pgError({
          code: "23503",
          constraint_name: "oops; DROP TABLE entities -- secret@example.com",
        }),
        "synap_capture"
      ) as never
    );
    expect(text).toContain("data-integrity rule");
    expect(text).not.toContain("DROP TABLE");
  });

  it("leaves a NON-integrity driver error on the retryable storage branch", () => {
    // The negative half: a connection fault IS transient, and must keep its
    // "Retry once" advice. A branch that swallowed everything would pass every
    // assertion above while making real flakiness unrecoverable.
    const text = textOf(
      toSafeToolError(
        Object.assign(new Error("connect ECONNREFUSED"), {
          name: "PostgresError",
          code: "08006",
          severity: "ERROR",
        }),
        "synap_capture"
      ) as never
    );
    expect(text).toContain("storage layer");
    expect(text).toContain("Retry once");
    expect(text).not.toContain("data-integrity rule");
  });
});
