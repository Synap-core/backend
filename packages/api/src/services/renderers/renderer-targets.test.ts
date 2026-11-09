/**
 * The renderer TARGET vocabulary — what each door reads its target from, and
 * the one rule for which slot and scope a target has.
 */
import { describe, expect, it } from "vitest";

import {
  RENDERER_TARGETS,
  isPerObjectBindingKind,
  readRendererTarget,
  rendererTargetProblem,
} from "./renderer-targets.js";
import { withCapabilityPage } from "../capabilities/bind-capability-renderer.js";

describe("readRendererTarget", () => {
  it("reads target {kind, id}, target {kind:'profile', slug}, and the older profileSlug", () => {
    expect(
      readRendererTarget({ target: { kind: "playbook", id: " p-1 " } })
    ).toEqual({
      kind: "playbook",
      id: "p-1",
    });
    expect(
      readRendererTarget({ target: { kind: "profile", slug: "deal" } })
    ).toEqual({
      kind: "profile",
      slug: "deal",
    });
    expect(readRendererTarget({ profileSlug: "deal" })).toEqual({
      kind: "profile",
      slug: "deal",
    });
  });

  it("answers with a sentence when the target cannot be read", () => {
    expect(readRendererTarget({})).toMatch(/target \{kind, id\}/);
    expect(
      readRendererTarget({
        profileSlug: "deal",
        target: { kind: "view", id: "v" },
      })
    ).toMatch(/not both/);
    expect(
      readRendererTarget({ target: { kind: "automation", id: "a" } })
    ).toMatch(/must be one of: profile, capability, playbook, view/);
    expect(readRendererTarget({ target: { kind: "view" } })).toMatch(
      /needs id/
    );
    expect(readRendererTarget({ target: { kind: "profile" } })).toMatch(
      /needs slug/
    );
  });
});

describe("rendererTargetProblem", () => {
  it("a profile keeps all four slots; a playbook and a view have detail only", () => {
    for (const slot of ["list", "detail", "card", "dashboard"]) {
      expect(rendererTargetProblem("profile", slot, "workspace")).toBeNull();
    }
    expect(rendererTargetProblem("playbook", "detail", "pod")).toBeNull();
    expect(rendererTargetProblem("view", "dashboard", "pod")).toMatch(
      /Its slots: detail/
    );
  });

  it("a capability has detail and dashboard, and no personal scope", () => {
    expect(
      rendererTargetProblem("capability", "dashboard", "workspace")
    ).toBeNull();
    expect(rendererTargetProblem("capability", "detail", "user")).toMatch(
      /Its scopes: workspace, pod/
    );
  });
});

describe("isPerObjectBindingKind", () => {
  it("is exactly the per-object targets stored in renderer_bindings", () => {
    const expected = Object.entries(RENDERER_TARGETS)
      .filter(
        ([, d]) => d.subject === "object" && d.store === "renderer_bindings"
      )
      .map(([k]) => k)
      .sort();
    expect(expected).toEqual(["playbook", "view"]);
    for (const k of expected) expect(isPerObjectBindingKind(k)).toBe(true);
    for (const k of [
      "capability",
      "profile",
      "task",
      "proposal",
      "constructor",
    ]) {
      expect(isPerObjectBindingKind(k)).toBe(false);
    }
  });
});

describe("withCapabilityPage", () => {
  const ref = (cellKey: string) => ({
    kind: "cell" as const,
    cellKey,
    props: {},
  });
  it("replaces the page under its slot in place, keeping its title", () => {
    const pages = [
      { slot: "detail", title: "Mine", ref: ref("a") },
      { slot: "dashboard", title: "Dash", ref: ref("b") },
    ];
    expect(withCapabilityPage(pages, "detail", ref("c"))).toEqual([
      { slot: "detail", title: "Mine", ref: ref("c") },
      { slot: "dashboard", title: "Dash", ref: ref("b") },
    ]);
  });
  it("appends a new page titled from its slot, and removes one with null", () => {
    expect(withCapabilityPage([], "dashboard", ref("a"))).toEqual([
      { slot: "dashboard", title: "Dashboard", ref: ref("a") },
    ]);
    expect(
      withCapabilityPage(
        [{ slot: "detail", title: "D", ref: ref("a") }],
        "detail",
        null
      )
    ).toEqual([]);
  });
});
