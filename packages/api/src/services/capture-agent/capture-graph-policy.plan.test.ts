/**
 * A plan's ops are scored under the SAME event keys their direct doors pass to
 * `checkPermissionOrPropose`:
 *   createFocusSession        → focus_session.create (+ link.create per
 *                               create-time blocker, `addCreateTimeBlockers`)
 *   projects.create           → project.create
 *   documents.createDocument  → document.create (+ entity.update when attached,
 *                               `synap_create_document({ entityId })`)
 *   POST /links               → link.create
 */

import { describe, expect, it } from "vitest";
import { captureGraphEventKeys } from "./capture-graph-policy.js";

const keysOf = (ops: Parameters<typeof captureGraphEventKeys>[0]) =>
  captureGraphEventKeys(ops).map((k) => `${k.subjectType}.${k.action}`);

describe("captureGraphEventKeys — plan ops", () => {
  it("maps every plan op to its direct door's key", () => {
    expect(
      keysOf([
        { op: "create_project", ref: "p", name: "P" },
        { op: "create_session", ref: "s", goal: "g" },
        { op: "create_document", ref: "d", title: "D", content: "" },
        { op: "create_link", type: "spawned_from", fromRef: "s", toRef: "t" },
      ])
    ).toEqual([
      "project.create",
      "focus_session.create",
      "document.create",
      "link.create",
    ]);
  });

  it("adds link.create for a create-time blocker and entity.update for an attached document", () => {
    expect(
      keysOf([
        { op: "create_session", ref: "s", goal: "g", blockedByRefs: ["t"] },
        {
          op: "create_document",
          ref: "d",
          title: "D",
          content: "",
          entityRef: "e",
        },
      ])
    ).toEqual([
      "focus_session.create",
      "link.create",
      "document.create",
      "entity.update",
    ]);
  });
});
