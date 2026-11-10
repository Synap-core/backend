/**
 * The bundle a playbook's UI is proposed as, built from FACTS (pure half of
 * `propose-app-from-playbook.ts`), for a REAL catalog playbook (CRM "Win a
 * deal" over `deal`):
 *
 *   - four parts: the kind's pipeline, a bento over the kind, the generated
 *     board cell, the board on the playbook's own page;
 *   - the pipeline carries ONLY the kind (its columns are the declared
 *     lifecycle, read at render time): no state is spelled in it;
 *   - every bento widget passes the arrange gate (`renderableArrangeError`, the
 *     check `synap_update_view` runs) and the view config schema, and groups by
 *     the lifecycle property the kind declares;
 *   - the composite passes the plan validator a revision runs;
 *   - idempotent: what exists is not proposed again, a page that shows
 *     something else is never replaced, an existing cell is bound by its key.
 *
 * The filing (governance preview, the pending row, dedup) and the approval
 * are driven for real in `build.propose-app-from-playbook.pglite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { validateViewConfig } from "@synap-core/types";
import { validatePlanOperations } from "../capture-agent/capture-plan.js";
import { renderableArrangeError } from "../cells/renderables.js";
import {
  buildPlaybookAppOperations,
  ownedStatesOf,
  playbookAppSummary,
  PLAYBOOK_APP_REFS,
  type ExistingPlaybookApp,
  type PlaybookAppFacts,
} from "./propose-app-from-playbook.js";
import {
  DEAL_LIFECYCLE,
  WIN_A_DEAL_ID,
  WIN_A_DEAL_STAGES,
} from "./__fixtures__/crm-win-a-deal.js";

const WS = "3c9d2e1f-4a5b-4c6d-8e7f-a0b1c2d3e4f5";

const FACTS: PlaybookAppFacts = {
  playbook: { id: WIN_A_DEAL_ID, name: "Win a deal" },
  workspaceId: WS,
  kind: {
    slug: "deal",
    label: "Deal",
    plural: "Deals",
    property: DEAL_LIFECYCLE.property,
    states: DEAL_LIFECYCLE.options.map((o) => ({ ...o })),
  },
  owned: ownedStatesOf(WIN_A_DEAL_STAGES),
};

const NOTHING: ExistingPlaybookApp = {
  pipelineViewId: null,
  bentoViewId: null,
  cellKey: null,
  bound: null,
};

describe("a playbook's UI bundle, from facts", () => {
  it("reads the states the playbook's stages own, in stage order", () => {
    expect(FACTS.owned).toEqual([
      { state: "draft", stageKey: "qualify", stageName: "Qualify" },
      { state: "proposed", stageKey: "send", stageName: "Send proposal" },
      { state: "negotiating", stageKey: "negotiate", stageName: "Negotiate" },
      { state: "won", stageKey: "won", stageName: "Won" },
    ]);
  });

  it("proposes the four parts, each through its op, with refs that address them", () => {
    const plan = buildPlaybookAppOperations(FACTS, NOTHING);
    expect(plan.parts).toEqual(["pipeline", "bento", "cell", "binding"]);
    expect(plan.operations.map((o) => o.op)).toEqual([
      "create_view",
      "create_view",
      "create_cell",
      "bind_renderer",
    ]);
    expect(plan.alreadyExists).toEqual([]);
    expect(plan.leftOut).toEqual([]);
    expect(
      validatePlanOperations(plan.operations, { workspaceId: WS })
    ).toEqual([]);
    const [pipeline, bento, cell, binding] = plan.operations;
    expect(pipeline).toMatchObject({
      viewType: "pipeline",
      workspaceId: WS,
      scopeProfileSlugs: ["deal"],
      config: { profileSlug: "deal" },
    });
    // Its columns are the declaration, read when it renders: no state here.
    for (const o of DEAL_LIFECYCLE.options) {
      expect(JSON.stringify(pipeline)).not.toContain(`"${o.key}"`);
    }
    expect(bento).toMatchObject({ viewType: "bento", workspaceId: WS });
    expect(cell).toMatchObject({
      ref: PLAYBOOK_APP_REFS.cell,
      workspaceId: WS,
      contentKind: "entity-detail",
    });
    expect((cell as { rendererSource: string }).rendererSource).toContain(
      JSON.stringify(WIN_A_DEAL_ID)
    );
    expect(binding).toEqual({
      op: "bind_renderer",
      ref: PLAYBOOK_APP_REFS.binding,
      target: { kind: "playbook", id: WIN_A_DEAL_ID },
      slot: "detail",
      scope: "workspace",
      workspaceId: WS,
      cellRef: PLAYBOOK_APP_REFS.cell,
    });
  });

  it("the views pass their config schema, and every bento widget the arrange gate", () => {
    const plan = buildPlaybookAppOperations(FACTS, NOTHING);
    const views = plan.operations.filter(
      (o): o is Extract<typeof o, { op: "create_view" }> =>
        o.op === "create_view"
    );
    for (const v of views) {
      expect(validateViewConfig(v.viewType, v.config ?? {}).valid, v.ref).toBe(
        true
      );
    }
    const blocks = views[1]!.config!.blocks as Array<{
      widgetType: string;
      config: Record<string, unknown>;
    }>;
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const b of blocks) {
      expect(
        renderableArrangeError(b.widgetType, b.config, new Map())
      ).toBeNull();
      expect(b.config.profileSlug).toBe("deal");
    }
    // Grouped by the property the kind DECLARES, never a guessed `status`.
    const grouped = blocks.flatMap((b) =>
      [b.config.groupBy, b.config.stageField].filter(Boolean)
    );
    expect(grouped.length).toBeGreaterThan(0);
    expect(new Set(grouped)).toEqual(new Set([DEAL_LIFECYCLE.property]));
  });

  it("says what it proposes in one line a reviewer reads", () => {
    expect(
      playbookAppSummary(FACTS, ["pipeline", "bento", "cell", "binding"])
    ).toBe(
      `UI for "Win a deal": the Deals pipeline (5 states), a dashboard, a board drawn live from the flow, the board on the playbook's page`
    );
  });
});

describe("a second run: idempotent", () => {
  it("proposes nothing when every part exists", () => {
    const plan = buildPlaybookAppOperations(FACTS, {
      pipelineViewId: "v-pipe",
      bentoViewId: "v-bento",
      cellKey: "generated:win-a-deal-board",
      bound: { source: "workspace", cellKey: "generated:win-a-deal-board" },
    });
    expect(plan.operations).toEqual([]);
    expect(plan.alreadyExists.map((e) => e.part)).toEqual([
      "pipeline",
      "bento",
      "cell",
      "binding",
    ]);
  });

  it("binds an existing cell by its key, and never replaces a page that shows another", () => {
    const reuse = buildPlaybookAppOperations(FACTS, {
      ...NOTHING,
      cellKey: "generated:win-a-deal-board",
    });
    expect(reuse.operations.map((o) => o.op)).toEqual([
      "create_view",
      "create_view",
      "bind_renderer",
    ]);
    expect(reuse.operations[2]).toMatchObject({
      cellKey: "generated:win-a-deal-board",
    });
    expect(reuse.operations[2]).not.toHaveProperty("cellRef");

    const taken = buildPlaybookAppOperations(FACTS, {
      ...NOTHING,
      bound: { source: "workspace", cellKey: "generated:someone-elses" },
    });
    expect(taken.operations.map((o) => o.op)).not.toContain("bind_renderer");
    expect(taken.leftOut).toHaveLength(1);
    expect(taken.leftOut[0]!.reason).toContain("generated:someone-elses");
    expect(taken.leftOut[0]!.reason).toContain(
      "synap_promote_cell_to_renderer"
    );
  });
});
