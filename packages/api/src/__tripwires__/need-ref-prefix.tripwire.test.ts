/**
 * ONE need-ref spelling (0426). `@synap/playbooks` has no dependencies, so
 * `run-tools.ts` holds its own `NEED_TOOL_PREFIX`; the grammar and the parser
 * are `@synap-core/types/needs` (`NEED_REF_PREFIX`, `parseNeedRef`). This pins
 * the two equal, and that every entry the run-tools reader treats as a need
 * is one the parser reads (or refuses with a reason), so the two can never
 * disagree about which `tools` entries are needs.
 */
import { describe, it, expect } from "vitest";
import { NEED_TOOL_PREFIX, isNeedToolEntry, isRunToolName } from "@synap/playbooks";
import {
  NEED_REF_PREFIX,
  NEED_SLUGS,
  looksLikeNeedRef,
  needRef,
  needRefProblem,
  parseNeedRef,
} from "@synap-core/types/needs";

describe("need refs: one prefix, one grammar", () => {
  it("the run-tools prefix is the vocabulary's prefix", () => {
    expect(NEED_TOOL_PREFIX).toBe(NEED_REF_PREFIX);
  });

  it("every need of the vocabulary is a need entry, parsed, valid, and never a run tool", () => {
    expect(NEED_SLUGS.length).toBeGreaterThanOrEqual(12);
    for (const slug of NEED_SLUGS) {
      const entry = needRef(slug);
      expect(isNeedToolEntry(entry), entry).toBe(true);
      expect(looksLikeNeedRef(entry), entry).toBe(true);
      expect(parseNeedRef(entry), entry).toEqual({ need: slug, intent: null });
      expect(needRefProblem(entry), entry).toBeNull();
      expect(isRunToolName(entry), entry).toBe(false);
    }
  });

  it("self-check: what is not a need ref is not taken for one", () => {
    for (const entry of ["fetch_record", "github_pr_checks", "get_entity", "needs"]) {
      expect(isNeedToolEntry(entry), entry).toBe(false);
      expect(looksLikeNeedRef(entry), entry).toBe(false);
    }
  });
});
