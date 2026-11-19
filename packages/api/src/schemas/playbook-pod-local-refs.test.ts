/**
 * A package names kinds and relations, never this pod's ids. A guidance `entity:<id>` ref and a dedicated record
 * (`subjectProfile.entityId`) are pod-local: the pod's own playbook door
 * accepts them, every package door refuses them, and the exporter leaves
 * them out.
 */
import { describe, it, expect } from "vitest";
import {
  packagePlaybookDefinitionSchema,
  playbookDefinitionSchema,
} from "./playbook-definition.js";
import { playbookRowToPackagePlaybook } from "../services/workspace-to-package-definition.js";

const RECORD = "2c0f1a3e-0000-4000-8000-000000000001";
const base = { name: "Ship the CRM app", goalTemplate: "Ship it" };
const podLocal = {
  ...base,
  guidance: [{ ref: "subject:uses_brand" }, { ref: `entity:${RECORD}` }],
  subjectProfile: { profileSlug: "app", entityId: RECORD },
};

describe("pod-local playbook refs", () => {
  it("the pod's own playbook door accepts entity: and a dedicated record", () => {
    expect(playbookDefinitionSchema.safeParse(podLocal).success).toBe(true);
  });

  it("NEGATIVE: the package door refuses both, naming each", () => {
    const r = packagePlaybookDefinitionSchema.safeParse(podLocal);
    expect(r.success).toBe(false);
    const paths = (r.error?.issues ?? []).map((i) => i.path.join("."));
    expect(paths).toEqual(
      expect.arrayContaining(["guidance.1", "subjectProfile.entityId"])
    );
    expect(paths).not.toContain("guidance.0");
  });

  it("the package door keeps a portable subject: ref", () => {
    const r = packagePlaybookDefinitionSchema.safeParse({
      ...base,
      guidance: [{ ref: "subject:uses_brand" }],
      subjectProfile: { profileSlug: "app" },
    });
    expect(r.success).toBe(true);
  });

  it("a dedicated record needs its kind", () => {
    const r = playbookDefinitionSchema.safeParse({
      ...base,
      subjectProfile: { entityId: RECORD },
    });
    expect(r.success).toBe(false);
  });

  it("the exporter leaves the pod-local refs and the learned metadata out, and keeps the rest", () => {
    const out = playbookRowToPackagePlaybook(
      {
        name: base.name,
        description: null,
        goalTemplate: base.goalTemplate,
        params: [],
        executor: "is-agent",
        inputStrategy: null,
        channelSpec: null,
        schedule: null,
        subjectProfile: podLocal.subjectProfile,
        status: "active",
        scope: null,
        stages: [],
        criteria: [],
        expectedOutputs: [],
        guidance: podLocal.guidance,
        metadata: {
          lessons: ["Read the brief first"],
          whatWorked: { runs: 3, parts: [] },
          proposeOnly: true,
        },
      },
      undefined
    );
    expect(out.guidance).toEqual([{ ref: "subject:uses_brand" }]);
    expect(out.subjectProfile).toEqual({ profileSlug: "app" });
    // What this pod's runs taught stays on the pod; the rest of the bag travels.
    expect(out.metadata).toEqual({ proposeOnly: true });
    // What a package door then reads of it passes (the row's null schedule
    // and channel are the exporter's own business, not this check's).
    const { schedule: _s, channelSpec: _c, ...portable } = out;
    expect(packagePlaybookDefinitionSchema.safeParse(portable).success).toBe(
      true
    );
  });
});
