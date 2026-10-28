import { describe, it, expect } from "vitest";
import { BRIEF_MAX_SOURCES, capBriefEnvelope } from "../brief-envelope.js";
import type { SynthesisResult } from "../synthesize.js";

const src = (i: number) => ({
  substrate: "semantic" as const,
  id: `ent-${i}`,
  title: `Entity ${i}`,
});

function synthesisWithOmitted(omittedCount: number): SynthesisResult {
  return {
    answer: "a",
    sources: Array.from({ length: 3 }, (_, i) => src(i)),
    truncated: {
      omitted: omittedCount,
      total: omittedCount + 3,
      omittedSources: Array.from({ length: omittedCount }, (_, i) => src(i)),
    },
  } as unknown as SynthesisResult;
}

describe("capBriefEnvelope — truncated.omittedSources", () => {
  it("caps the omitted id list under brief, keeping the counts", () => {
    const { synthesis } = capBriefEnvelope(
      "brief",
      synthesisWithOmitted(176),
      undefined
    );
    expect(synthesis.truncated!.omittedSources).toHaveLength(BRIEF_MAX_SOURCES);
    expect(synthesis.truncated!.omitted).toBe(176);
    expect(synthesis.truncated!.total).toBe(179);
  });

  it("leaves full detail untouched", () => {
    const s = synthesisWithOmitted(176);
    const { synthesis } = capBriefEnvelope("full", s, undefined);
    expect(synthesis.truncated!.omittedSources).toHaveLength(176);
  });
});
