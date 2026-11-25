/**
 * No raw id is ever shown as a name (founder, 21 Nov 2026: an entity's
 * provenance line read "in 51dd9623-d895-451c-8502-dea…").
 *
 * Live cause: the session had a real title, but it lives in another space, so
 * under the browser's lens the graph read flagged it `hidden` and sent its id
 * as its `name`; `groupConnections` passed that name to the provenance line.
 * These rows pin the three doors: the detector (`isMachineToken`), the session
 * name (`resolveSessionTitle`) and the connection name pass (`groupConnections`).
 * Each row names the wrong rule it rules out.
 */
import { describe, expect, it } from "vitest";
import {
  groupConnections,
  type ConnectionNeighbor,
} from "../connections/index.js";
import { resolveSessionTitle } from "../focus-sessions/title.js";
import {
  isMachineToken,
  resolveObjectNoun,
  resolvePrivateObjectLabel,
} from "./index.js";

const UUID = "51dd9623-d895-451c-8502-deaa412ee4e8";
const BUILD_TAG = "local-b88d021b7d74";

describe("isMachineToken (the one exported id detector)", () => {
  it("a uuid and a build tag are tokens, padded or not", () => {
    expect(isMachineToken(UUID)).toBe(true);
    expect(isMachineToken(`  ${UUID} `)).toBe(true);
    expect(isMachineToken(BUILD_TAG)).toBe(true);
  });

  it("a name is never a token (rules out 'anything hex-shaped')", () => {
    for (const name of [
      "Première validation : la source qui agrège la plupart",
      "Cafe2024",
      "decade2025",
      "meeting_notes",
      "report.pdf",
      "",
    ]) {
      expect(isMachineToken(name), name).toBe(false);
    }
  });
});

describe("resolveSessionTitle skips a machine token", () => {
  it("a uuid title falls back to the goal's first line", () => {
    expect(
      resolveSessionTitle({ title: UUID, goal: "Validate the first source" })
    ).toBe("Validate the first source");
  });

  it("a build-tag title falls back to the goal", () => {
    expect(resolveSessionTitle({ title: BUILD_TAG, goal: "Ship it" })).toBe(
      "Ship it"
    );
  });

  it("uuid title AND uuid goal → empty (the surface's own empty copy, never the id)", () => {
    expect(resolveSessionTitle({ title: UUID, goal: UUID })).toBe("");
    expect(resolveSessionTitle({ title: null, goal: `${UUID}\nmore` })).toBe(
      ""
    );
  });

  it("a normal title is untouched", () => {
    expect(resolveSessionTitle({ title: "Billing launch", goal: UUID })).toBe(
      "Billing launch"
    );
  });
});

const session = (p: Partial<ConnectionNeighbor>): ConnectionNeighbor => ({
  id: UUID,
  name: "Première validation",
  kind: "session",
  edgeType: "produced",
  direction: "incoming",
  via: "links",
  ...p,
});

describe("groupConnections never names a connection by its id", () => {
  it("a HIDDEN session (sent with its id as name) is not the provenance line's session", () => {
    const { provenance } = groupConnections({
      neighbors: [session({ name: UUID, hidden: true })],
    });
    expect(provenance.inSession).toBeNull();
    // Still in the Why pane, named by the private placeholder, flagged.
    expect(provenance.all).toHaveLength(1);
    expect(provenance.all[0]!.name).toBe(resolvePrivateObjectLabel("session"));
    expect(provenance.all[0]!.name).not.toContain("51dd9623");
    expect(provenance.all[0]!.hidden).toBe(true);
  });

  it("a visible session whose stored name is a uuid reads as its noun", () => {
    const { provenance } = groupConnections({
      neighbors: [session({ name: UUID })],
    });
    expect(provenance.inSession?.id).toBe(UUID);
    expect(provenance.inSession?.name).toBe(resolveObjectNoun("session"));
  });

  it("a visible session with a real name keeps it (rules out 'always the noun')", () => {
    const { provenance } = groupConnections({ neighbors: [session({})] });
    expect(provenance.inSession?.name).toBe("Première validation");
    expect(provenance.inSession?.hidden).toBeUndefined();
  });

  it("a data edge to a uuid-named entity reads as its kind's noun", () => {
    const { groups } = groupConnections({
      neighbors: [
        {
          id: "e1",
          name: UUID,
          kind: "entity",
          subtype: "person",
          edgeType: "knows",
          direction: "outgoing",
          via: "relations",
        },
      ],
    });
    expect(groups[0]!.items[0]!.name).toBe(resolveObjectNoun("person"));
  });
});
