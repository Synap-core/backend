import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";

let answer: unknown = null;
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
    useUtils: () => ({ client: {} }),
  },
}));

import { ViewView } from "./view-view";
import { describeView, viewKind, widgetCount } from "./view-summary";
import { openT } from "../copy";

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
