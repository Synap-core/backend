/**
 * `resolveProjectPhaseCategory` — the LEGACY reader of a project's
 * `settings.stages` + `phase` (still read by `projects.list`/`get` until the
 * next wave moves them onto tracks).
 *
 * The deep-copy independence proof that used to live here moved with the copy
 * itself: a method's stages are now pinned on a TRACK
 * (`services/tracks/__tests__/track-snapshot.test.ts`). Nothing writes
 * `settings.stages` any more, so these fixtures are literal stored shapes.
 *
 * No DB — pure functions over the jsonb shapes.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBOOK_STAGE_CATEGORY,
  type PlaybookStage,
} from "@synap/playbooks";
import { resolveProjectPhaseCategory } from "./projects.js";

const PLAYBOOK_ID = "00000000-0000-4000-8000-0000000000a1";

function templateStages(): PlaybookStage[] {
  return [
    {
      key: "discovery",
      name: "Discovery",
      category: "planned",
      expectedOutputs: [{ kind: "document", label: "Brief" }],
    },
    { key: "build", name: "Build", category: "started" },
    { key: "handover", name: "Handover", category: "completed" },
  ];
}

/** A project as the proto-track left it (0272 backfilled these into tracks). */
function boundSettings(stages: unknown = templateStages()) {
  return { stages, sourcePlaybookId: PLAYBOOK_ID, sourcePlaybookVersion: 3 };
}

describe("resolveProjectPhaseCategory", () => {
  it("resolves a bound project's phase to its stage's declared category", () => {
    const settings = boundSettings();
    expect(resolveProjectPhaseCategory("handover", settings)).toBe("completed");
    expect(resolveProjectPhaseCategory("discovery", settings)).toBe("planned");
  });

  it("a LEGACY category-less stage falls to the ONE shared default", () => {
    // Stored before `category` existed — must still resolve, via the shared
    // resolver, never a locally invented answer.
    const settings = boundSettings([{ key: "kickoff", name: "Kickoff" }]);
    expect(resolveProjectPhaseCategory("kickoff", settings)).toBe(
      DEFAULT_PLAYBOOK_STAGE_CATEGORY
    );
  });

  it("an UNBOUND project (free-text phase, no copied stages) uses the same default", () => {
    expect(resolveProjectPhaseCategory("whatever we call it", null)).toBe(
      DEFAULT_PLAYBOOK_STAGE_CATEGORY
    );
    expect(resolveProjectPhaseCategory(null, null)).toBe(
      DEFAULT_PLAYBOOK_STAGE_CATEGORY
    );
  });

  it("a phase that matches no copied stage uses the same default", () => {
    const settings = boundSettings();
    expect(resolveProjectPhaseCategory("not-a-stage", settings)).toBe(
      DEFAULT_PLAYBOOK_STAGE_CATEGORY
    );
  });
});
