import { describe, it, expect } from "vitest";
import { deriveAgentProposalSessionGoal } from "@synap/database";
import { buildProposalSummary } from "./permission-check.js";
import { collapseProposalsToClusters } from "../services/proposals/fingerprint.js";

/**
 * ONE SENTENCE per proposal, used everywhere.
 *
 * A `profile/renderer.set` proposal reached the founder as three different
 * strings, none of which said what approving it would do: the detail title read
 * "Set Task", the pack row read `Set Profile "profile · 26f94b78"` (a machine
 * token beside eight characters of a UUID the gate had MINTED, because the
 * payload carries no id), and the receipt session read "Agent renderer.set ·
 * profile". The body underneath read "Nothing here to review".
 *
 * These tests pin the sentence and the three surfaces that must reuse it.
 *
 * NEGATIVE CONTROLS (each run with its fix reverted, output quoted in the wave
 * report): removing the `renderer.set` branch from `buildProposalSummary` makes
 * the first test fail with `"Set Task"`; removing the `summary` arm from
 * `deriveAgentProposalSessionGoal` makes the receipt test fail with
 * `"Agent renderer.set · profile"`; removing the summary arm from
 * `resolveTargetLabel` makes the pack-row tests fail with
 * `"profile · 26f94b78"`.
 */

/** The payload `hub-protocol/profiles.ts` actually gates with. */
const RENDERER_SET_DATA = {
  profileSlug: "task",
  slot: "detail",
  scope: "pod",
  ref: { kind: "cell", cellKey: "generated:task-detail-card", props: {} },
};

describe("buildProposalSummary — renderer.set says what changes", () => {
  it("names the kind, the slot, the cell and the scope", () => {
    expect(
      buildProposalSummary("profile", "renderer.set", RENDERER_SET_DATA)
    ).toBe('Set the Task detail renderer to "Task detail card" (pod)');
  });

  it("unwraps the iframe host so the real cell is named, not the wrapper", () => {
    // `buildCellRendererRef` rewrites cellKey to the shared "iframe-widget" host
    // and moves the real typeKey into props — reading cellKey alone would print
    // the same words for every iframe cell ever proposed.
    expect(
      buildProposalSummary("profile", "renderer.set", {
        ...RENDERER_SET_DATA,
        scope: "workspace",
        ref: {
          kind: "cell",
          cellKey: "iframe-widget",
          props: { typeKey: "generated:kanban-board" },
        },
      })
    ).toBe('Set the Task detail renderer to "Kanban board" (workspace)');
  });

  it("says ONE object, not the kind, for the per-object binding", () => {
    // The per-object exception binds for a single entity. "the Task detail
    // renderer" would tell the reviewer every Task changes.
    expect(
      buildProposalSummary("profile", "renderer.set", {
        ...RENDERER_SET_DATA,
        scope: "workspace",
        subjectId: "ent_1",
      })
    ).toBe(
      'Set the detail renderer for one Task to "Task detail card" (workspace)'
    );
  });

  it("names the entity for the entity-subject variant", () => {
    expect(
      buildProposalSummary("entity", "renderer.set", {
        entityId: "ent_1",
        entityTitle: "Q2 plan review",
        profileSlug: "task",
        ref: { kind: "cell", cellKey: "generated:task-detail-card", props: {} },
      })
    ).toBe(
      'Set the detail renderer for "Q2 plan review" to "Task detail card"'
    );
  });

  it("leaves the capability/renderer.set payload on the generic path", () => {
    // `{capabilityId, scope, pages}` — no cell and no slot. Describing it in
    // words that do not apply to it would be worse than the generic title.
    expect(
      buildProposalSummary("capability", "renderer.set", {
        capabilityId: "cap_1",
        scope: "workspace",
        pages: ["home"],
      })
    ).toBe("Set Capability");
  });
});

describe("buildProposalSummary — the generic path is unchanged", () => {
  // Three of the 38 machine-token pairs from the triage. They are NOT renderer
  // proposals and must keep composing through `buildObjectActionTitle`.
  it.each([
    // "Card", not "Cell" — the vocabulary's product word for a cell. Pinned
    // here so the renderer branch above cannot quietly change it.
    [
      "cell",
      "define",
      { name: "Task detail card" },
      'Define Card "Task detail card"',
    ],
    ["workspace", "adopt", { workspaceId: "ws_1" }, "Adopt Workspace"],
  ])("%s · %s", (subjectType, action, data, expected) => {
    expect(buildProposalSummary(subjectType, action, data)).toBe(expected);
  });

  it("rule · create keeps its own special-cased sentence", () => {
    const summary = buildProposalSummary("rule", "create", {
      intent: "When a task is done, notify me",
    });
    expect(summary).toContain("rule");
    expect(summary).not.toBe("Create Rule");
  });
});

describe("the receipt session reuses the sentence", () => {
  const summary = buildProposalSummary(
    "profile",
    "renderer.set",
    RENDERER_SET_DATA
  );

  it("beats the `Agent <type> · <target>` machine-token fallback", () => {
    expect(
      deriveAgentProposalSessionGoal({
        data: RENDERER_SET_DATA,
        proposalType: "renderer.set",
        targetType: "profile",
        notificationDescription: null,
        summary,
      })
    ).toBe('Set the Task detail renderer to "Task detail card" (pod)');
  });

  it("never displaces the author's OWN words", () => {
    // The agent supplied a reason through the MCP door; that is what the
    // receipt should say, not a sentence the server synthesized.
    expect(
      deriveAgentProposalSessionGoal({
        data: RENDERER_SET_DATA,
        proposalType: "renderer.set",
        targetType: "profile",
        notificationDescription: "You asked for the richer task card",
        summary,
      })
    ).toBe("You asked for the richer task card");
  });

  it("still falls back when no summary is supplied", () => {
    expect(
      deriveAgentProposalSessionGoal({
        data: RENDERER_SET_DATA,
        proposalType: "renderer.set",
        targetType: "profile",
      })
    ).toBe("Agent renderer.set · profile");
  });
});

describe("the pack row reuses the sentence", () => {
  const summary = buildProposalSummary(
    "profile",
    "renderer.set",
    RENDERER_SET_DATA
  );
  /** What `createProposal` stores: the request envelope, summary at top level. */
  const storedData = {
    targetType: "profile",
    changeType: "renderer.set",
    summary,
    data: RENDERER_SET_DATA,
  };
  const row = {
    id: "p1",
    proposalType: "renderer.set",
    targetType: "profile",
    // The gate MINTS this — the payload has no documentId/entityId/id, so this
    // UUID identifies nothing and must never reach a reviewer.
    targetId: "26f94b78-1111-2222-3333-444455556666",
    data: storedData,
    createdAt: new Date("2026-09-08T10:00:00Z"),
    workspaceId: null,
  };

  it("labels the cluster with the summary", () => {
    const [cluster] = collapseProposalsToClusters([row]);
    expect(cluster.targetLabel).toBe(
      'Set the Task detail renderer to "Task detail card" (pod)'
    );
  });

  it("no user-facing string carries a raw UUID prefix when a summary exists", () => {
    const [cluster] = collapseProposalsToClusters([row]);
    // The exact shape the founder saw: `<targetType> · <first 8 of the UUID>`.
    expect(cluster.targetLabel).not.toContain(row.targetId.slice(0, 8));
    expect(cluster.targetLabel).not.toMatch(/\b[0-9a-f]{8}\b/);
    expect(cluster.targetLabel).not.toContain(" · ");
  });

  it("still falls back to `<type> · <shortId>` when there is no summary", () => {
    const [cluster] = collapseProposalsToClusters([
      { ...row, data: { ...storedData, summary: undefined } },
    ]);
    expect(cluster.targetLabel).toBe("profile · 26f94b78");
  });

  it("a proposed NAME still outranks the summary", () => {
    // For a create, the object's own name is the sharper label and the summary
    // is the sentence that already contains it.
    const [cluster] = collapseProposalsToClusters([
      {
        ...row,
        proposalType: "create",
        targetType: "entity",
        data: { ...storedData, targetName: "Acme Corp" },
      },
    ]);
    expect(cluster.targetLabel).toBe("Acme Corp");
  });
});
