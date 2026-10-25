/**
 * Ticket 63a0c0d8 — a write made while an agent key is acting is the agent's
 * work, even when the door that reaches the floor names no `agentUserId` (the
 * capture graph's composite callers). `stampProvenance` falls back to the
 * request's acting agent, so the row reads `ai_agent`, not `human`.
 *
 * Drives the REAL `create()` (same seam as entity-repository.probe.test.ts) and
 * reads the row the repository hands to `insert().values()`.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../services/index.js", () => ({
  ProfileResolutionService: class {
    async resolveProfile() {
      return { id: "p-note", slug: "note", profileKind: "kind" };
    }
    async getEffectiveLifecycle() {
      return null;
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
import { runWithActingAgent } from "../utils/request-write-context.js";

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
  (repo as unknown as { emitCompleted: () => Promise<void> }).emitCompleted =
    async () => {};
  return { repo, inserted };
}

const input = {
  profileSlug: "note",
  title: "captured by an agent",
  userId: "u-1",
  workspaceId: null,
  skipValidation: true,
};

describe("EntityRepository.create — the acting agent is the author (63a0c0d8)", () => {
  it("a write under an acting agent, with no agentUserId named, reads ai_agent", async () => {
    const { repo, inserted } = harness();
    await runWithActingAgent("agent-1", () => repo.create(input, "u-1"));
    expect(inserted[0]).toMatchObject({
      createdByKind: "ai_agent",
      createdByUserId: "u-1",
      agentUserId: "agent-1",
    });
  });

  it("an explicit kind override is kept (a system write stays system)", async () => {
    const { repo, inserted } = harness();
    await runWithActingAgent("agent-1", () =>
      repo.create({ ...input, createdByKind: "system" }, "u-1")
    );
    expect(inserted[0].createdByKind).toBe("system");
    expect(inserted[0].agentUserId).toBeUndefined();
  });

  it("a write with no acting agent stays human", async () => {
    const { repo, inserted } = harness();
    await repo.create(input, "u-1");
    expect(inserted[0]).toMatchObject({ createdByKind: "human" });
    expect(inserted[0].agentUserId).toBeUndefined();
  });
});
