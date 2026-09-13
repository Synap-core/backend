import { describe, expect, it } from "vitest";
import {
  buildContextActions,
  assertJourneyTransition,
  mergeJourneyProgress,
  planToolsJourneyWrite,
  resolveCompletionCriterion,
  resolveReadiness,
  resolveTemplateVersion,
  restartJourneyProgress,
  shouldCountMeaningfulEntity,
} from "./onboarding.js";

describe("resolveCompletionCriterion", () => {
  it("lets the POD lens complete on finished setup steps with no data", () => {
    expect(
      resolveCompletionCriterion({
        lensKind: "pod",
        meaningfulEntityCount: 0,
        completedActionIds: ["tools"],
      })
    ).toBe("pod-setup-steps-completed");
  });

  it("keeps the data rule for every other lens, and for a pod with no steps", () => {
    expect(
      resolveCompletionCriterion({
        lensKind: "workspace",
        meaningfulEntityCount: 0,
        completedActionIds: ["tools"],
      })
    ).toBeNull();
    expect(
      resolveCompletionCriterion({
        lensKind: "pod",
        meaningfulEntityCount: 0,
        completedActionIds: [],
      })
    ).toBeNull();
    expect(
      resolveCompletionCriterion({
        lensKind: "project",
        meaningfulEntityCount: 2,
        completedActionIds: [],
      })
    ).toBe("meaningful-data-present");
  });
});

describe("planToolsJourneyWrite", () => {
  it("from settings, never creates or activates a journey (no reopened onboarding)", () => {
    expect(planToolsJourneyWrite("settings", undefined)).toBeNull();
    expect(planToolsJourneyWrite("settings", "offered")).toBeNull();
  });

  it("from settings, keeps a live journey's status and current step", () => {
    for (const status of [
      "active",
      "paused",
      "completed",
      "dismissed",
    ] as const) {
      expect(planToolsJourneyWrite("settings", status)).toEqual({
        status,
        setCurrentAction: false,
      });
    }
  });

  it("from onboarding, a new or offered journey becomes active on the tools step", () => {
    expect(planToolsJourneyWrite("onboarding", undefined)).toEqual({
      status: "active",
      setCurrentAction: true,
    });
    expect(planToolsJourneyWrite("onboarding", "offered")).toEqual({
      status: "active",
      setCurrentAction: true,
    });
    expect(planToolsJourneyWrite("onboarding", "completed")).toEqual({
      status: "completed",
      setCurrentAction: true,
    });
  });
});

describe("restartJourneyProgress", () => {
  it("clears steps and the current step, keeps chosen values", () => {
    const restarted = restartJourneyProgress({
      currentActionId: "connect",
      completedActionIds: ["tools", "connect"],
      values: { tools: [{ name: "Notion" }] },
    });
    expect(restarted).toEqual({
      completedActionIds: [],
      values: { tools: [{ name: "Notion" }] },
    });
    // A restart then resumes from whatever step the client names next.
    expect(
      mergeJourneyProgress(restarted, { currentActionId: "tools" })
    ).toEqual({
      currentActionId: "tools",
      completedActionIds: [],
      values: { tools: [{ name: "Notion" }] },
    });
  });
});

describe("assertJourneyTransition", () => {
  it("allows only explicit lifecycle transitions", () => {
    expect(() => assertJourneyTransition(undefined, "active")).not.toThrow();
    expect(() => assertJourneyTransition("active", "paused")).not.toThrow();
    expect(() => assertJourneyTransition("paused", "completed")).not.toThrow();
    expect(() => assertJourneyTransition("dismissed", "active")).not.toThrow();
    expect(() => assertJourneyTransition(undefined, "paused")).toThrow(
      "cannot move"
    );
    expect(() => assertJourneyTransition("dismissed", "completed")).toThrow(
      "cannot move"
    );
    expect(() => assertJourneyTransition("completed", "active")).toThrow(
      "cannot move"
    );
  });
});

describe("resolveReadiness", () => {
  it("uses absent, sparse, and ready without collapsing invalid input", () => {
    expect(resolveReadiness(0)).toBe("absent");
    expect(resolveReadiness(2)).toBe("sparse");
    expect(resolveReadiness(3)).toBe("ready");
    expect(() => resolveReadiness(-1)).toThrow(RangeError);
  });
});

describe("meaningful entity provenance", () => {
  it("excludes only dedicated template scaffolding, not system-authored work", () => {
    expect(
      shouldCountMeaningfulEntity({
        createdByKind: "system",
        systemData: {},
      })
    ).toBe(true);
    expect(
      shouldCountMeaningfulEntity({
        createdByKind: "system",
        systemData: { onboardingScaffold: true },
      })
    ).toBe(false);
    expect(
      shouldCountMeaningfulEntity({
        createdByKind: "human",
        systemData: { onboardingScaffold: true },
      })
    ).toBe(false);
  });
});

describe("mergeJourneyProgress", () => {
  it("keeps completed actions and values when the current action changes", () => {
    expect(
      mergeJourneyProgress(
        {
          currentActionId: "import",
          completedActionIds: ["choose-source"],
          values: { source: "csv" },
        },
        { currentActionId: "map-fields" }
      )
    ).toEqual({
      currentActionId: "map-fields",
      completedActionIds: ["choose-source"],
      values: { source: "csv" },
    });
  });
});

describe("resolveTemplateVersion", () => {
  it("uses the context-owned version and rejects caller drift", () => {
    const workspaceContext = {
      settings: {},
      packageVersion: "0.9.3",
    };

    expect(resolveTemplateVersion(undefined, workspaceContext)).toBe("0.9.3");
    expect(resolveTemplateVersion("0.9.3", workspaceContext)).toBe("0.9.3");
    expect(() =>
      resolveTemplateVersion("caller-controlled", workspaceContext)
    ).toThrow("does not match this context");
    expect(resolveTemplateVersion(undefined, null)).toBe("1");
  });
});

describe("buildContextActions", () => {
  it("makes a configured workspace app the single primary empty-state action", () => {
    const actions = buildContextActions({
      lens: {
        kind: "workspace",
        workspaceId: "55b09e43-87f9-4448-91d1-8d88960378fa",
      },
      readiness: "absent",
      hasOnboardingRecipe: true,
      hasPrimarySurface: true,
      primarySurfaceKind: "app",
    });

    expect(actions.filter((action) => action.placement === "primary")).toEqual([
      expect.objectContaining({ kind: "open_primary_surface" }),
    ]);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "import_data" }),
        expect.objectContaining({ kind: "start_empty" }),
      ])
    );
  });

  it("names an ordinary linked URL as a website, not a workspace app", () => {
    const actions = buildContextActions({
      lens: {
        kind: "workspace",
        workspaceId: "55b09e43-87f9-4448-91d1-8d88960378fa",
      },
      readiness: "absent",
      hasOnboardingRecipe: false,
      hasPrimarySurface: true,
      primarySurfaceKind: "url",
    });

    expect(actions[0]).toEqual(
      expect.objectContaining({
        kind: "open_primary_surface",
        label: "Open linked website",
      })
    );
  });

  it("prioritizes resuming a paused journey", () => {
    const actions = buildContextActions({
      lens: { kind: "pod" },
      readiness: "sparse",
      hasOnboardingRecipe: false,
      hasPrimarySurface: false,
      journeyStatus: "paused",
    });

    expect(actions[0]).toEqual(
      expect.objectContaining({
        kind: "resume_guided_setup",
        placement: "primary",
      })
    );
  });

  it("offers an unprivileged website link when a workspace has no primary surface", () => {
    const actions = buildContextActions({
      lens: {
        kind: "project_workspace",
        projectId: "ef14795d-6072-4bd5-9e14-593329e537b6",
        workspaceId: "55b09e43-87f9-4448-91d1-8d88960378fa",
      },
      readiness: "absent",
      hasOnboardingRecipe: false,
      hasPrimarySurface: false,
    });

    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: "link_website",
        placement: "overflow",
      })
    );
  });

  it("does not render setup actions for a ready context", () => {
    const actions = buildContextActions({
      lens: { kind: "pod" },
      readiness: "ready",
      hasOnboardingRecipe: false,
      hasPrimarySurface: false,
    });

    expect(actions).toEqual([]);
  });
});
