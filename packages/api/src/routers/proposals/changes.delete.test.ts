/**
 * A delete row's value is what it REMOVES: it rides `before`, and the row has
 * no `after`. Live (proposal f15b68ae, 2026-10-28): a link delete carried each
 * value in `after`, so pod-admin drew every row "empty removed" and the
 * desktop "unknown". The rows below cover each producer a delete reaches: the
 * entity-shape keys, the properties, and the generic fallback (a link).
 */

import { describe, expect, it } from "vitest";
import { buildProposalChanges } from "./changes.js";

describe("buildProposalChanges — a delete names what it removes", () => {
  it("a link delete carries each value as its before", () => {
    const rows = buildProposalChanges(
      {
        title: "Session blocked by session",
        fromId: "dfc6c1be-0cb4-423a-951a-7a543b92756f",
        toId: "a74e5430-6bc0-40b0-bc33-be683967f541",
        linkType: "blocked_by",
        sourceLabel: "Markdown → pod cleanup",
      },
      "delete"
    );
    const byPath = new Map(rows.map((r) => [r.path, r]));
    expect(byPath.get("title")).toMatchObject({
      operation: "delete",
      before: "Session blocked by session",
    });
    expect(byPath.get("linkType")).toMatchObject({ before: "blocked_by" });
    expect(byPath.get("sourceLabel")).toMatchObject({
      before: "Markdown → pod cleanup",
    });
    for (const row of rows) {
      expect(row.after, row.path).toBeUndefined();
      expect(row.before, row.path).not.toBeUndefined();
    }
  });

  it("an entity delete's properties carry their values as before", () => {
    const rows = buildProposalChanges(
      { title: "Ada", properties: { role: "CTO" } },
      "delete"
    );
    const role = rows.find((r) => r.path === "properties.role");
    expect(role).toMatchObject({ operation: "delete", before: "CTO" });
    expect(role?.after).toBeUndefined();
  });

  it("an update keeps its before → after", () => {
    const rows = buildProposalChanges({ title: "New" }, "update", {
      title: "Old",
    });
    expect(rows.find((r) => r.path === "title")).toMatchObject({
      operation: "update",
      before: "Old",
      after: "New",
    });
  });
});
