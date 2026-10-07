/**
 * The process contract (Process galaxy, Wave 0): the new playbook definition
 * fields reach the stored shape through the ONE write schema and the ONE fold,
 * and a slot's `relationToSubject` survives the birth sanitizer.
 */
import { describe, it, expect } from "vitest";
import {
  packagePlaybookDefinitionSchema,
  playbookDefinitionSchema,
} from "./playbook-definition.js";
import { playbookStageSchema } from "./playbook-stage.js";
import {
  foldProcessIntoSubjectProfile,
  ProcessDeclarationError,
  readPlaybookProcess,
} from "./playbook-process.js";
import { projectPlaybookDefinition } from "../services/playbooks/playbook-market-source.js";
import { sanitizeDeclaredOutputs } from "../services/focus-sessions/update-session.js";

const BASE = { name: "Produce content", goalTemplate: "Produce it" };

describe("stage: subjectStatus + onFail", () => {
  it("keeps subjectStatus and onFail through the stage write schema", () => {
    const r = playbookStageSchema.parse({
      key: "draft",
      name: "Draft",
      category: "started",
      subjectStatus: "drafting",
      onFail: { toStage: "idea" },
    });
    expect(r.subjectStatus).toBe("drafting");
    expect(r.onFail).toEqual({ toStage: "idea" });
  });

  it("refuses a misspelled key inside onFail (a control, strict like gate)", () => {
    expect(
      playbookStageSchema.safeParse({
        key: "draft",
        name: "Draft",
        category: "started",
        onFail: { toStag: "idea" },
      }).success
    ).toBe(false);
  });

  it("validates relationToSubject on a stage slot as a slug", () => {
    const ok = playbookStageSchema.safeParse({
      key: "a",
      name: "A",
      category: "started",
      expectedOutputs: [{ kind: "post", label: "Post", relationToSubject: "made_for" }],
    });
    expect(ok.success).toBe(true);
    const bad = playbookStageSchema.safeParse({
      key: "a",
      name: "A",
      category: "started",
      expectedOutputs: [{ kind: "post", label: "Post", relationToSubject: "Made For" }],
    });
    expect(bad.success).toBe(false);
  });
});

describe("definition: activators, humanOnlyStatuses, statusProperty, lineage", () => {
  it("parses the whole contract", () => {
    const r = playbookDefinitionSchema.parse({
      ...BASE,
      subjectProfile: { profileSlug: "post", statusProperty: "post-status" },
      activators: [
        { on: "created" },
        { on: "enters_status", status: "published", mode: "run" },
      ],
      humanOnlyStatuses: ["published"],
      expectedOutputs: [{ kind: "post", label: "Cut", relationToSubject: "derived_from" }],
      metadata: { lineage: { apqc: "3.5.2", method: "Repurpose", onet: ["27-3043"] } },
    });
    expect(r.subjectProfile?.statusProperty).toBe("post-status");
    // mode defaults to propose — the public-template default.
    expect(r.activators?.[0]).toEqual({ on: "created", mode: "propose" });
    expect(r.activators?.[1]?.mode).toBe("run");
    expect(r.humanOnlyStatuses).toEqual(["published"]);
    expect(r.expectedOutputs?.[0]?.relationToSubject).toBe("derived_from");
    expect(r.metadata?.lineage?.apqc).toBe("3.5.2");
  });

  it("refuses enters_status without a status, and a duplicate activator", () => {
    expect(
      playbookDefinitionSchema.safeParse({
        ...BASE,
        activators: [{ on: "enters_status" }],
      }).success
    ).toBe(false);
    expect(
      playbookDefinitionSchema.safeParse({
        ...BASE,
        activators: [{ on: "created" }, { on: "created", mode: "run" }],
      }).success
    ).toBe(false);
  });

  it("the package schema carries the same fields (it extends the one schema)", () => {
    const r = packagePlaybookDefinitionSchema.parse({
      ...BASE,
      subjectProfile: { profileSlug: "post" },
      activators: [{ on: "created" }],
    });
    expect(r.activators).toHaveLength(1);
  });
});

describe("the ONE fold: activators/humanOnlyStatuses → subjectProfile", () => {
  it("the package projection stores them inside subjectProfile", () => {
    const parsed = packagePlaybookDefinitionSchema.parse({
      ...BASE,
      subjectProfile: { profileSlug: "post", statusProperty: "post-status" },
      activators: [{ on: "enters_status", status: "published" }],
      humanOnlyStatuses: ["published"],
    });
    const projected = projectPlaybookDefinition(parsed) as Record<string, unknown>;
    expect(projected.subjectProfile).toEqual({
      profileSlug: "post",
      statusProperty: "post-status",
      activators: [{ on: "enters_status", status: "published", mode: "propose" }],
      humanOnlyStatuses: ["published"],
    });
    // …and the stored shape reads back through the one reader.
    expect(readPlaybookProcess(projected.subjectProfile)).toEqual({
      profileSlug: "post",
      statusProperty: "post-status",
      activators: [{ on: "enters_status", status: "published", mode: "propose" }],
      humanOnlyStatuses: ["published"],
      activatorsInvalid: false,
    });
  });

  it("a definition silent about the process leaves subjectProfile untouched", () => {
    expect(
      foldProcessIntoSubjectProfile({ subjectProfile: { profileSlug: "x" } })
    ).toEqual({ profileSlug: "x" });
    expect(foldProcessIntoSubjectProfile({})).toBeUndefined();
  });

  it("refuses activators with no subject kind (would fire on every entity)", () => {
    expect(() =>
      foldProcessIntoSubjectProfile({ activators: [{ on: "created", mode: "run" }] })
    ).toThrow(ProcessDeclarationError);
  });
});

describe("sanitizeDeclaredOutputs carries relationToSubject onto owed slots", () => {
  it("keeps the declaration and strips a forged edge receipt", () => {
    const [born] = sanitizeDeclaredOutputs([
      {
        kind: "post",
        label: "Cut",
        relationToSubject: "derived_from",
        subjectEdge: {
          status: "linked",
          relationType: "derived_from",
          at: "2026-10-08T00:00:00.000Z",
        },
      },
    ]);
    expect(born!.relationToSubject).toBe("derived_from");
    expect(born!.subjectEdge).toBeUndefined();
  });
});

/**
 * Lane A's template shape through the REAL Hub `/packages/apply` parse
 * (`PackageApplySchema`, which every install door inherits) and the applier's
 * projection: every process-contract field must SURVIVE — zod strips any key a
 * schema forgot, and a stripped key reaches no pod.
 */
describe("a template-shaped playbook survives the package apply parse", () => {
  it("keeps every contract field through PackageApplySchema + the projection", async () => {
    const { PackageApplySchema } = await import(
      "../routers/hub-protocol/rest/packages.js"
    );
    const body = PackageApplySchema.parse({
      name: "Content",
      playbooks: [
        {
          name: "Produce Content",
          goalTemplate: "Produce the post",
          subjectProfile: { profileSlug: "post", statusProperty: "post-status" },
          activators: [{ on: "enters_status", status: "ready", mode: "propose" }],
          humanOnlyStatuses: ["idea", "archived"],
          expectedOutputs: [
            { kind: "post", label: "Final post", relationToSubject: "none" },
          ],
          requiredIntents: [],
          metadata: { lineage: { apqc: "3.5", method: "Editorial" } },
          stages: [
            {
              key: "draft",
              name: "Draft",
              category: "started",
              subjectStatus: "drafting",
              onFail: { toStage: "draft" },
              expectedOutputs: [
                { kind: "document", label: "Draft", relationToSubject: "made_for" },
              ],
            },
          ],
        },
      ],
    });
    const pb = body.playbooks![0]!;
    expect(pb.subjectProfile?.statusProperty).toBe("post-status");
    expect(pb.activators).toEqual([
      { on: "enters_status", status: "ready", mode: "propose" },
    ]);
    expect(pb.humanOnlyStatuses).toEqual(["idea", "archived"]);
    expect(pb.expectedOutputs?.[0]?.relationToSubject).toBe("none");
    expect(pb.metadata?.lineage?.apqc).toBe("3.5");
    expect(pb.stages?.[0]?.subjectStatus).toBe("drafting");
    expect(pb.stages?.[0]?.onFail).toEqual({ toStage: "draft" });
    expect(pb.stages?.[0]?.expectedOutputs?.[0]?.relationToSubject).toBe(
      "made_for"
    );
    // …and the applier's projection (what `playbooks.create` receives) folds
    // the process declarations into the stored subjectProfile.
    const projected = projectPlaybookDefinition(pb) as Record<string, unknown>;
    expect(projected.subjectProfile).toMatchObject({
      profileSlug: "post",
      statusProperty: "post-status",
      activators: [{ on: "enters_status", status: "ready", mode: "propose" }],
      humanOnlyStatuses: ["idea", "archived"],
    });
    expect(projected.stages).toEqual(pb.stages);
    expect(projected.expectedOutputs).toEqual(pb.expectedOutputs);
  });
});
