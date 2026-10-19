import { describe, it, expect } from "vitest";
import {
  entityHappened,
  happenedItemOfTransition,
  isHappenedDataLine,
  dataLineText,
  type LoggedEvent,
} from "./index.js";

const NOW = new Date("2026-10-11T18:00:00Z");
const OPTS = { timeZone: "UTC", now: NOW };

const move = (
  id: string,
  at: string,
  data: Record<string, unknown>
): LoggedEvent => ({
  id,
  type: "entity.transition.completed",
  timestamp: at,
  subjectType: "entity",
  subjectId: "e1",
  source: "api",
  data: { role: null, ...data },
});

describe("entity history", () => {
  it("a transition reads as a move, from → to, in the declaration's words", () => {
    const item = happenedItemOfTransition(
      move("t1", "2026-10-11T10:00:00Z", { from: "lead", to: "qualified" }),
      (key) => ({ lead: "New lead", qualified: "Qualified" })[key] ?? key
    );
    expect(item?.kind).toBe("data");
    expect(item && item.kind === "data" && item.event.line?.text).toBe(
      "Moved from New lead to Qualified"
    );
  });

  it("a role's move names the role; a first status has no 'from'", () => {
    const item = happenedItemOfTransition(
      move("t2", "2026-10-11T10:00:00Z", {
        from: null,
        to: "engaged",
        role: "lead",
      })
    );
    const text = item && item.kind === "data" ? item.event.line!.text : "";
    expect(text).toMatch(/^Lead · Moved to /);
    expect(text).not.toContain("from");
    expect(text).not.toContain("engaged"); // vocabulary words, never the raw key
  });

  it("transitions never batch, merge newest-first with record changes", () => {
    const days = entityHappened(
      {
        events: [
          move("t1", "2026-10-11T09:00:00Z", { from: "a", to: "b" }),
          {
            id: "u1",
            type: "entity.update.completed",
            timestamp: "2026-10-11T12:00:00Z",
            subjectType: "entity",
            subjectId: "e1",
            source: "api",
            data: {},
          },
          move("t2", "2026-10-11T11:00:00Z", { from: "b", to: "c" }),
          {
            id: "x",
            type: "proposal.requested",
            timestamp: "2026-10-11T08:00:00Z",
            data: {},
          },
        ],
      },
      OPTS
    );
    expect(days).toHaveLength(1);
    const lines = days[0]!.lines;
    expect(lines.map((l) => l.key)).toEqual(["u1", "t2", "t1"]);
    expect(lines.every(isHappenedDataLine)).toBe(true);
    expect(dataLineText(lines[1] as never)).toMatch(/^Moved from B to C$/);
  });

  it("drops what is not a transition or a record change; tolerates bad rows", () => {
    expect(
      happenedItemOfTransition({
        id: "z",
        type: "entity.update.completed",
        timestamp: NOW,
        data: {},
      })
    ).toBeNull();
    expect(
      happenedItemOfTransition(move("y", "not a date", { to: "a" }))
    ).toBeNull();
    expect(
      happenedItemOfTransition(move("w", "2026-10-11T10:00:00Z", {}))
    ).toBeNull();
  });

  it("an edit on the thing is named by the thing's kind, from the pod's real update event", () => {
    // The pod's `entities.update.completed`: `emitCompleted("update", entity)`
    // stores the entity ROW as data — an id, a title, a profileId and the
    // properties, and NO profileSlug.
    const update: LoggedEvent = {
      id: "u-real",
      type: "entities.update.completed",
      timestamp: "2026-10-11T12:00:00Z",
      subjectType: "entities",
      subjectId: "e1",
      source: "api",
      data: {
        id: "e1",
        title: "Lumen Atelier",
        profileId: "8d7c2f9e-0000-4000-8000-000000000001",
        properties: { stage: "qualified" },
      },
    };
    const text = (profileSlug?: string) =>
      dataLineText(
        entityHappened({ events: [update], profileSlug }, OPTS)[0]!
          .lines[0] as never
      );
    expect(text()).toBe("Updated entity"); // the defect, without the host's kind
    expect(text("lead")).toBe("Updated lead");
    // An event that names its own kind keeps it.
    const created: LoggedEvent = {
      ...update,
      id: "c1",
      type: "entities.create.completed",
      data: { profileSlug: "company" },
    };
    const named = entityHappened(
      { events: [created], profileSlug: "lead" },
      OPTS
    )[0]!.lines[0];
    expect(dataLineText(named as never)).toBe("Created company");
  });
});
