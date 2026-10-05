/**
 * Node-neighbourhood STATE marks + the ONE zone heading table.
 *
 * Each row rules out a candidate rule (named on the row):
 *   - "no status ⇒ working" (an open entity / active track would invent motion)
 *   - "a blocked_by edge ⇒ blocked" (a DONE focus blocks nobody)
 *   - "unread focus ⇒ open ⇒ blocked" (the dependency module's own default
 *     must not make a row claim blocked when the host never read the focus)
 *   - "a replaced blocker still decides" (the replacement does)
 */
import { describe, expect, it } from "vitest";
import {
  NODE_ZONES,
  NODE_ZONE_HEADINGS,
  NODE_ZONE_SPECS,
  deriveNodeNeighbourhood,
  neighbourUnitState,
  nodeZoneEmpty,
  toConnectionNeighbors,
  type NodeNeighbourItem,
  type WireGraphNeighbor,
} from "./index.js";

function wire(partial: Partial<WireGraphNeighbor>): WireGraphNeighbor {
  return {
    id: "x",
    name: "X",
    kind: "entity",
    subtype: null,
    edgeType: "relates_to",
    direction: "outgoing",
    via: "relations",
    ...partial,
  };
}

function items(
  nb: ReturnType<typeof deriveNodeNeighbourhood>
): NodeNeighbourItem[] {
  return NODE_ZONES.flatMap((z) => nb[z].items);
}

function byId(nb: ReturnType<typeof deriveNodeNeighbourhood>, id: string) {
  const it = items(nb).find((i) => i.id === id);
  if (!it) throw new Error(`no item ${id}`);
  return it;
}

describe("neighbourUnitState — each kind through its OWN adapter", () => {
  it("settles the lifecycle states the row alone can know", () => {
    expect(neighbourUnitState("session", "closed")?.state).toBe("done");
    expect(neighbourUnitState("session", "failed")?.state).toBe("failed");
    expect(neighbourUnitState("session", "paused")?.state).toBe("paused");
    expect(neighbourUnitState("run", "failed")?.state).toBe("failed");
    expect(neighbourUnitState("run", "waiting_on_you")?.state).toBe(
      "needs_you"
    );
    expect(neighbourUnitState("proposal", "pending")?.state).toBe(
      "needs_review"
    );
    expect(neighbourUnitState("proposal", "rejected")?.state).toBe("done");
    expect(neighbourUnitState("track", "completed")?.state).toBe("done");
    expect(neighbourUnitState("track", "paused")?.state).toBe("paused");
    expect(neighbourUnitState("project", "archived")?.state).toBe("done");
    expect(neighbourUnitState("entity", "Done")?.state).toBe("done");
  });

  it("claims NOTHING where only an aggregate could (rules out 'no status ⇒ working')", () => {
    expect(neighbourUnitState("entity", "in_progress")).toBeNull();
    expect(neighbourUnitState("entity", null)).toBeNull();
    expect(neighbourUnitState("track", "active")).toBeNull();
    expect(neighbourUnitState("project", "active")).toBeNull();
    expect(neighbourUnitState("capture", null)).toBeNull();
    expect(neighbourUnitState("proposal", "not-a-status")).toBeNull();
    expect(neighbourUnitState("session", undefined)).toBeNull();
    // Not a session status: never the adapter's default "working".
    expect(neighbourUnitState("session", "completed")).toBeNull();
  });

  it("a blocker outranks motion but never a settled end", () => {
    expect(neighbourUnitState("entity", "todo", "Spec")?.state).toBe("blocked");
    expect(neighbourUnitState("track", "active", "Spec")?.state).toBe(
      "blocked"
    );
    expect(neighbourUnitState("session", "active", "Spec")?.state).toBe(
      "blocked"
    );
    // A finished row is finished, whatever it waited on.
    expect(neighbourUnitState("entity", "done", "Spec")?.state).toBe("done");
  });
});

describe("deriveNodeNeighbourhood — blocked BY the focus", () => {
  const dependant = wire({
    id: "task",
    kind: "entity",
    edgeType: "blocked_by",
    direction: "incoming",
    via: "links",
    status: "todo",
  });

  it("marks a dependant blocked while the focus is OPEN", () => {
    const nb = deriveNodeNeighbourhood(
      { kind: "entity", id: "f", status: "in_progress", title: "Spec" },
      [dependant]
    );
    expect(byId(nb, "task").state?.state).toBe("blocked");
  });

  it("a DONE focus blocks nobody (rules out 'blocked_by edge ⇒ blocked')", () => {
    const nb = deriveNodeNeighbourhood(
      { kind: "entity", id: "f", status: "done" },
      [dependant]
    );
    expect(byId(nb, "task").state).toBeNull();
  });

  it("an UNREAD focus status claims nothing (rules out 'unread ⇒ open ⇒ blocked')", () => {
    const nb = deriveNodeNeighbourhood({ kind: "entity", id: "f" }, [
      dependant,
    ]);
    expect(byId(nb, "task").state).toBeNull();
  });

  it("follows a replacement of the focus (rules out 'the replaced blocker decides')", () => {
    const replacement = (status: string) =>
      wire({
        id: "r",
        kind: "session",
        edgeType: "replaces",
        direction: "incoming",
        via: "links",
        status,
      });
    // The focus failed (cleared by its own status) but its replacement is open:
    // the dependant now waits on the replacement.
    const open = deriveNodeNeighbourhood(
      { kind: "session", id: "f", status: "failed" },
      [dependant, replacement("active")]
    );
    expect(byId(open, "task").state?.state).toBe("blocked");
    // The focus is OPEN but replaced by a finished attempt: nobody waits.
    const done = deriveNodeNeighbourhood(
      { kind: "session", id: "f", status: "active" },
      [dependant, replacement("completed")]
    );
    expect(byId(done, "task").state).toBeNull();
  });

  it("carries status / updatedAt through, and the row's own mark", () => {
    const nb = deriveNodeNeighbourhood({ kind: "entity", id: "f" }, [
      wire({
        id: "s",
        kind: "session",
        edgeType: "targets",
        direction: "incoming",
        via: "links",
        status: "closed",
        updatedAt: "2026-10-05T10:00:00.000Z",
      }),
    ]);
    expect(byId(nb, "s")).toMatchObject({
      status: "closed",
      updatedAt: "2026-10-05T10:00:00.000Z",
      state: { state: "done", glyph: "check" },
    });
  });
});

describe("the wire keeps 'not read' apart from 'none'", () => {
  it("passes status through only when sent", () => {
    const [absent, none, set] = toConnectionNeighbors([
      wire({}),
      wire({ status: null }),
      wire({ status: "done" }),
    ]);
    expect("status" in absent!).toBe(false);
    expect(none!.status).toBeNull();
    expect(set!.status).toBe("done");
  });
});

describe("NODE_ZONE_SPECS — one heading table, every surface", () => {
  it("names every zone, with the approved copy", () => {
    // Spelled out (not read back from the table): a swap must go red.
    expect(NODE_ZONES.map((z) => NODE_ZONE_HEADINGS[z])).toEqual([
      "Came from",
      "Became",
      "Blocked by",
      "Serves & blocks",
      "Working on it",
      "Related",
    ]);
    for (const z of NODE_ZONES) {
      expect(NODE_ZONE_HEADINGS[z]).toBe(NODE_ZONE_SPECS[z].heading);
    }
  });

  it("reassures on 'Blocked by' only for a focus that can be blocked", () => {
    expect(nodeZoneEmpty("blockedBy", { kind: "session" })).toEqual({
      answer: "reassure",
      title: "Nothing blocks it",
    });
    expect(nodeZoneEmpty("blockedBy", { kind: "track" }).answer).toBe(
      "reassure"
    );
    expect(
      nodeZoneEmpty("blockedBy", { kind: "entity", status: "todo" }).answer
    ).toBe("reassure");
    // A person / note (an entity with no status) is never "unblocked news".
    expect(nodeZoneEmpty("blockedBy", { kind: "entity" }).answer).toBe("omit");
    expect(nodeZoneEmpty("blockedBy", { kind: "playbook" }).answer).toBe(
      "omit"
    );
    expect(nodeZoneEmpty("blockedBy", null).answer).toBe("omit");
    for (const z of NODE_ZONES.filter((z) => z !== "blockedBy")) {
      expect(nodeZoneEmpty(z, { kind: "session" }).answer).toBe("omit");
    }
  });
});
