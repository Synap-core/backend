/**
 * `projects.targetDate` (migration 0252) — the wire contract.
 *
 * Migration 0252 added `projects.target_date` and NOTHING read or wrote it: the
 * router neither accepted it on create/update nor had any test pinning it. This
 * file is the guard for the wiring, and it drives the ACTUAL shipped Zod schemas
 * off the router (`_def.inputs[0]`) rather than a hand-rebuilt copy — a copy
 * would keep passing after someone deleted the field from the real one, which is
 * this codebase's signature defect (a guard that passes while no longer looking
 * at what it claims).
 *
 * No DB: these assert the parse contract, which is where every one of the three
 * callers below actually differs.
 *
 * WHY `z.coerce.date()` AND NOT `z.date()` — the load-bearing reason, since a
 * future "tidy-up" to `z.date()` typechecks everywhere and breaks only at
 * runtime, in the one path nobody runs locally:
 *
 *   1. the typed tRPC client sends a real `Date` (superjson transformer);
 *   2. raw `fetch` / Hub REST sends an ISO STRING;
 *   3. the `project/create` + `project/update` proposal executors replay the
 *      payload out of `proposals.data`, which is JSONB — so an agent-proposed
 *      `Date` is read back as an ISO STRING, and only on APPROVAL.
 *
 * A `z.date()` would satisfy the compiler and then throw on approve, i.e. an
 * agent's project deadline would be unapprovable in production and green in CI.
 * Case (2)/(3) is what `acceptsAnIsoString` pins.
 *
 * MEASURED COVERAGE — established by reverting, not asserted:
 *  - deleting `targetDate` from both router inputs  → 9 of 11 parse tests red;
 *  - `z.coerce.date()` → `z.date()`                 → 4 red (every ISO case);
 *  - dropping `.nullable()` from create             → 1 red (the epoch test).
 * The two that stay green under a full deletion are the "omitted stays absent"
 * pair, and that is correct rather than a hole: an absent key is absent whether
 * or not the field exists. They are here for the omitted-vs-null distinction,
 * which is the part `.set()` depends on — not as existence proof.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { projectsRouter } from "./projects.js";

const PROJECT_ID = "00000000-0000-4000-8000-0000000000a1";

/**
 * The REAL input schema of a shipped procedure. Reaching through `_def` is
 * deliberate: it is what makes deleting `targetDate` from the router fail this
 * file, which a locally rebuilt schema object could never do.
 */
function inputSchema(name: "create" | "update"): z.ZodTypeAny {
  const procedures = (
    projectsRouter as unknown as {
      _def: {
        procedures: Record<string, { _def: { inputs: z.ZodTypeAny[] } }>;
      };
    }
  )._def.procedures;
  const schema = procedures[name]?._def?.inputs?.[0];
  // Non-vacuity: if tRPC ever changes where it stores the input schema, every
  // assertion below would silently pass against `undefined`.
  if (!schema || typeof (schema as { parse?: unknown }).parse !== "function") {
    throw new Error(
      `projects.${name} input schema not reachable via _def.inputs[0] — ` +
        `the accessor is stale, not the field.`
    );
  }
  return schema;
}

const parseCreate = (v: Record<string, unknown>) =>
  inputSchema("create").parse({ name: "Q3 migration", ...v }) as {
    targetDate?: Date | null;
  };
const parseUpdate = (v: Record<string, unknown>) =>
  inputSchema("update").parse({ id: PROJECT_ID, ...v }) as {
    targetDate?: Date | null;
  };

describe("projects.create — targetDate is accepted and coerced", () => {
  it("accepts a real Date (typed tRPC client / superjson)", () => {
    const at = new Date("2031-06-01T00:00:00.000Z");
    const out = parseCreate({ targetDate: at });
    expect(out.targetDate).toBeInstanceOf(Date);
    expect(out.targetDate?.toISOString()).toBe("2031-06-01T00:00:00.000Z");
  });

  it("acceptsAnIsoString — Hub REST *and* the JSONB proposal replay", () => {
    // This is the case a bare `z.date()` fails, and it fails ONLY on approval.
    const out = parseCreate({ targetDate: "2031-06-01T00:00:00.000Z" });
    expect(out.targetDate).toBeInstanceOf(Date);
    expect(out.targetDate?.toISOString()).toBe("2031-06-01T00:00:00.000Z");
  });

  it("ACCEPTS a past date — an overdue project is the state the field exists to show", () => {
    // Refusing this would hide exactly the signal 0252 was added for: with no
    // date a project can only ever be green. Recording work already past its
    // deadline is routine, so this must not be a validation error.
    const out = parseCreate({ targetDate: "2020-01-05T00:00:00.000Z" });
    expect(out.targetDate?.toISOString()).toBe("2020-01-05T00:00:00.000Z");
  });

  it("rejects an unparseable date rather than storing Invalid Date", () => {
    expect(() => parseCreate({ targetDate: "not-a-date" })).toThrow();
    expect(() => parseCreate({ targetDate: "" })).toThrow();
  });

  it("null means UNDATED — never the 1970 epoch", () => {
    // The regression this pins: `z.coerce.date()` alone does NOT reject null,
    // because `new Date(null)` is the epoch, a perfectly valid Date. Dropping
    // `.nullable()` therefore turns "no deadline" into a project dated
    // 1970-01-01 — permanently and silently overdue, with no error anywhere.
    const out = parseCreate({ targetDate: null });
    expect(out.targetDate).toBeNull();
    expect(out.targetDate).not.toBeInstanceOf(Date);
  });

  it("omitted stays absent — an undated project is not late, it is undated", () => {
    expect("targetDate" in parseCreate({})).toBe(false);
  });
});

describe("projects.update — the two-state contract (omitted vs explicit null)", () => {
  it("omitted = UNTOUCHED (the key must not appear at all)", () => {
    // `.set()` skips `undefined`; a key materialising here as `undefined` would
    // be indistinguishable from a clear at the Drizzle boundary for any future
    // field that is not skipped.
    expect("targetDate" in parseUpdate({})).toBe(false);
  });

  it("explicit null = CLEAR the deadline, and survives as null (not epoch)", () => {
    const out = parseUpdate({ targetDate: null });
    expect("targetDate" in out).toBe(true);
    expect(out.targetDate).toBeNull();
  });

  it("accepts an ISO string, for the same three callers as create", () => {
    const out = parseUpdate({ targetDate: "2031-06-01T00:00:00.000Z" });
    expect(out.targetDate).toBeInstanceOf(Date);
  });

  it("accepts a past date on update too (a deadline that has slipped)", () => {
    expect(
      parseUpdate({ targetDate: "2020-01-05T00:00:00.000Z" }).targetDate
    ).toBeInstanceOf(Date);
  });

  it("rejects an unparseable date", () => {
    expect(() => parseUpdate({ targetDate: "whenever" })).toThrow();
  });
});

/**
 * The ROOT defect class, guarded structurally rather than by example.
 *
 * 0252 shipped a column that no code wrote and no code read — it existed only in
 * the migration. The specific field is now covered above; this block covers the
 * NEXT one, by deriving the expected write set from `UpdateProjectInput` itself
 * instead of a hand-maintained list. A new optional field on that interface
 * joins this scan BY EXISTING, which is the property a hand list never has (the
 * `DOORS` array in this repo held the one door that was already correct while
 * four others were broken).
 *
 * MEASURED LIMITS — what this does NOT cover, so nobody reads more into it:
 *  - It parses SOURCE, not behaviour: it proves the field is mentioned in the
 *    `.set({...})` object, not that the written value is correct. The parse
 *    contract above is what covers the value.
 *  - Granularity is the `.set()` block, not the statement — a field assigned
 *    from the wrong variable still passes here.
 *  - `create`'s `.values({...})` is scanned by the same rule; a field that is
 *    deliberately create-time-only would need an explicit exemption, and there
 *    is none today.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../database/src/repositories/project-repository.ts"
);

function block(source: string, marker: string, open: string): string {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const from = source.indexOf(open, start);
  if (from === -1) throw new Error(`open brace not found after: ${marker}`);
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced block after: ${marker}`);
}

describe("ProjectRepository writes every field its input interface declares", () => {
  const source = readFileSync(REPO_SRC, "utf8");

  /** Field names declared on an interface — DERIVED, never hand-listed. */
  function declaredFields(interfaceName: string): string[] {
    const body = block(source, `export interface ${interfaceName}`, "{");
    const names = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    // Non-vacuity: a regex that silently matched nothing would make every
    // assertion below pass against an empty set.
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(names).toContain("phase");
    return names;
  }

  it("update(): every UpdateProjectInput field appears in the .set({...})", () => {
    const setBlock = block(source, "async update(", ".set({");
    // Self-check that the scan can still see a known-present sample.
    expect(setBlock).toContain("phase");
    for (const field of declaredFields("UpdateProjectInput")) {
      expect(
        setBlock,
        `UpdateProjectInput.${field} is declared but never written by update()'s .set({...}) — ` +
          `that is how projects.target_date shipped with no writer.`
      ).toContain(field);
    }
  });

  it("create(): every CreateProjectInput field appears in the .values({...})", () => {
    const valuesBlock = block(source, "async create(", ".values({");
    expect(valuesBlock).toContain("phase");
    const skip = new Set([
      // Not columns: consumed by create() itself before the insert.
      "provenance", // folded into `metadata`
      "settings", // written, but via the `data.settings || {}` expression
    ]);
    for (const field of declaredFields("CreateProjectInput")) {
      if (skip.has(field)) continue;
      expect(
        valuesBlock,
        `CreateProjectInput.${field} is declared but never inserted by create()'s .values({...}).`
      ).toContain(field);
    }
  });
});
