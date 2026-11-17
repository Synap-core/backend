/**
 * A process health travels as a reason CODE; its words come from the
 * vocabulary door, in English and French (Process wave plan 0adf8352, W2
 * review). The code set is DERIVED from the leaf (`PROCESS_HEALTH_REASONS`),
 * so a new code joins this test by existing.
 */
import { describe, expect, it } from "vitest";
import { PROCESS_HEALTH_REASONS } from "../processes/health.js";
import { vocabularySentencesEn } from "./catalog.en.js";
import { vocabularyFr } from "./catalog.fr.js";
import {
  resolveProcessHealthLabel,
  resolveProcessHealthReason,
  resolveStatusLabel,
} from "./index.js";

describe("process health words", () => {
  it("every reason code has its own label and sentence, in English and French", () => {
    expect(PROCESS_HEALTH_REASONS.length).toBeGreaterThan(10);
    const catalogs = { en: vocabularySentencesEn, fr: vocabularyFr } as const;
    for (const reason of PROCESS_HEALTH_REASONS) {
      const health = { reason, latestStatus: "proposed" };
      for (const locale of ["en", "fr"] as const) {
        const words = catalogs[locale] as Record<string, string>;
        const label = resolveProcessHealthLabel(health, { locale });
        const why = resolveProcessHealthReason(health, { locale });
        // Read from the catalog row, never from a humanized fallback.
        expect(label, `${reason} ${locale}`).toBe(
          reason === "waiting_on_you"
            ? resolveStatusLabel("waiting_on_you", locale)
            : words[`vocabulary.processHealth.${reason}.label`]
        );
        expect(words[`vocabulary.processHealth.${reason}.reason`]).toBeTruthy();
        expect(why.length, `${reason} ${locale}`).toBeGreaterThan(label.length);
      }
      expect(resolveProcessHealthReason(health, { locale: "fr" })).not.toBe(
        resolveProcessHealthReason(health, { locale: "en" })
      );
    }
  });

  it("keeps the browser's English words", () => {
    expect(resolveProcessHealthLabel({ reason: "latest_failed" })).toBe(
      "Latest run failed"
    );
    expect(resolveProcessHealthLabel({ reason: "running_after_failure" })).toBe(
      "Running · previous run failed"
    );
    expect(resolveProcessHealthReason({ reason: "never_run" })).toBe(
      "This saved definition has no executions yet."
    );
  });

  it("waiting on you is the status label door's word", () => {
    expect(resolveProcessHealthLabel({ reason: "waiting_on_you" })).toBe(
      resolveStatusLabel("waiting_on_you")
    );
  });

  it("an unresolved latest run names its status through the status door", () => {
    const why = resolveProcessHealthReason({
      reason: "latest_unresolved",
      latestStatus: "cancelled",
    });
    expect(why).toContain(resolveStatusLabel("cancelled"));
    expect(why).not.toContain("{status}");
  });

  it("an unknown code (a newer pod) humanizes, never leaks", () => {
    const health = { reason: "quota_exhausted" } as never;
    expect(resolveProcessHealthLabel(health)).toBe("Quota exhausted");
    expect(resolveProcessHealthReason(health)).toBe("Quota exhausted");
  });
});
