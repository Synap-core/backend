/**
 * `before: null` on the wire means ONE thing: the propose-time snapshot
 * RECORDED the field as empty. `before` absent means unknown. These pin both
 * producers of a before (the snapshot and the legacy live read) to that
 * contract, and the drift predicate to the snapshot's OWN keys.
 */

import { describe, expect, it } from "vitest";
import { buildProposalChanges } from "./changes.js";

const byPath = (changes: ReturnType<typeof buildProposalChanges>) =>
  new Map(changes.map((c) => [c.path, c]));

describe("buildProposalChanges — a recorded empty vs an unknown before", () => {
  it("passes a recorded null title through as null (was empty)", () => {
    const rows = byPath(
      buildProposalChanges(
        { title: "Named" },
        "update",
        { title: "Named", properties: {} },
        { title: null }
      )
    );
    expect(rows.get("title")!.before).toBeNull();
  });

  it("passes a recorded null property through as null (was empty)", () => {
    const rows = byPath(
      buildProposalChanges(
        { properties: { stage: "won" } },
        "update",
        { properties: { stage: "won" } },
        { properties: { stage: null } }
      )
    );
    expect(rows.get("properties.stage")!.before).toBeNull();
  });

  it("never emits a live null from the legacy (no snapshot) read", () => {
    const rows = byPath(
      buildProposalChanges({ properties: { stage: "won" } }, "update", {
        properties: { stage: null },
      })
    );
    const row = rows.get("properties.stage")!;
    expect(row.before).toBeUndefined();
    // Absent, not null, on the wire: JSON drops `undefined`.
    expect(JSON.parse(JSON.stringify(row))).not.toHaveProperty("before");
  });

  it("does not read an inherited key as recorded by the snapshot", () => {
    const rows = byPath(
      buildProposalChanges(
        { properties: { constructor: "x" } },
        "update",
        { properties: {} },
        { properties: {} },
        { measureDrift: true }
      )
    );
    const row = rows.get("properties.constructor")!;
    expect(row.before).toBeUndefined();
    expect(row.drift).toBe("unknown");
  });
});
