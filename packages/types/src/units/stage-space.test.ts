/**
 * The ONE step → space rule. Fixture rows sit where candidate rules DISAGREE:
 *   - a space stamped only in `settings` (a column-only reader calls it missing);
 *   - a column that differs from the stamp (a settings-first reader picks the
 *     stamp; the pod's coalesce picks the column);
 *   - a template installed twice with the project using the SECOND (a
 *     "first match" rule ignores the project);
 *   - an unread list (a reader folding "unread" into "none" claims missing).
 */
import { describe, expect, it } from "vitest";
import {
  pickStageSpace,
  resolveStageSpace,
  workspaceTemplateSlug,
} from "./stage-space.js";

describe("workspaceTemplateSlug — the column, else settings.packageSlug", () => {
  it("reads the column first, the settings stamp only when the column is absent", () => {
    expect(
      workspaceTemplateSlug({
        packageSlug: "crm",
        settings: { packageSlug: "old" },
      })
    ).toBe("crm");
    expect(
      workspaceTemplateSlug({
        packageSlug: null,
        settings: { packageSlug: "crm" },
      })
    ).toBe("crm");
    expect(workspaceTemplateSlug({ settings: { packageSlug: "crm" } })).toBe(
      "crm"
    );
    expect(workspaceTemplateSlug({ settings: null })).toBeNull();
    expect(workspaceTemplateSlug({})).toBeNull();
  });

  it("never narrows the slug to a known set", () => {
    expect(
      workspaceTemplateSlug({ packageSlug: "some-community-template" })
    ).toBe("some-community-template");
  });
});

describe("pickStageSpace — a used space wins, else the first listed", () => {
  it("prefers the used candidate even when it is not first", () => {
    expect(pickStageSpace(["a", "b"], new Set(["b"]))).toEqual({
      id: "b",
      alreadyUsed: true,
    });
    expect(pickStageSpace(["a", "b"], new Set(["z"]))).toEqual({
      id: "a",
      alreadyUsed: false,
    });
    expect(pickStageSpace([], new Set(["a"]))).toBeNull();
  });
});

describe("resolveStageSpace — a step's space for a reader", () => {
  const spaces = [
    { id: "w1", name: "CRM", packageSlug: "crm" },
    {
      id: "w2",
      name: "CRM (EU)",
      packageSlug: null,
      settings: { packageSlug: "crm" },
    },
    {
      id: "w3",
      name: "Finance",
      packageSlug: "finance",
      settings: { packageSlug: "legacy-fin" },
    },
    { id: "w4", name: null, settings: { packageSlug: "radar" } },
  ];

  it("no domain ⇒ OMIT", () => {
    expect(resolveStageSpace(undefined, spaces)).toBeNull();
    expect(resolveStageSpace("  ", spaces)).toBeNull();
  });

  it("the project's used space wins over the first installed", () => {
    expect(resolveStageSpace("crm", spaces)).toEqual({
      kind: "space",
      id: "w1",
      name: "CRM",
    });
    expect(resolveStageSpace("crm", spaces, new Set(["w2"]))).toEqual({
      kind: "space",
      id: "w2",
      name: "CRM (EU)",
    });
  });

  it("a settings-only space resolves; a column beats a differing stamp", () => {
    expect(resolveStageSpace("radar", spaces)).toEqual({
      kind: "space",
      id: "w4",
      name: "Radar",
    });
    expect(resolveStageSpace("finance", spaces)).toMatchObject({ id: "w3" });
    expect(resolveStageSpace("legacy-fin", spaces)).toEqual({
      kind: "missing",
      label: "Legacy fin",
    });
  });

  it("nothing installed says so; an unread list says nothing", () => {
    expect(resolveStageSpace("legal", spaces)).toEqual({
      kind: "missing",
      label: "Legal",
    });
    expect(resolveStageSpace("crm", null)).toBeNull();
  });
});
