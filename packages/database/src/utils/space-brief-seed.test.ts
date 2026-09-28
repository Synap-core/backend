import { describe, it, expect } from "vitest";
import {
  SPACE_BRIEF_SEEDED_FIELDS,
  convergeSpaceBrief,
  hashBriefField,
  projectTemplateBrief,
  seedRefResolver,
} from "./space-brief-seed.js";
import type { WorkspaceSpaceBrief } from "../schema/workspaces.js";
// TEST-ONLY relative import of the canonical list. `@synap/database` cannot
// depend on `@synap-core/types` (build cycle); tsconfig excludes tests, so this
// path never enters the database build (precedent: guideline-vocabulary-parity).
import * as canonical from "../../../types/src/space-brief/index.js";

const V1: WorkspaceSpaceBrief = {
  goal: "Capture the brand",
  framing: "THE BRAND STRATEGIST",
  collect: [
    { profileSlug: "brand-identity", what: "Identity", cardinality: "one" },
  ],
};

/** Install V1 exactly as the create path does: stamp every written field. */
function install(template: WorkspaceSpaceBrief) {
  const c = convergeSpaceBrief({
    stored: undefined,
    seed: undefined,
    template: projectTemplateBrief(template),
  });
  return { stored: c.next!, seed: c.nextSeed! };
}

describe("space brief three-way stamp", () => {
  it("absent → written + stamped with the hash of the value written", () => {
    const { stored, seed } = install(V1);
    expect(stored).toEqual(V1);
    expect(seed.fields.goal).toBe(hashBriefField(V1.goal));
    expect(seed.fields.collect).toBe(hashBriefField(V1.collect));
    expect(Object.keys(seed.fields).sort()).toEqual([
      "collect",
      "framing",
      "goal",
    ]);
  });

  it("untouched → template update lands and restamps", () => {
    const { stored, seed } = install(V1);
    const v2 = {
      ...V1,
      framing: "A sharper strategist",
      purpose: "Brand source of truth",
    };
    const c = convergeSpaceBrief({
      stored,
      seed,
      template: projectTemplateBrief(v2),
    });
    expect(c.next?.framing).toBe("A sharper strategist");
    expect(c.next?.purpose).toBe("Brand source of truth");
    expect(c.outcomes).toEqual({ framing: "updated", purpose: "written" });
    expect(c.nextSeed?.fields.framing).toBe(
      hashBriefField("A sharper strategist")
    );
    expect(c.conflicts).toEqual([]);
  });

  it("USER EDIT IS NEVER OVERWRITTEN — kept, and reported only when the template moved too", () => {
    const { stored, seed } = install(V1);
    const edited = { ...stored, framing: "My own voice" };
    // Template unchanged: kept, no conflict, no write.
    const same = convergeSpaceBrief({
      stored: edited,
      seed,
      template: projectTemplateBrief(V1),
    });
    expect(same.next).toBeNull();
    expect(same.outcomes.framing).toBe("kept");
    expect(same.conflicts).toEqual([]);
    // Template moved: still kept, now a conflict.
    const moved = convergeSpaceBrief({
      stored: edited,
      seed,
      template: projectTemplateBrief({ ...V1, framing: "Template v2" }),
    });
    expect(moved.next).toBeNull();
    expect(moved.conflicts).toEqual([{ field: "framing", reason: "edited" }]);
  });

  it("a user REMOVING a field is an edit too — the template does not resurrect it", () => {
    const { stored, seed } = install(V1);
    const { framing: _gone, ...removed } = stored;
    const c = convergeSpaceBrief({
      stored: removed,
      seed,
      template: projectTemplateBrief({ ...V1, framing: "v2" }),
    });
    expect(c.next).toBeNull();
    expect(c.conflicts).toEqual([{ field: "framing", reason: "edited" }]);
  });

  it("legacy (no seed): equal → adopted (stamp only); different → unstamped conflict, never stamped", () => {
    const legacy = { ...V1, doneWhen: "old done" };
    const c = convergeSpaceBrief({
      stored: legacy,
      seed: undefined,
      template: projectTemplateBrief({
        ...V1,
        doneWhen: "new done",
        purpose: "p",
      }),
    });
    expect(c.outcomes).toMatchObject({
      goal: "adopted",
      framing: "adopted",
      collect: "adopted",
      purpose: "written",
    });
    expect(c.conflicts).toEqual([{ field: "doneWhen", reason: "unstamped" }]);
    expect(c.next?.doneWhen).toBe("old done");
    expect(c.nextSeed?.fields.doneWhen).toBeUndefined();
  });

  it("rule refs (applier-owned) ride through untouched", () => {
    const { stored, seed } = install(V1);
    const withRefs = {
      ...stored,
      rules: [{ key: "assets-first", ruleId: "r1" }],
    };
    const c = convergeSpaceBrief({
      stored: withRefs,
      seed,
      template: projectTemplateBrief({
        ...V1,
        purpose: "p",
        rules: [{ key: "x" }],
      } as WorkspaceSpaceBrief),
    });
    expect(c.next?.rules).toEqual([{ key: "assets-first", ruleId: "r1" }]);
    expect(c.nextSeed?.fields.rules).toBeUndefined();
  });

  it("converged is a no-op (no write)", () => {
    const { stored, seed } = install(V1);
    const c = convergeSpaceBrief({
      stored,
      seed,
      template: projectTemplateBrief(V1),
    });
    expect(c.next).toBeNull();
    expect(c.nextSeed).toBeNull();
  });
});

describe("anchors: seedRef → entityId through the ONE ref ladder", () => {
  it("resolves by bare title and by kind:title; unresolved keeps its seedRef", () => {
    const resolve = seedRefResolver(
      [{ profileSlug: "brand-identity", title: "Your brand" }],
      new Map([["brand-identity:Your brand", "e-1"]])
    );
    const p = projectTemplateBrief(
      {
        anchors: [
          {
            profileSlug: "brand-identity",
            role: "root",
            seedRef: "Your brand",
          },
          {
            profileSlug: "brand-identity",
            role: "context",
            seedRef: "brand-identity:Your brand",
          },
          { profileSlug: "brand-rule", role: "context", seedRef: "Missing" },
        ],
      },
      resolve
    );
    expect(p.anchors?.map((a) => a.entityId)).toEqual([
      "e-1",
      "e-1",
      undefined,
    ]);
    expect(p.anchors?.[2]?.seedRef).toBe("Missing");
  });
});

describe("tripwires", () => {
  it("PARITY: the seeded set IS the canonical template-field set (@synap-core/types)", () => {
    expect([...SPACE_BRIEF_SEEDED_FIELDS]).toEqual([
      ...canonical.SPACE_BRIEF_TEMPLATE_FIELDS,
    ]);
    expect(SPACE_BRIEF_SEEDED_FIELDS.length).toBeGreaterThanOrEqual(9);
  });

  it("the WRITTEN set equals the COMPARED set: a template carrying every canonical field writes exactly the seeded fields, each stamped", () => {
    // Derived from the canonical type, not hand-listed: every template field,
    // plus the applier-owned field and an unknown key that must NOT be written.
    const template: Record<string, unknown> = { unknownKey: "x" };
    for (const f of [
      ...canonical.SPACE_BRIEF_TEMPLATE_FIELDS,
      ...canonical.SPACE_BRIEF_APPLIER_OWNED_FIELDS,
    ]) {
      template[f] =
        f === "anchors" ? [{ profileSlug: "k", role: "root" }] : `v-${f}`;
    }
    const c = convergeSpaceBrief({
      stored: undefined,
      seed: undefined,
      template: projectTemplateBrief(template as WorkspaceSpaceBrief),
    });
    expect(Object.keys(c.next!).sort()).toEqual(
      [...SPACE_BRIEF_SEEDED_FIELDS].sort()
    );
    expect(Object.keys(c.nextSeed!.fields).sort()).toEqual(
      [...SPACE_BRIEF_SEEDED_FIELDS].sort()
    );
  });
});
