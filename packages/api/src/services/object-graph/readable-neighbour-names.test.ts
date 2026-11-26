/**
 * A graph node with nothing to read a name from is named by words, never by
 * its raw id (finding 80cc8e12's second half; the guard
 * `__tripwires__/graph-names-never-raw-id.test.ts` watches the source, this
 * drives the VALUE through the real functions).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // A stub kind (no table) never queries; the db is only fetched.
  return { ...actual, getDb: async () => ({}) };
});

import {
  isMachineToken,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { connectionsToNeighbors, hydrateNodes } from "./graph-service.js";
import type { EntityConnection } from "./entity-connections.js";

const UUID = "51dd9623-d895-451c-8502-deaa412ee4e8";
const SCOPE = { kind: "all" } as never;

function conn(over: Partial<EntityConnection>): EntityConnection {
  return {
    entityId: UUID,
    entity: null,
    label: undefined as unknown as string, // what a row with no label carries
    direction: "incoming",
    source: "graph",
    ...over,
  };
}

describe("connectionsToNeighbors: no title, no label", () => {
  it("an entity is named by its own kind's noun", () => {
    const [n] = connectionsToNeighbors([
      conn({ entity: { title: null, type: "person" } }),
    ]);
    expect(n!.name).toBe(resolveObjectNoun("person"));
    expect(n!.name).not.toContain(UUID.slice(0, 8));
  });

  it("an entity of unknown kind, a session and a channel get their noun", () => {
    const out = connectionsToNeighbors([
      conn({ entity: null }),
      conn({ source: "focus_session", focusSessionId: UUID }),
      conn({ source: "thread", channelId: UUID }),
    ]);
    expect(out.map((n) => n.name)).toEqual([
      resolveObjectNoun("entity"),
      resolveObjectNoun("session"),
      resolveObjectNoun("channel"),
    ]);
    for (const n of out) expect(isMachineToken(n.name)).toBe(false);
  });

  it("a real title still wins", () => {
    const [n] = connectionsToNeighbors([
      conn({ entity: { title: "Acme", type: "company" } }),
    ]);
    expect(n!.name).toBe("Acme");
  });
});

describe("hydrateNodes: a stub kind (no table)", () => {
  it("a machine id becomes the kind's noun; a readable handle stays", async () => {
    const nodes = await hydrateNodes(
      "u",
      [
        { kind: "participant", id: UUID },
        { kind: "source", id: "gmail" },
      ],
      SCOPE
    );
    expect(nodes.get(`participant:${UUID}`)?.name).toBe(
      resolveObjectNoun("participant")
    );
    expect(nodes.get("source:gmail")?.name).toBe("gmail");
  });
});
