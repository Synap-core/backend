/**
 * `readPodVisionModelPreference` — the id `intelligence.setPodDefaults` stored,
 * which `capture.structure` forwards to the IS as a preference.
 *
 * The drizzle chain is stood in; the value it resolves is the real
 * `pod_settings.settings` blob shape `setPodDefaults` writes.
 */

import { describe, expect, it } from "vitest";
import {
  readPodThirdPartyDecisionModelConsent,
  readPodVisionModelPreference,
} from "../pod-vision-preference.js";

function dbReturning(rows: unknown[] | Error) {
  const chain = {
    from: () => chain,
    orderBy: () => chain,
    limit: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  };
  return { select: () => chain } as unknown as Parameters<
    typeof readPodVisionModelPreference
  >[0];
}

describe("readPodVisionModelPreference", () => {
  it("returns the stored visionModelId", async () => {
    const database = dbReturning([
      {
        settings: {
          intelligenceDefaults: {
            chatModelId: null,
            visionModelId: " gemini-2.5-flash ",
          },
        },
      },
    ]);
    await expect(readPodVisionModelPreference(database)).resolves.toBe(
      "gemini-2.5-flash"
    );
  });

  it("unset, blank, or no row → no preference", async () => {
    for (const rows of [
      [],
      [{ settings: {} }],
      [{ settings: { intelligenceDefaults: { visionModelId: null } } }],
      [{ settings: { intelligenceDefaults: { visionModelId: "  " } } }],
    ]) {
      await expect(
        readPodVisionModelPreference(dbReturning(rows))
      ).resolves.toBeUndefined();
    }
  });

  it("a failed read omits the preference (the IS still picks) instead of throwing", async () => {
    await expect(
      readPodVisionModelPreference(dbReturning(new Error("db down")))
    ).resolves.toBeUndefined();
  });
});

describe("readPodThirdPartyDecisionModelConsent", () => {
  it("allowed ONLY when the stored flag is exactly true", async () => {
    await expect(
      readPodThirdPartyDecisionModelConsent(
        dbReturning([
          {
            settings: {
              intelligenceDefaults: { thirdPartyDecisionModel: true },
            },
          },
        ])
      )
    ).resolves.toEqual({ allowed: true });
  });

  it("default OFF: absent, false, non-boolean, or no row → not opted in", async () => {
    for (const rows of [
      [],
      [{ settings: {} }],
      [{ settings: { intelligenceDefaults: { visionModelId: "x" } } }],
      [
        {
          settings: {
            intelligenceDefaults: { thirdPartyDecisionModel: false },
          },
        },
      ],
      [
        {
          settings: {
            intelligenceDefaults: { thirdPartyDecisionModel: "true" },
          },
        },
      ],
    ]) {
      await expect(
        readPodThirdPartyDecisionModelConsent(dbReturning(rows))
      ).resolves.toEqual({ allowed: false, reason: "not_opted_in" });
    }
  });

  it("a failed read fails CLOSED and says so (read_failed ≠ not opted in)", async () => {
    await expect(
      readPodThirdPartyDecisionModelConsent(dbReturning(new Error("db down")))
    ).resolves.toEqual({ allowed: false, reason: "read_failed" });
  });
});
