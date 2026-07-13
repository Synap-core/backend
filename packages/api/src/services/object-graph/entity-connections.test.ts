import { describe, expect, it } from "vitest";
import {
  filterUnavailableEntityConnections,
  structuralNeighbor,
  type EntityConnection,
} from "./entity-connections.js";

describe("structuralNeighbor", () => {
  it("resolves inbound and outbound entity_id edges around the focused entity", () => {
    expect(structuralNeighbor("focus", "focus", "target")).toEqual({
      entityId: "target",
      direction: "outgoing",
    });
    expect(structuralNeighbor("focus", "source", "focus")).toEqual({
      entityId: "source",
      direction: "incoming",
    });
  });

  it("drops null, unrelated, and self-referential property edges", () => {
    expect(structuralNeighbor("focus", "focus", null)).toBeNull();
    expect(structuralNeighbor("focus", "one", "two")).toBeNull();
    expect(structuralNeighbor("focus", "focus", "focus")).toBeNull();
  });
});

describe("filterUnavailableEntityConnections", () => {
  it("removes hidden entity neighbours without dropping visible channel/session edges", () => {
    const connections: EntityConnection[] = [
      {
        entityId: "hidden-entity",
        entity: null,
        label: "depends_on",
        direction: "outgoing",
        source: "graph",
      },
      {
        entityId: "channel-1",
        entity: null,
        label: "Planning",
        direction: "incoming",
        source: "context_channel",
        channelId: "channel-1",
      },
      {
        entityId: "session-1",
        entity: null,
        label: "Ship Galaxy",
        direction: "incoming",
        source: "focus_session",
        focusSessionId: "session-1",
      },
    ];

    expect(filterUnavailableEntityConnections(connections)).toEqual(
      connections.slice(1)
    );
  });
});
