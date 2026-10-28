import { describe, expect, it } from "vitest";
import {
  GRANT_SUBJECT_CATALOG,
  grantPlainAction,
  grantSubjectLabel,
  grantSubjectNoun,
  grantSubjectSpec,
} from "./catalog.js";
import { AGENT_GRANT_CATALOG } from "./agent.js";
import { summarizeGrant } from "./summary.js";
import { normalizeGrantPermissions } from "./draft.js";
import {
  resolveObjectIcon,
  resolveObjectNounPlural,
} from "../vocabulary/index.js";

describe("the event log in the grant catalog (Activity)", () => {
  it("offers event read and create, so a poster key has a checkbox", () => {
    expect(grantSubjectSpec("event")).toEqual({
      subject: "event",
      actions: ["read", "create"],
      noun: "activity",
    });
    expect(AGENT_GRANT_CATALOG.some((s) => s.subject === "event")).toBe(true);
  });

  // The trap the noun exists for: `event` in the vocabulary is the CALENDAR
  // kind. A permission row reading "Events" with a Calendar icon reads as
  // calendar access.
  it("is named Activity through the vocabulary, never the calendar's Events", () => {
    expect(resolveObjectNounPlural("event")).toBe("Events");
    expect(grantSubjectNoun("event")).toBe("activity");
    expect(grantSubjectLabel("event")).toBe("Activity");
    expect(resolveObjectIcon(grantSubjectNoun("event"))).not.toBe(
      resolveObjectIcon("event")
    );
  });

  it("every other subject is named by itself", () => {
    const others = GRANT_SUBJECT_CATALOG.filter((s) => s.subject !== "event");
    expect(others.length).toBeGreaterThan(5);
    for (const s of others) {
      expect(grantSubjectNoun(s.subject)).toBe(s.subject);
      expect(grantSubjectLabel(s.subject)).toBe(
        resolveObjectNounPlural(s.subject)
      );
    }
  });

  it("an event.create grant reads as its own row, not '+1 more'", () => {
    const s = summarizeGrant({ permissions: ["event.create"] });
    expect(s.other).toEqual([]);
    expect(s.rows).toEqual([
      expect.objectContaining({
        subject: "event",
        label: "Activity",
        actions: ["create"],
      }),
    ]);
    expect(s.what).toBe("Create Activity");
  });

  it("was appended last, so no other subject's canonical order moved", () => {
    expect(GRANT_SUBJECT_CATALOG.at(-1)?.subject).toBe("event");
    expect(
      normalizeGrantPermissions(["event.read", "playbook.read", "entity.read"])
    ).toEqual(["entity.*.read", "playbook.read", "event.read"]);
  });
});

// A facet is a ROLE to the person ("Users see Role, not Facet"). Since #411 a
// role write is granted as `facet.create` / `facet.delete`; `facet.attach` /
// `facet.detach` are the door's own spelling of the same act.
describe("a role on a record (facet)", () => {
  it("is named Roles, never Facets", () => {
    expect(grantSubjectNoun("facet")).toBe("role");
    expect(grantSubjectLabel("facet")).toBe("Roles");
  });

  it("attach is create and detach is delete; every other action is itself", () => {
    expect(grantPlainAction("facet", "attach")).toBe("create");
    expect(grantPlainAction("facet", "detach")).toBe("delete");
    expect(grantPlainAction("facet", "create")).toBe("create");
    expect(grantPlainAction("facet", "update")).toBe("update");
    expect(grantPlainAction("entity", "transition")).toBe("transition");
    expect(grantPlainAction("tool", "attach")).toBe("attach");
    expect(grantPlainAction("facet", null)).toBeNull();
  });
});
