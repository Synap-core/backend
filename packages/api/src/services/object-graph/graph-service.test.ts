import { describe, expect, it } from "vitest";
import { connectionsToNeighbors } from "./graph-service.js";

describe("connectionsToNeighbors", () => {
  it("preserves entity, channel, and session neighbour kinds", () => {
    const neighbors = connectionsToNeighbors([
      {
        entityId: "entity-1",
        entity: {
          title: "A contact",
          type: "person",
          workspaceId: "workspace-1",
          facetSlugs: ["customer"],
        },
        label: "knows",
        direction: "outgoing",
        source: "graph",
        relationId: "relation-1",
        relationType: "knows",
      },
      {
        entityId: "channel-1",
        entity: null,
        label: "Planning",
        direction: "incoming",
        source: "context_channel",
        channelId: "channel-1",
        channelTitle: "Planning",
        channelWorkspaceId: "workspace-1",
      },
      {
        entityId: "session-1",
        entity: null,
        label: "Ship Galaxy",
        direction: "incoming",
        source: "focus_session",
        focusSessionId: "session-1",
        focusSessionGoal: "Ship Galaxy",
        focusSessionWorkspaceId: "workspace-1",
      },
    ]);

    expect(neighbors).toEqual([
      expect.objectContaining({
        kind: "entity",
        id: "entity-1",
        name: "A contact",
        subtype: "person",
        subtypes: ["person", "customer"],
        via: "relations",
      }),
      expect.objectContaining({
        kind: "channel",
        id: "channel-1",
        name: "Planning",
        workspaceId: "workspace-1",
        via: "channel",
      }),
      expect.objectContaining({
        kind: "session",
        id: "session-1",
        name: "Ship Galaxy",
        workspaceId: "workspace-1",
        via: "session",
      }),
    ]);
  });
});
