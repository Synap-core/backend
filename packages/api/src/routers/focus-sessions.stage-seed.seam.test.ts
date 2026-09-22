/**
 * THE SEAM for "start work from a capture" — the SEED must survive the REAL
 * write boundary, and the seeded session must STAY on the Work page.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Relay's `startWorkFromChip` copies a playbook's `stages` VERBATIM onto the
 * capture's live session (`focusSessions.update { stages }`) and deliberately
 * does NOT stamp `playbookId`. Relay's own tests prove what it SENDS. Nothing
 * proved the pod ACCEPTS it, and nothing proved the result is still `work`.
 *
 * Both are ways for this feature to ship green and do nothing, and one of them
 * is not hypothetical: `playbookStageSchema` makes `category` REQUIRED at the
 * write boundary while `PlaybookStage` leaves it optional, so a stored stage
 * from before that rule can be read, rendered and copied — and then rejected
 * wholesale by the door it is copied through. An earlier shape of this very
 * task was already caught being inert on 100% of real playbooks.
 *
 * ── What is REAL here and what is a snapshot ────────────────────────────────
 * The SCHEMA is the real one (`playbookStagesSchema`, the same export
 * `routers/focus-sessions.ts` validates `update.stages` with) and the KIND
 * derivation is the real one (`projectSessionKind`). Neither is re-implemented.
 *
 * The stage arrays are a SNAPSHOT, copied verbatim out of the live pod on
 * 2026-09-21 — every ACTIVE playbook that carries stages, which is the only set
 * `matchForEntity` can ever offer. That is the honest limit: it proves the pod
 * as it stood that day, and it will not notice a playbook authored tomorrow. It
 * is still worth far more than a hand-built stage that "looks like" a real one,
 * because the failure being guarded is precisely the gap between the two.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { playbookStagesSchema } from "../schemas/playbook-stage.js";
import { projectSessionKind } from "../services/focus-sessions/session-kind.js";

/**
 * Verbatim `stages` of every ACTIVE playbook that has any, live pod
 * 2026-09-21. Copied, not paraphrased: a tidied fixture would quietly fix the
 * defect it is meant to detect.
 */
const LIVE_ACTIVE_STAGES: ReadonlyArray<{
  playbook: string;
  stages: unknown[];
}> = [
  {
    playbook: "Dogfood sweep",
    stages: [
      {
        key: "sweep",
        name: "Sweep",
        category: "planned",
        instructions: "Re-read what actually happened this session.",
      },
      {
        key: "classify",
        name: "Classify",
        category: "started",
        instructions: "For each item set finding-class and severity.",
      },
      {
        key: "dedup",
        name: "Dedup against open findings",
        category: "started",
        instructions: "Check startHere.openFindings first.",
      },
      {
        key: "file",
        name: "File with verbatim evidence",
        category: "started",
        instructions: "Create one `finding` entity per item.",
      },
      {
        key: "handoff",
        name: "Handoff",
        category: "completed",
        instructions: "Report to the human.",
      },
    ],
  },
  {
    playbook: "Lead → qualified (discovery)",
    stages: [
      {
        key: "sourced",
        goal: "A person entity with the lead facet.",
        name: "Sourced",
        category: "backlog",
        position: 1,
        description: "Lead found.",
        suggestedTasks: [
          "Record where this lead came from",
          "Link person to company via works_at",
        ],
      },
      {
        key: "enriched",
        goal: "Role confirmed.",
        name: "Enriched",
        category: "planned",
        position: 1,
        description: "Enough context.",
        suggestedTasks: ["Confirm decision authority"],
      },
      {
        key: "contacted",
        goal: "Outreach sent.",
        name: "Contacted",
        category: "started",
        position: 1,
        indefinite: false,
        description: "First touch sent.",
        suggestedTasks: ["Send first touch"],
      },
      {
        key: "in_discovery",
        goal: "The seven discovery questions answered.",
        name: "In discovery",
        category: "started",
        position: 2,
        description: "Call booked or held.",
        suggestedTasks: ["Run the segment's discovery guide"],
      },
      {
        key: "qualified",
        goal: "A deal entity exists.",
        name: "Qualified",
        category: "started",
        position: 3,
        description: "Meets all four bar criteria.",
        suggestedTasks: ["Create the deal"],
      },
      {
        key: "disqualified",
        goal: "Reason recorded.",
        name: "Disqualified",
        category: "canceled",
        position: 1,
        description: "Failed the bar.",
        suggestedTasks: ["Record the disqualification reason"],
      },
    ],
  },
  {
    playbook: "Client Onboarding → Pod Provisioning",
    stages: [
      {
        key: "diagnose",
        name: "Diagnose Information Architecture",
        category: "started",
      },
      {
        key: "provision",
        name: "Provision the Synap Pod",
        category: "started",
      },
      { key: "configure", name: "Configure and Populate", category: "started" },
      { key: "handoff", name: "Handoff Portal + MCP", category: "started" },
    ],
  },
  {
    playbook: "GRP Deprecation Check",
    stages: [
      { key: "detect_impact", name: "Detect Impact", category: "started" },
      { key: "notify_owners", name: "Notify Owners", category: "started" },
      { key: "plan_update", name: "Plan Update", category: "started" },
      { key: "verify", name: "Verify Resolution", category: "started" },
    ],
  },
  {
    playbook: "Diag Data IA Delivery",
    stages: [
      { key: "kickoff", name: "Kickoff", category: "started" },
      { key: "mapping", name: "Data + Use-Case Mapping", category: "started" },
      { key: "assessment", name: "Maturity Assessment", category: "started" },
      { key: "roadmap", name: "12-24 Month Roadmap", category: "started" },
      {
        key: "investment_plan",
        name: "Costed Investment Plan",
        category: "started",
      },
      { key: "validate", name: "Bpifrance Validation", category: "started" },
    ],
  },
  {
    playbook: "GRP Business Model Interrogation",
    stages: [
      {
        key: "understand_intent",
        name: "Understand the Intent",
        category: "started",
      },
      {
        key: "propose_structure",
        name: "Propose the GRP Structure",
        category: "started",
      },
      {
        key: "confirm_and_create",
        name: "Confirm and Create",
        category: "started",
      },
    ],
  },
  {
    playbook: "Market Research Sprint",
    stages: [
      { key: "discover", name: "Discover", category: "started" },
      { key: "triage", name: "Triage Sources", category: "started" },
      { key: "synthesize", name: "Synthesize Findings", category: "started" },
      { key: "decide", name: "Decide and Record", category: "started" },
    ],
  },
  {
    playbook: "[dogfood 2026-09-12] Stage Gate Probe",
    stages: [
      { key: "intake", name: "Intake", category: "planned", position: 0 },
      {
        key: "plan",
        gate: { kind: "human" },
        name: "Plan",
        category: "planned",
        position: 1,
      },
    ],
  },
  {
    playbook: "AI Dev Session",
    stages: [
      {
        key: "brainstorming",
        name: "Brainstorming",
        category: "planned",
        position: 0,
        description: "Explore the problem.",
        suggestedTasks: ['synap ask "<area> gotchas" (recall)'],
      },
      {
        key: "validating",
        name: "Validating",
        category: "planned",
        position: 1,
        description: "Validate the infra.",
        suggestedTasks: ["check prior art"],
      },
      {
        key: "planning",
        name: "Planning",
        category: "planned",
        position: 2,
        description: "Plan the changes.",
        suggestedTasks: ["plan skill"],
      },
      {
        key: "in-work",
        name: "In work",
        category: "started",
        position: 0,
        description: "Build in small verified waves.",
        suggestedTasks: ["verified-wave"],
      },
      {
        key: "verifying",
        name: "Verifying",
        category: "started",
        position: 1,
        description: "Run the gates YOURSELF.",
        suggestedTasks: ["run gates + quote evidence"],
      },
      {
        key: "finishing",
        name: "Finishing",
        category: "completed",
        position: 0,
        description: "Capture lessons.",
        suggestedTasks: ["capture lessons (engineering-memory)"],
      },
    ],
  },
];

describe("a real playbook's phases survive the real update door", () => {
  it("the snapshot is non-vacuous — it holds every active stage-carrying playbook", () => {
    // A fixture list that silently emptied would pass every `it.each` below.
    expect(LIVE_ACTIVE_STAGES.length).toBe(9);
    const total = LIVE_ACTIVE_STAGES.reduce((n, p) => n + p.stages.length, 0);
    expect(total).toBe(40);
  });

  it.each(LIVE_ACTIVE_STAGES.map((p) => [p.playbook, p.stages] as const))(
    "%s: its stages parse UNMODIFIED through playbookStagesSchema",
    (_name, stages) => {
      const parsed = playbookStagesSchema.safeParse(stages);
      // Print the door's own complaint rather than a bare `false`.
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.success).toBe(true);
    }
  );

  it("the pass-through keeps the fields nothing renders yet", () => {
    // Relay copies stages WHOLE rather than projecting to {key,name}. If the
    // schema stripped, an agent working the session would lose what it is FOR.
    const aiDev = LIVE_ACTIVE_STAGES.find(
      (p) => p.playbook === "AI Dev Session"
    )!;
    const parsed = playbookStagesSchema.parse(aiDev.stages) as Array<
      Record<string, unknown>
    >;
    expect(parsed[0].suggestedTasks).toEqual([
      'synap ask "<area> gotchas" (recall)',
    ]);
    expect(parsed[0].description).toBe("Explore the problem.");
    const sweep = LIVE_ACTIVE_STAGES[0];
    // `instructions` is not even a declared key — the looseObject must keep it.
    expect(
      (
        playbookStagesSchema.parse(sweep.stages) as Array<
          Record<string, unknown>
        >
      )[0].instructions
    ).toBe("Re-read what actually happened this session.");
  });

  it("a LEGACY category-less stage is REFUSED — the door's limit, stated", () => {
    // This is not a wish; it is the measured boundary of the seed. Relay's
    // `readSeedableStages` filters on `key` only, so a pre-`category` stage
    // reaches the door and the WHOLE update 400s. One archived playbook on the
    // pod is in this shape ("TEST — provenance verification"), and archived
    // playbooks are never offered — which is why this is a limit, not a defect.
    const legacy = [
      { key: "verify", goal: "Confirm provenance columns", name: "Verify" },
    ];
    const parsed = playbookStagesSchema.safeParse(legacy);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual([0, "category"]);
  });
});

describe("the seeded session stays the person's WORK", () => {
  it("stages + no playbookId ⇒ work, which is the whole point of the design", () => {
    expect(
      projectSessionKind({
        status: "active",
        origin: "human",
        playbookId: null,
        metadata: {},
      })
    ).toBe("work");
  });

  it("the control: the same row WITH a playbookId leaves the work list", () => {
    // Proves the assertion above is discriminating rather than a tautology —
    // `playbookId` is the one field that flips it, and it is the field this
    // door refuses to write.
    expect(
      projectSessionKind({
        status: "active",
        origin: "human",
        playbookId: "11111111-1111-1111-1111-111111111111",
        metadata: {},
      })
    ).toBe("run");
  });
});

/**
 * The declared-but-unwritten defect: a field on the wire that nobody persists.
 *
 * Scanned on the router SOURCE with comments stripped, because the docblock on
 * the input names `stages` at length and a scan that read prose would pass on
 * documentation alone. Resolved from `import.meta.url`, never `cwd`.
 *
 * WHAT IT DOES NOT COVER, measured: it proves the two lines EXIST, not that the
 * mutation reaches Postgres — there is no database in this gate. The execution
 * proof is the dogfood pass.
 */
describe("the update door both ACCEPTS and PERSISTS stages", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./focus-sessions.ts", import.meta.url)),
    "utf8"
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  it("the scan is non-vacuous — it read the router and strips prose, not code", () => {
    expect(source.length).toBeGreaterThan(50_000);
    expect(code).toContain("export const focusSessionsRouter");
    // Self-check: the header prose mentions migration 0270; the code does not.
    expect(source).toContain("migration 0270");
    expect(code).not.toContain("migration 0270");
  });

  it("declares `stages` on the input, validated by the shared stage schema", () => {
    expect(code).toContain("stages: playbookStagesSchema.optional()");
  });

  it("WRITES it — a declared field nobody assigns is this repo's signature bug", () => {
    expect(code).toContain(
      "if (patch.stages !== undefined) set.stages = patch.stages;"
    );
  });
});
