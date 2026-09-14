/**
 * Loading step 1 (measurement): where a capture's time went reaches the run
 * manifest (`focus_sessions.metadata.run.timings`), which `synap_diagnose` and
 * the room read through `readSessionRunManifest`.
 *
 * Driven through the real chain the capture door uses: the IS `meta` +
 * the pod's step timings → `runFactsFromStructureMeta` → `mergeRunManifest`
 * (the patch `recordStructureIntake` spreads `runFacts` into) → JSON (the jsonb
 * column) → `readSessionRunManifest`. Nothing between is hand-built.
 *
 * NOT covered here: the real SQL write (`intake-run.pglite.test.ts` owns it).
 */

import { describe, it, expect } from "vitest";
import {
  mergeRunManifest,
  readSessionRunManifest,
  runFactsFromStructureMeta,
} from "../record-session-run-manifest.js";

const META = {
  engine: "structure" as const,
  model: "model-x",
  provider: "prov-y",
  promptVersion: "structure:abc",
  timings: { waitMs: 12, extractMs: 0, modelMs: 900, salvaged: false },
};

function roundTrip(runFacts: ReturnType<typeof runFactsFromStructureMeta>) {
  const manifest = mergeRunManifest(undefined, runFacts);
  return readSessionRunManifest(JSON.parse(JSON.stringify({ run: manifest })));
}

describe("run manifest timings", () => {
  it("IS + pod timings arrive on the stored manifest, present and non-negative", () => {
    const read = roundTrip(
      runFactsFromStructureMeta(META, {
        podTimings: { dedupMs: 40, placementMs: 7 },
      })
    );
    expect(read?.timings).toEqual({
      waitMs: 12,
      extractMs: 0,
      modelMs: 900,
      salvaged: false,
      dedupMs: 40,
      placementMs: 7,
    });
    for (const [k, v] of Object.entries(read!.timings!)) {
      if (typeof v === "number") expect(v, k).toBeGreaterThanOrEqual(0);
    }
  });

  it("a step that did not run is null, never 0 (a follow-up skips dedup)", () => {
    const read = roundTrip(
      runFactsFromStructureMeta(META, {
        podTimings: { dedupMs: null, placementMs: 3 },
      })
    );
    expect(read?.timings).toMatchObject({ dedupMs: null, placementMs: 3 });
  });

  it("an older IS without timings records the IS facts as null, not guessed", () => {
    const { timings: _dropped, ...oldMeta } = META;
    const read = roundTrip(
      runFactsFromStructureMeta(oldMeta, {
        podTimings: { dedupMs: 5, placementMs: 2 },
      })
    );
    expect(read?.timings).toEqual({
      waitMs: null,
      extractMs: null,
      modelMs: null,
      salvaged: null,
      dedupMs: 5,
      placementMs: 2,
    });
  });

  it("a negative or non-number value is refused as null on read", () => {
    const read = readSessionRunManifest({
      run: {
        timings: { waitMs: -1, modelMs: "fast", salvaged: "no", dedupMs: 9 },
      },
    });
    expect(read?.timings).toEqual({
      waitMs: null,
      extractMs: null,
      modelMs: null,
      salvaged: null,
      dedupMs: 9,
      placementMs: null,
    });
  });

  it("a later call without timings keeps the stored ones (latest writer, as a whole)", () => {
    const first = mergeRunManifest(
      undefined,
      runFactsFromStructureMeta(META, {
        podTimings: { dedupMs: 1, placementMs: 1 },
      })
    );
    const { timings: _t, ...noTimings } = META;
    const second = mergeRunManifest(
      first,
      runFactsFromStructureMeta(noTimings)
    );
    expect(second.timings).toEqual(first.timings);
  });
});
