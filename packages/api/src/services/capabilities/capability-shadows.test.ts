/**
 * `classifyShadows` — the ONE definition of a stale copy, pure.
 *
 * Fixture = the live pod of 2026-09-24: a Builder-scoped `google` tool and
 * approved CODE skills (`calendar_list`, `gmail_search`) from before the pack
 * consolidation, beside the "Nango — Google Workspace" pack's pod-wide tool and
 * declarative skills. The old generation belongs to no pack.
 */
import { describe, it, expect } from "vitest";
import { classifyShadows, type ShadowInputs } from "./capability-shadows.js";

const PACK = "54c9e3e1-642a-4080-bf4e-ab9e0b57784d";
const BUILDER = "808939d1-86b3-4c52-a153-ae06ece2c54e";

function livePod(): ShadowInputs {
  return {
    containers: [{ id: PACK, name: "Nango — Google Workspace" }],
    members: [
      { fromType: "tool", fromId: "tool-live", toId: PACK },
      { fromType: "skill", fromId: "cal-live", toId: PACK },
      { fromType: "skill", fromId: "gmail-live", toId: PACK },
      { fromType: "skill", fromId: "contacts-live", toId: PACK },
    ],
    tools: [
      { id: "tool-live", name: "google", workspaceId: null },
      { id: "tool-old", name: "google", workspaceId: BUILDER },
      // An unrelated tool in no pack, with a name no pack uses: not a shadow.
      { id: "tool-own", name: "my-webhook", workspaceId: BUILDER },
    ],
    skills: [
      {
        id: "cal-live",
        name: "calendar_list",
        workspaceId: null,
        kind: "declarative",
        approved: false,
      },
      {
        id: "gmail-live",
        name: "gmail_search",
        workspaceId: null,
        kind: "declarative",
        approved: false,
      },
      {
        id: "contacts-live",
        name: "contacts_list",
        workspaceId: null,
        kind: "declarative",
        approved: false,
      },
      {
        id: "cal-old",
        name: "calendar_list",
        workspaceId: BUILDER,
        kind: "code",
        approved: true,
      },
      {
        id: "gmail-old",
        name: "gmail_search",
        workspaceId: BUILDER,
        kind: "code",
        approved: true,
      },
      // A user's own skill in no pack: not a shadow of anything.
      {
        id: "own",
        name: "summarize_week",
        workspaceId: BUILDER,
        kind: "code",
        approved: true,
      },
    ],
  };
}

describe("classifyShadows", () => {
  it("finds exactly the old generation on the live pod, and names what each shadows", () => {
    const shadows = classifyShadows(livePod());
    expect(shadows.map((s) => [s.type, s.id])).toEqual([
      ["skill", "cal-old"],
      ["skill", "gmail-old"],
      ["tool", "tool-old"],
    ]);
    expect(shadows[0]).toEqual({
      type: "skill",
      id: "cal-old",
      name: "calendar_list",
      workspaceId: BUILDER,
      skillKind: "code",
      approved: true,
      shadows: [
        {
          id: "cal-live",
          containerId: PACK,
          containerName: "Nango — Google Workspace",
        },
      ],
    });
  });

  it("a pack member is never a shadow, even when another pack member shares its name", () => {
    const input = livePod();
    const OTHER = "other-pack";
    input.containers.push({ id: OTHER, name: "Other" });
    input.members.push({ fromType: "skill", fromId: "cal-old", toId: OTHER });
    const ids = classifyShadows(input).map((s) => s.id);
    expect(ids).not.toContain("cal-old");
    expect(ids).toContain("gmail-old");
  });

  it("skills and tools are matched within their own type only", () => {
    const input = livePod();
    // A skill named like the pack's TOOL is not a tool shadow.
    input.skills.push({
      id: "odd",
      name: "google",
      workspaceId: BUILDER,
      kind: "code",
      approved: true,
    });
    expect(classifyShadows(input).map((s) => s.id)).not.toContain("odd");
  });

  it("a skill in no pack that requires ONLY stale tools is stale with them", () => {
    const input = livePod();
    input.skills.push({
      id: "dep",
      name: "unique_ingest",
      workspaceId: BUILDER,
      kind: "code",
      approved: false,
    });
    input.requires = [
      { skillId: "dep", toolId: "tool-old" },
      // A user's own skill that also needs a LIVE tool is not dragged along.
      { skillId: "own", toolId: "tool-old" },
      { skillId: "own", toolId: "tool-live" },
    ];
    const shadows = classifyShadows(input);
    const dep = shadows.find((s) => s.id === "dep");
    expect(dep).toMatchObject({
      type: "skill",
      shadows: [{ containerId: PACK }],
    });
    expect(shadows.map((s) => s.id)).not.toContain("own");
  });

  it("nothing in any pack → nothing is a shadow", () => {
    const input = livePod();
    input.members = [];
    expect(classifyShadows(input)).toEqual([]);
  });
});
