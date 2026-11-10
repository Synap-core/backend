/**
 * `runner`, `requires` and `uses` at the write boundary (spec 7111934d §2),
 * and the regression the lead asked for: a LIVE-SHAPED stage list with none of
 * the new fields parses and versions exactly as before.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { playbookStagesSchema } from "./playbook-stage.js";
import {
  packagePlaybookDefinitionSchema,
  playbookDefinitionSchema,
} from "./playbook-definition.js";
import {
  playbookRunnerSchema,
  requiresSchema,
  stageRunnerSchema,
} from "./playbook-runner.js";
import { definitionVersionChanged } from "../services/playbooks/definition-version.js";
import { PLAYBOOK_VERSION_FIELDS } from "../services/playbooks/playbook-versions.js";
import {
  listWorkspaceTemplates,
  toPackageDefinition,
} from "@synap-core/workspace-templates";

const PB = "00000000-0000-4000-8000-000000000123";

describe("runner — who does a playbook or a step", () => {
  it("takes each kind of choice, one or an ordered list of fallbacks", () => {
    for (const ok of [
      "self",
      "synap_ai",
      { synapAi: { persona: "meta" } },
      {
        agentId: "c340f738-7c2f-494a-ab66-de1c775fef7d",
        preset: "video-editor",
      },
      { role: "video-render", computer: "MacBook-Pro" },
      { engine: "claude-code" },
      [
        { role: "video-render", computer: "mac" },
        { role: "video-render", computer: "devbox" },
      ],
    ]) {
      expect(stageRunnerSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(
        true
      );
    }
  });

  it("refuses a misspelled key rather than storing a step that looks handed off and is not", () => {
    for (const bad of [
      { agent: "c340f738" },
      { role: "video-render", computr: "mac" },
      { engine: "Claude Code" },
      "someone",
      [],
      [
        { engine: "a" },
        { engine: "b" },
        { engine: "c" },
        { engine: "d" },
        { engine: "e" },
      ],
    ]) {
      expect(
        stageRunnerSchema.safeParse(bad).success,
        JSON.stringify(bad)
      ).toBe(false);
    }
  });

  it("a whole playbook cannot be run by 'self' (it names nobody at that level)", () => {
    expect(playbookRunnerSchema.safeParse("self").success).toBe(false);
    expect(playbookRunnerSchema.safeParse(["synap_ai", "self"]).success).toBe(
      false
    );
    expect(playbookRunnerSchema.safeParse({ engine: "hermes" }).success).toBe(
      true
    );
  });
});

describe("requires — the tools a step needs", () => {
  it("is a set of capability keys", () => {
    expect(
      requiresSchema.safeParse(["media-ffmpeg", "media-transcribe"]).success
    ).toBe(true);
    expect(
      requiresSchema.safeParse(["media-ffmpeg", "media-ffmpeg"]).success
    ).toBe(false);
    expect(requiresSchema.safeParse(["needs ffmpeg please"]).success).toBe(
      false
    );
  });
});

describe("uses — a step that is a playbook (shape)", () => {
  const stage = (uses: unknown) => [
    { key: "t", name: "Transcribe", category: "started", uses },
  ];
  it("takes a playbook id, an optional version, `with` paths and `outputs`", () => {
    const parsed = playbookStagesSchema.safeParse(
      stage({
        playbookId: PB,
        version: 3,
        with: { takeUrl: "params.takeUrl", subject: "subject.url" },
        outputs: { Transcript: "Words" },
      })
    );
    expect(parsed.success).toBe(true);
  });
  it("refuses a name in place of an id, prose in `with`, and a misspelled key", () => {
    expect(
      playbookStagesSchema.safeParse(stage({ playbookId: "Transcribe" }))
        .success
    ).toBe(false);
    expect(
      playbookStagesSchema.safeParse(
        stage({ playbookId: PB, with: { takeUrl: "the url of the take" } })
      ).success
    ).toBe(false);
    expect(
      playbookStagesSchema.safeParse(stage({ playbook: PB })).success
    ).toBe(false);
  });
});

describe("a package travels to other pods", () => {
  const base = { name: "P", goalTemplate: "Do it" };
  it("refuses one agent named by id, on the playbook or a step", () => {
    expect(
      packagePlaybookDefinitionSchema.safeParse({
        ...base,
        runner: { agentId: "c340f738" },
      }).success
    ).toBe(false);
    expect(
      packagePlaybookDefinitionSchema.safeParse({
        ...base,
        stages: [
          {
            key: "r",
            name: "Render",
            category: "started",
            runner: [{ role: "video-render" }, { agentId: "c340f738" }],
          },
        ],
      }).success
    ).toBe(false);
  });
  it("refuses a step that is a playbook (it names a playbook on this pod)", () => {
    expect(
      packagePlaybookDefinitionSchema.safeParse({
        ...base,
        stages: [
          {
            key: "t",
            name: "T",
            category: "started",
            uses: { playbookId: PB },
          },
        ],
      }).success
    ).toBe(false);
  });
  it("takes a role or an engine, and requires", () => {
    expect(
      packagePlaybookDefinitionSchema.safeParse({
        ...base,
        runner: { engine: "claude-code" },
        requires: ["media-ffmpeg"],
        stages: [
          {
            key: "r",
            name: "Render",
            category: "started",
            runner: { role: "video-render", computer: "mac" },
            requires: ["media-ffmpeg"],
          },
        ],
      }).success
    ).toBe(true);
  });
});

/**
 * A stage list shaped like the live ones on the founder's pod on 9 Nov 2026
 * (Creative flow v2 "Make the stills": tier, subjectStatus, human gates,
 * onFail; plus the other fields live playbooks carry), with none of the new
 * fields. It must parse to EXACTLY itself, and saving it again must not bump
 * the version: every existing playbook keeps its definition and its version.
 */
const LIVE_SHAPED_STAGES = [
  {
    key: "sets",
    goal: "Read the board (every frame: sketch image, sentence, onScreen).",
    name: "Open the stills sets",
    tier: "quick",
    category: "started",
    subjectStatus: "generating",
  },
  {
    key: "generate",
    goal: "One slide at a time, in each set.",
    name: "Generate the chosen ones",
    tier: "standard",
    category: "started",
    subjectStatus: "generating",
    grants: [{ kind: "tool", id: "fal_generate_image" }],
    expectedOutputs: [{ kind: "file", label: "Slides", optional: true }],
    forEach: { over: "sets", as: "set", max: 20 },
  },
  {
    key: "review",
    gate: { kind: "human" },
    goal: "When the person presses Review the whole on a set.",
    name: "Review",
    onFail: { toStage: "generate" },
    category: "started",
    subjectStatus: "in_review",
    criteria: [
      {
        key: "every-slide-approved",
        statement: "Every slide is approved",
        check: { kind: "human" },
      },
    ],
    lessons: ["Ask for the brand kit first."],
  },
  {
    key: "approved",
    gate: { kind: "human" },
    goal: "The person approves each stills set and the board.",
    name: "Approved",
    category: "completed",
    subjectStatus: "approved",
  },
  {
    key: "learn",
    goal: "Compare what you proposed with what the person did.",
    name: "Learn from the run",
    tier: "deep",
    category: "completed",
    when: { param: "learn", exists: true },
  },
];

describe("every existing playbook runs unchanged (regression)", () => {
  it("a live-shaped stage list with none of the new fields parses to exactly itself", () => {
    const parsed = playbookStagesSchema.parse(
      structuredClone(LIVE_SHAPED_STAGES)
    );
    expect(parsed).toEqual(LIVE_SHAPED_STAGES);
    for (const stage of parsed) {
      expect(stage).not.toHaveProperty("runner");
      expect(stage).not.toHaveProperty("uses");
      expect(stage).not.toHaveProperty("requires");
    }
  });

  it("a definition with no runner / requires stays without them, and re-saving it bumps no version", () => {
    const parsed = playbookDefinitionSchema.parse({
      name: "Make the stills",
      goalTemplate: "Make the stills of {composition}",
      stages: structuredClone(LIVE_SHAPED_STAGES),
    });
    expect(parsed).not.toHaveProperty("runner");
    expect(parsed).not.toHaveProperty("requires");
    const stored = {
      stages: LIVE_SHAPED_STAGES,
      runner: null,
      requires: [],
    };
    expect(definitionVersionChanged({ stages: parsed.stages }, stored)).toBe(
      false
    );
    // …while a changed runner IS a new definition.
    expect(
      definitionVersionChanged({ runner: { engine: "claude-code" } }, stored)
    ).toBe(true);
    expect(
      definitionVersionChanged({ requires: ["media-ffmpeg"] }, stored)
    ).toBe(true);
  });
});

describe("every catalog playbook installs as before (the pinned catalog bundle)", () => {
  const playbooks = listWorkspaceTemplates().flatMap((t) => {
    const def = toPackageDefinition(t) as { playbooks?: unknown[] };
    const slug = (t as { meta?: { slug?: string } }).meta?.slug ?? "?";
    return (def.playbooks ?? []).map((pb) => ({ template: slug, pb }));
  });
  const NEW_FIELDS = new Set(["runner", "requires", "uses"]);

  it("the catalog is non-vacuous", () => {
    expect(playbooks.length).toBeGreaterThan(10);
  });

  // The pinned bundle (0.11.0) predates some later rules (a stage `category`),
  // so a few of its playbooks are refused today, on main too. What THIS change
  // must not do: add a refusal, or a field, to any of them.
  it("the new fields add no refusal and no key to any of them", () => {
    let accepted = 0;
    const blamed: string[] = [];
    for (const { template, pb } of playbooks) {
      const name = `${template}/${(pb as { name?: string }).name}`;
      const parsed = packagePlaybookDefinitionSchema.safeParse(
        structuredClone(pb)
      );
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          if (issue.path.some((seg) => NEW_FIELDS.has(String(seg)))) {
            blamed.push(`${name}: ${issue.path.join(".")} ${issue.message}`);
          }
        }
        continue;
      }
      accepted += 1;
      expect(parsed.data, name).not.toHaveProperty("runner");
      expect(parsed.data, name).not.toHaveProperty("requires");
      const stages = (pb as { stages?: unknown[] }).stages;
      // The stage list comes back exactly as the catalog wrote it.
      if (stages) expect(parsed.data.stages, name).toEqual(stages);
    }
    expect(blamed).toEqual([]);
    expect(accepted).toBeGreaterThan(5);
  });
});

describe("the 0416 backfill keeps the same fields a version keeps", () => {
  it("jsonb_build_object names exactly PLAYBOOK_VERSION_FIELDS", () => {
    const sql = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../database/migrations/0416_playbook_runner_and_versions.sql"
      ),
      "utf8"
    );
    const block = sql.match(/jsonb_build_object\(([\s\S]*?)\n {2}\),/);
    expect(
      block,
      "can still see the backfill's jsonb_build_object"
    ).not.toBeNull();
    const keys = [...block![1]!.matchAll(/'([A-Za-z]+)',/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    // 0419 replaced `requiredIntents` with the one `tools` field and rewrote
    // every kept version's key the same way (asserted below).
    const since0419 = keys.map((k) => (k === "requiredIntents" ? "tools" : k));
    expect([...since0419].sort()).toEqual([...PLAYBOOK_VERSION_FIELDS].sort());
  });

  it("0419 rewrites a kept version's requiredIntents into tools", () => {
    const sql = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../database/migrations/0419_playbook_tools.sql"
      ),
      "utf8"
    );
    expect(sql).toMatch(/UPDATE "playbook_versions"/);
    expect(sql).toMatch(/"definition" - 'requiredIntents'/);
  });
});
