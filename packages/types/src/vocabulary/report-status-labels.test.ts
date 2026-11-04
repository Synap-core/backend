/**
 * The report words (founder, 2026-11-03, F2) and the two run/receipt status
 * rows (`no_effect`, `blocked_by_policy`): what a reader sees on a report's
 * header, under a section, on a slide, and on a run's badge.
 *
 * The report-status token set is pinned to the `report` kind's `reportStatus`
 * enum in the system profiles (read from source: `@synap-core/types` cannot
 * import the database). WHAT THE PIN DOES NOT SEE: a producer that writes a
 * token outside that enum (the column is a string); such a token humanizes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPORT_SECTION_STATUSES,
  REPORT_SECTION_STATUS_LABELS,
  REPORT_STATUSES,
  REPORT_STATUS_LABELS,
  resolveReportSectionStatus,
  resolveReportStatus,
  resolveStatusLabel,
} from "./index.js";

describe("a report's status", () => {
  it('a failed report reads "Stopped early"; generating reads "Writing"', () => {
    expect(resolveReportStatus("failed")).toBe("Stopped early");
    expect(resolveReportStatus("generating")).toBe("Writing");
    expect(resolveReportStatus("ready")).toBe("Ready");
    expect(resolveReportStatus(" FAILED ")).toBe("Stopped early");
  });

  it("an unknown token humanizes, never leaks; nothing reads empty", () => {
    expect(resolveReportStatus("half_done")).toBe("Half done");
    expect(resolveReportStatus(undefined)).toBe("");
  });

  it("covers exactly the reportStatus enum of the report kind", () => {
    const src = readFileSync(
      join(
        import.meta.dirname,
        "../../../database/src/utils/ensure-system-profiles.ts"
      ),
      "utf8"
    );
    // The property DEFINITION (slug, then its constraints), not the profile's
    // slot list, which carries no enum.
    const def = src.match(
      /slug: "reportStatus",\s*valueType:[^\n]*\n\s*constraints: \{ enum: \[([^\]]*)\] \}/
    );
    expect(def, "reportStatus definition not found").not.toBeNull();
    const tokens = [...def![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(tokens.length).toBeGreaterThanOrEqual(3);
    expect([...tokens].sort()).toEqual([...REPORT_STATUSES].sort());
    expect(Object.keys(REPORT_STATUS_LABELS).sort()).toEqual(
      [...REPORT_STATUSES].sort()
    );
  });
});

describe("a report section's status", () => {
  it('a failed section reads "Did not run": the producer\'s meaning, not truncation', () => {
    expect(resolveReportSectionStatus("failed")).toBe("Did not run");
    expect(resolveReportSectionStatus("failed")).not.toBe(
      resolveReportStatus("failed")
    );
    expect(resolveReportSectionStatus("generating")).toBe("Writing");
    expect(resolveReportSectionStatus("ok")).toBe("Complete");
  });

  it("the closing report's verdict states read the verdict words", () => {
    for (const state of ["passing", "failing", "incomplete"] as const) {
      expect(resolveReportSectionStatus(state)).toBe(resolveStatusLabel(state));
    }
  });

  it("every declared token has words; an unknown one humanizes", () => {
    expect(REPORT_SECTION_STATUSES.length).toBeGreaterThanOrEqual(5);
    for (const token of REPORT_SECTION_STATUSES) {
      expect(REPORT_SECTION_STATUS_LABELS[token].length).toBeGreaterThan(0);
    }
    expect(resolveReportSectionStatus("re_run")).toBe("Re run");
  });
});

describe("run and receipt status rows", () => {
  it('no_effect reads "No change"; blocked_by_policy reads "Blocked by policy"', () => {
    expect(resolveStatusLabel("no_effect")).toBe("No change");
    expect(resolveStatusLabel("blocked_by_policy")).toBe("Blocked by policy");
  });

  it("they read French in French", () => {
    expect(resolveStatusLabel("no_effect", "fr")).toBe("Aucun changement");
    expect(resolveStatusLabel("blocked_by_policy", "fr")).toBe(
      "Bloqué par une règle"
    );
  });
});
