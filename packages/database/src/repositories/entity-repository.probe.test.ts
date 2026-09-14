/**
 * D8 — `EntityRepository.create` is the floor every entity create door lands
 * on, so a TEST-key write is marked HERE (`system_data.probe = true`) and a
 * normal write is byte-identical to before.
 *
 * Drives the REAL `create()`; only its collaborators (profile resolution,
 * validation, indexing, identity signals) are replaced at the module seam, and
 * the assertion reads the row the repository hands to `insert().values()`.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../services/index.js", () => ({
  ProfileResolutionService: class {
    async resolveProfile() {
      return { id: "p-note", slug: "note", profileKind: "kind" };
    }
  },
  PropertyValidationService: class {},
  PropertyIndexService: class {
    async indexEntityProperties() {}
  },
}));
vi.mock("../services/identity-resolution-service.js", () => ({
  extractIdentitySignals: () => [],
  registerIdentitySignals: async () => {},
}));

import { EntityRepository } from "./entity-repository.js";
import { runWithProbeWrites } from "../utils/request-write-context.js";

function harness() {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(v);
          return [{ id: "e-1", ...v }];
        },
      }),
    }),
  };
  const eventRepo = { append: async () => ({}) };
  const repo = new EntityRepository(db as never, eventRepo as never);
  // The completed-event emission is BaseRepository plumbing, not the floor.
  (repo as unknown as { emitCompleted: () => Promise<void> }).emitCompleted =
    async () => {};
  return { repo, inserted };
}

const input = {
  profileSlug: "note",
  title: "dogfood note",
  userId: "u-1",
  workspaceId: null,
  skipValidation: true,
  systemData: { importedFrom: "cli" },
};

describe("EntityRepository.create — probe marker floor (D8)", () => {
  it("a TEST-key write stamps system_data.probe, keeping the caller's system data", async () => {
    const { repo, inserted } = harness();
    await runWithProbeWrites(true, () => repo.create(input, "u-1"));
    expect(inserted[0].systemData).toEqual({
      importedFrom: "cli",
      probe: true,
    });
  });

  it("a normal-key write is NOT stamped", async () => {
    const { repo, inserted } = harness();
    await repo.create(input, "u-1");
    expect(inserted[0].systemData).toEqual({ importedFrom: "cli" });
  });
});
