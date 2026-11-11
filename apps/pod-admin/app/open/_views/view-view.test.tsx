import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";

let answer: unknown = null;
/** What `flow.of` answers: the flow, a failure, or still loading. */
let flowRead: { data?: unknown; error?: unknown; isLoading?: boolean } = {};
vi.mock("../../../lib/trpc", () => ({
  trpc: {
    views: {
      get: {
        useQuery: () => ({
          data: answer,
          error: null,
          isLoading: false,
          refetch: () => {},
        }),
      },
    },
    flow: {
      of: {
        useQuery: () => ({
          data: undefined,
          error: null,
          isLoading: false,
          refetch: () => {},
          ...flowRead,
        }),
      },
    },
    useUtils: () => ({ client: {} }),
  },
}));

import { ViewView } from "./view-view";
import { describeView, viewKind, widgetCount } from "./view-summary";
import { pipelineSnapshot, type FlowLike } from "./view-pipeline-model";
import { openT } from "../copy";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const ID_D = "44444444-4444-4444-8444-444444444444";

const state = (
  key: string,
  label: string,
  order: number,
  count: number,
  cards: { id: string; name: string | null }[] = [],
  extra: Record<string, unknown> = {}
) => ({
  key,
  label,
  order,
  count,
  stuck: null,
  windowed: false,
  cards,
  ...extra,
});

/** Arrives SHUFFLED on purpose: the lifecycle's `order` is the only order. */
const FLOW: FlowLike = {
  states: [
    state("fixed", "Fixed", 2, 188),
    state("open", "Open", 0, 729, [
      { id: ID_A, name: "Run recipe refusal says nothing" },
      { id: ID_B, name: null },
      { id: ID_C, name: "Third card" },
      { id: ID_D, name: "Fourth card" },
    ]),
    state("fixing", "Fixing", 1, 4, [], { stuck: 2 }),
    state("verified", "Verified", 3, 11, [], { windowed: true }),
  ],
  unclassified: { count: 5 },
  totals: { total: 937 },
  window: { days: 30 },
};

const view = (over: Record<string, unknown>) => ({
  view: {
    id: "v1",
    name: "Finding pipeline",
    type: "pipeline",
    description: null,
    workspaceId: "w1",
    updatedAt: null,
    config: { profileSlug: "finding" },
    ...over,
  },
});

/** The same widget list `propose_app_from_playbook` files for a dashboard. */
const BLOCKS = ["count", "by-state", "funnel", "recent"].map((id) => ({
  id,
  kind: "widget",
  config: { profileSlug: "finding" },
}));

describe("/open/view: a view pod admin does not draw", () => {
  beforeEach(() => setAmbientCatalogLocale("en"));

  it("a generated pipeline says what it shows, and that it opens in the app", () => {
    answer = view({});
    const out = renderToStaticMarkup(<ViewView id="v1" />);
    expect(out).toContain("Finding by state, one column per state.");
    expect(out).toContain("This view is worked in the Synap app");
    expect(out).toContain("Open view in the app");
  });

  it("the hand-off is ONE primary action, not a corner link beside a card", () => {
    answer = view({});
    const out = renderToStaticMarkup(<ViewView id="v1" />);
    expect(out.split("Open view in the app").length - 1).toBe(1);
    expect(out).not.toContain(">Open in app<");
  });

  it("a generated dashboard counts its widgets and names its kind", () => {
    answer = view({
      name: "Fix a finding dashboard",
      type: "bento",
      config: { blocks: BLOCKS },
    });
    const out = renderToStaticMarkup(<ViewView id="v1" />);
    expect(out).toContain("A dashboard of 4 widgets over Finding.");
  });

  it("a written description still wins over the derived sentence", () => {
    answer = view({ description: "What the team triages each Monday." });
    const out = renderToStaticMarkup(<ViewView id="v1" />);
    expect(out).toContain("What the team triages each Monday.");
    expect(out).not.toContain("by state, one column per state");
    expect(out).toContain("This view is worked in the Synap app");
  });

  it("the words follow the locale", () => {
    setAmbientCatalogLocale("fr");
    try {
      answer = view({});
      const out = renderToStaticMarkup(<ViewView id="v1" />);
      expect(out).toContain("Finding par état, une colonne par état.");
      expect(out).toContain("Ouvrir la vue dans l’application");
      expect(out).not.toContain("Open view in the app");
    } finally {
      setAmbientCatalogLocale("en");
    }
  });
});

describe("/open/view: a pipeline's read-only snapshot", () => {
  beforeEach(() => {
    setAmbientCatalogLocale("en");
    flowRead = { data: FLOW };
  });

  it("draws the declared states in the lifecycle's order, not the order they arrive in", () => {
    answer = view({});
    const out = renderToStaticMarkup(<ViewView id="v1" />);
    const at = (label: string) => out.indexOf(`>${label}<`);
    expect(at("Open")).toBeGreaterThan(-1);
    expect(at("Open")).toBeLessThan(at("Fixing"));
    expect(at("Fixing")).toBeLessThan(at("Fixed"));
    expect(at("Fixed")).toBeLessThan(at("Verified"));
  });

  it("counts are exact; the cards are a capped sample that says how many it left out", () => {
    answer = view({});
    const out = renderToStaticMarkup(<ViewView id="v1" />);
    expect(out).toContain(">729<");
    expect(out).toContain("Run recipe refusal says nothing");
    expect(out).toContain("Third card");
    expect(out).not.toContain("Fourth card");
    expect(out).toContain("+726 more");
    expect(out).toContain("Untitled");
  });

  it("each card is a door to its own page", () => {
    answer = view({});
    const out = renderToStaticMarkup(<ViewView id="v1" />);
    expect(out).toContain(`href="/open/entity/${ID_A}"`);
  });

  it("marks stuck, a windowed count and what sits in no declared state", () => {
    answer = view({});
    const out = renderToStaticMarkup(<ViewView id="v1" />);
    expect(out).toContain("2 stuck");
    expect(out).toContain("last 30 days");
    expect(out).toContain("937 in total");
    expect(out).toContain("5 in no declared state");
  });

  it("says it is a read-only summary and still hands off to the app", () => {
    answer = view({});
    const out = renderToStaticMarkup(<ViewView id="v1" />);
    expect(out).toContain("read-only summary");
    expect(out).toContain("Open view in the app");
  });

  it("a FAILED read says it failed; it is never drawn as an empty pipeline", () => {
    answer = view({});
    flowRead = { data: undefined, error: new Error("boom") };
    const out = renderToStaticMarkup(<ViewView id="v1" />);
    expect(out).toContain("This pipeline couldn’t be read.");
    expect(out).not.toContain("Nothing in this pipeline yet.");
    expect(out).not.toContain("boom");
  });

  it("an empty pipeline says so, and a read in flight says it is loading", () => {
    answer = view({});
    flowRead = {
      data: { ...FLOW, states: [], unclassified: null, totals: { total: 0 } },
    };
    expect(renderToStaticMarkup(<ViewView id="v1" />)).toContain(
      "Nothing in this pipeline yet."
    );
    flowRead = { isLoading: true };
    const out = renderToStaticMarkup(<ViewView id="v1" />);
    expect(out).toContain("Loading this pipeline…");
    expect(out).not.toContain("couldn’t be read");
  });

  it("only a pipeline gets one: a dashboard, or a pipeline naming no kind, is handed over alone", () => {
    answer = view({ type: "bento", config: { blocks: BLOCKS } });
    const dash = renderToStaticMarkup(<ViewView id="v1" />);
    expect(dash).not.toContain(">By state<");
    expect(dash).toContain("does not draw boards");
    expect(dash).not.toContain("read-only summary");

    answer = view({ config: {} });
    const nameless = renderToStaticMarkup(<ViewView id="v1" />);
    expect(nameless).not.toContain(">By state<");
    expect(nameless).toContain("does not draw boards");
  });

  it("the snapshot's words follow the locale", () => {
    setAmbientCatalogLocale("fr");
    try {
      answer = view({});
      const out = renderToStaticMarkup(<ViewView id="v1" />);
      expect(out).toContain("Par état");
      expect(out).toContain("2 bloqués");
      expect(out).toContain("937 au total");
      expect(out).not.toContain("2 stuck");
    } finally {
      setAmbientCatalogLocale("en");
    }
  });
});

describe("pipelineSnapshot: the model under the snapshot", () => {
  it("sorts by declared order and never mutates what it was given", () => {
    const before = FLOW.states.map((s) => s.key).join();
    const rows = pipelineSnapshot(FLOW).rows.map((r) => r.key);
    expect(rows).toEqual(["open", "fixing", "fixed", "verified"]);
    expect(FLOW.states.map((s) => s.key).join()).toBe(before);
  });

  it("zero stuck is not a mark, and a live state has no window", () => {
    const zero: FlowLike = {
      ...FLOW,
      states: [state("open", "Open", 0, 3, [], { stuck: 0 })],
    };
    const [row] = pipelineSnapshot(zero).rows;
    expect(row?.stuck).toBeNull();
    expect(row?.windowDays).toBeNull();
  });

  it("is empty only when nothing is in any state AND nothing sits outside one", () => {
    const none: FlowLike = {
      states: [],
      unclassified: null,
      totals: { total: 0 },
      window: { days: 30 },
    };
    expect(pipelineSnapshot(none).empty).toBe(true);
    expect(
      pipelineSnapshot({ ...none, unclassified: { count: 2 } }).empty
    ).toBe(false);
  });
});

describe("describeView: only what the row carries", () => {
  const t = () => openT();
  beforeEach(() => setAmbientCatalogLocale("en"));

  it("takes the kind from the first widget that names one", () => {
    expect(
      viewKind({
        blocks: [{ config: {} }, { config: { profileSlug: "deal" } }],
      })
    ).toBe("deal");
  });

  it("never invents a kind: a dashboard that names none says only its size", () => {
    expect(
      describeView({ type: "bento", config: { blocks: [{ config: {} }] } }, t())
    ).toBe("A dashboard of 1 widget.");
    expect(widgetCount({ blocks: [{}, {}] })).toBe(2);
  });

  it("a pipeline that names no kind falls to the plain layout sentence", () => {
    expect(describeView({ type: "pipeline", config: {} }, t())).toBe(
      "Pipeline view."
    );
  });

  it("a view with no layout and no config is still a sentence, never blank", () => {
    expect(describeView({}, t())).toBe("A saved view.");
    expect(describeView({ type: null, config: "not an object" }, t())).toBe(
      "A saved view."
    );
  });
});
