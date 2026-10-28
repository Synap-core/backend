/**
 * Activity families (`event.<family>.<verb>`, decision a29a40d4) through the
 * editor model: spelling, toggling, the summary and the sections. Each row
 * names the defect it rules out.
 */
import { describe, expect, it } from "vitest";
import {
  buildGrantSections,
  normalizeGrantPermissions,
  resolveEventFamilyPermissionLabel,
  summarizeGrant,
  toggleGrant,
} from "./index.js";

const ctx = { kinds: ["note", "task"] };

describe("activity families in the grant editor", () => {
  // Rules out: normalising every poster key to a new spelling
  // (`event.*.create`) that no stored key or template holds.
  it("keeps the every-family spelling and drops a family it covers", () => {
    expect(normalizeGrantPermissions(["event.*.create"])).toEqual([
      "event.create",
    ]);
    expect(
      normalizeGrantPermissions(["event.dev.create", "event.create"])
    ).toEqual(["event.create"]);
    expect(normalizeGrantPermissions(["event.ci.create"])).toEqual([
      "event.ci.create",
    ]);
  });

  // Rules out: splitting `event.create` into the pod's KINDS (`event.note`)
  // when one family is turned off.
  it("turning one family off keeps the other families, never pod kinds", () => {
    const next = toggleGrant(
      { permissions: ["event.create"] },
      { subject: "event", kind: "dev", action: "create" },
      false,
      ctx
    );
    expect(next.permissions).toEqual(["event.ci.create"]);
  });

  it("the summary names a family row in words, apart from Activity", () => {
    const s = summarizeGrant({ permissions: ["event.ci.create"] });
    expect(s.rows.map((r) => [r.key, r.label, r.actions])).toEqual([
      ["event.ci", "CI events", ["create"]],
    ]);
    expect(s.what).toBe("Create CI events");
    expect(s.other).toEqual([]);
    const all = summarizeGrant({ permissions: ["event.create"] });
    expect(all.rows.map((r) => [r.key, r.kind, r.label])).toEqual([
      ["event", null, "Activity"],
    ]);
    expect(all.what).toBe("Create Activity");
  });

  // Rules out: an Activity section with an "Every kind" row and one row per
  // pod kind (the editor's rows for a KIND-qualified subject).
  it("the sections keep ONE Activity row", () => {
    const activity = buildGrantSections({
      draft: { permissions: ["event.create"] },
      kinds: [{ slug: "note" }, { slug: "task" }],
    }).find((s) => s.id === "activity");
    expect(activity?.rows.map((r) => [r.key, r.kind, r.granted])).toEqual([
      ["event", null, ["create"]],
    ]);
  });
});

describe("resolveEventFamilyPermissionLabel", () => {
  it("names a family-limited permission, and nothing else", () => {
    expect(resolveEventFamilyPermissionLabel("event.ci.create")).toBe(
      "Create CI events"
    );
    expect(resolveEventFamilyPermissionLabel("event.dev.create")).toBe(
      "Create dev events"
    );
    expect(resolveEventFamilyPermissionLabel("event.create")).toBeNull();
    expect(resolveEventFamilyPermissionLabel("entity.note.read")).toBeNull();
  });
});
