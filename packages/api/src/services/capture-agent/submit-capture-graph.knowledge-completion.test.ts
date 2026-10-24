/**
 * Ticket 091f412e (1) — an agent's structured `entities[]` capture of a
 * Knowledge entity was refused for `knowledgeForm` / `ek_claim`, fields the
 * tool never asks for: the text lane and the approval executor derive them,
 * this lane validated before anything did.
 *
 * Drives the REAL op mapping (`buildCaptureGraphOperations`, shared by the
 * submit and the `validate: true` dry run), whose `properties` are what the
 * preflight validates and what the proposal files.
 */
import { describe, it, expect } from "vitest";
import { buildCaptureGraphOperations } from "./submit-capture-graph.js";

async function propertiesOf(
  entity: Parameters<typeof buildCaptureGraphOperations>[1]["entities"][number]
): Promise<Record<string, unknown>> {
  const [op] = await buildCaptureGraphOperations(null as never, {
    entities: [entity],
    relations: [],
    projectId: null,
    // No workspace: the scope-aware home stamping (a DB read) is skipped.
    workspaceId: null,
  });
  return (op as { properties: Record<string, unknown> }).properties;
}

describe("capture graph entities[] — Knowledge's required fields are derived (091f412e)", () => {
  it("THE LIVE CASE: a knowledge entity with no form and no claim gets both", async () => {
    expect(
      await propertiesOf({
        ref: "k1",
        profileSlug: "knowledge",
        title: "Avoid restarting the pod during a migration",
      })
    ).toEqual({
      knowledgeForm: "caution",
      ek_claim: "Avoid restarting the pod during a migration",
    });
  });

  it("a supplied form and claim are kept as sent", async () => {
    expect(
      await propertiesOf({
        ref: "k1",
        profileSlug: "knowledge",
        title: "Avoid this",
        properties: { knowledgeForm: "fact", ek_claim: "The claim I wrote" },
      })
    ).toEqual({ knowledgeForm: "fact", ek_claim: "The claim I wrote" });
  });

  it("another kind, and a link to an existing entity, are untouched", async () => {
    expect(
      await propertiesOf({
        ref: "n1",
        profileSlug: "note",
        title: "Avoid this",
        properties: { tag: "x" },
      })
    ).toEqual({ tag: "x" });
    expect(
      await propertiesOf({
        ref: "k2",
        profileSlug: "knowledge",
        title: "Avoid this",
        existingEntityId: "10000000-0000-4000-8000-000000000001",
      })
    ).toEqual({});
  });
});
