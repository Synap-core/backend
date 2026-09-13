import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — the entity, relation and facet doors hand the fan-out what it needs
 * to tag a connection-sync write `origin: "sync"`.
 *
 * WHY: approving a connection's first import materializes hundreds of entities,
 * relations and facets through the tRPC doors via `createCaller`. A write whose
 * fan-out carries no origin fires every event automation once per imported
 * record. A write is tagged "sync" by EITHER of two inputs, so each door must
 * pass both:
 *   - `origin: ctx.origin`  — a caller that says so explicitly;
 *   - the authorizing proposal id — the fan-out derives "sync" when that
 *     proposal carries `data.connectionSync` (`resolveFanOutOrigin`). The
 *     approval path sets `ctx.governanceProposalId`, so for approved imports THIS
 *     is the input that works.
 * `recordDomainMutation` doors (entity create/update/delete, relation
 * create/update/delete) and the facet emitter (`emitFacetSideEffects`, which
 * fans out directly) are both covered. The value reaching `emitSideEffects` is
 * proven at runtime by `utils/domain-mutation.origin.test.ts` and
 * `routers/entities/helpers.facet-origin.test.ts`; the matcher skip by jobs
 * `automation-trigger-matcher.sync-origin.test.ts`.
 *
 * WHY SOURCE-LEVEL: these doors cannot be driven through their real procedures
 * without Postgres (the only caller-level entity test is live-PG gated and SKIPS
 * in a DB-less gate). A test that skips proves nothing, so this scans instead.
 *
 * DERIVED SET: every call of each watched callee in each listed file is found
 * by scanning (balanced-brace literal extraction), not hand-listed — a new call
 * in THESE files joins the check by existing.
 *
 * WHAT IT CANNOT SEE (measured by construction, not implied coverage):
 *   - Any OTHER door: a write path that builds its own ctx without origin /
 *     proposalId, calls a watched callee from a file not listed in DOORS, or
 *     writes WITHOUT `recordDomainMutation` / `emitFacetSideEffects` (a
 *     repository insert, `EntityUpsertService`, a direct `emitSideEffects`) is
 *     invisible here. The sync door's own writes must pass `origin: "sync"`
 *     explicitly.
 *   - Whether the caller's ctx actually CARRIES the values: it checks the door
 *     reads them, not that `apply-approval`'s compositeCtx sets
 *     `governanceProposalId` (pinned by capture-graph-governance-linkage).
 *   - A shadowed `ctx` inside the call would satisfy the text match.
 *   - Granularity is the call literal: an expression that reads the field and
 *     then discards it would pass.
 */

const API_SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(API_SRC, rel), "utf8");

/** The balanced `{ … }` object literal passed to each `callee({ … })` call. */
function callLiterals(src: string, callee: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${callee}\\(\\{`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    const start = m.index + m[0].length - 1;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        out.push(src.slice(start, i + 1));
        break;
      }
    }
  }
  return out;
}

const DOORS = [
  {
    file: "routers/entities/create.ts",
    callee: "recordDomainMutation",
    minCalls: 1,
  },
  {
    file: "routers/entities/mutate.ts",
    callee: "recordDomainMutation",
    minCalls: 2,
  },
  { file: "routers/relations.ts", callee: "recordDomainMutation", minCalls: 3 },
  {
    file: "routers/entities/facets.ts",
    callee: "emitFacetSideEffects",
    minCalls: 3,
  },
] as const;

describe("entity + relation + facet doors pass origin and the authorizing proposal", () => {
  it("self-check: the literal extractor sees a known sample", () => {
    const sample =
      "void recordDomainMutation({ a: 1, data: { b: { c: 2 } }, origin: ctx.origin, proposalId: ctx.governanceProposalId });";
    const [lit] = callLiterals(sample, "recordDomainMutation");
    expect(lit).toContain("origin: ctx.origin");
    expect(lit).toContain("proposalId: ctx.governanceProposalId");
    expect(lit?.endsWith("}")).toBe(true);
  });

  for (const { file, callee, minCalls } of DOORS) {
    it(`every ${callee} call in ${file} forwards origin: ctx.origin`, () => {
      const calls = callLiterals(read(file), callee);
      expect(calls.length).toBeGreaterThanOrEqual(minCalls);
      for (const call of calls) {
        expect(call, `a ${callee} call in ${file} drops ctx.origin`).toMatch(
          /\borigin:\s*ctx\.origin\b/
        );
      }
    });

    it(`every ${callee} call in ${file} names the authorizing proposal`, () => {
      const calls = callLiterals(read(file), callee);
      expect(calls.length).toBeGreaterThanOrEqual(minCalls);
      for (const call of calls) {
        expect(
          call,
          `a ${callee} call in ${file} drops ctx.governanceProposalId — origin cannot be derived for an approved sync import`
        ).toMatch(/\bproposalId:[\s\S]{0,160}?\bctx\.governanceProposalId\b/);
      }
    });
  }

  it("Context declares origin (so the doors read a typed field, not a cast)", () => {
    expect(read("types/context.ts")).toMatch(/\borigin\?:\s*"sync";/);
  });
});
