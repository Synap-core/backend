/**
 * Approve-time weak same-name choice. Drives the real helper and the real
 * entity/create executor (callers mocked). The live proposals.approve HTTP
 * hop into entities.create is not covered here — see weak-dedup-wire.test.ts
 * for the formatter seam.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  attachFacet: vi.fn(),
  updates: [] as unknown[],
}));

vi.mock("../../entities.js", () => ({
  mergeSystemData: (a: unknown, b: unknown) => ({
    ...(a as object),
    ...(b as object),
  }),
  entitiesRouter: {
    createCaller: () => ({
      create: h.create,
      update: h.update,
      get: h.get,
      attachFacet: h.attachFacet,
    }),
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            h.updates.push(values);
          },
        }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: async () => {} }),
      }),
      query: {
        workspaces: { findFirst: async () => null },
        entities: { findFirst: async () => null },
      },
    },
    ProfileResolutionService: class {
      async resolveProfile() {
        return null;
      }
    },
  };
});

import { buildWeakDedupCause } from "@synap/database";
import { proposalExecRegistry } from "../execution-registry.js";
import { registerEntityExecutors } from "../executors/entity.js";
import {
  applyIdentityResolution,
  identityResolutionInput,
  planIdentityFields,
  snapshotFromApiEntity,
  type IdentityEntitySnapshot,
} from "../executors/identity-resolution.js";
import { materializeCompositeGraph } from "../../../utils/materialize-composite.js";
import type { ProposalExecutorArgs } from "../execution-registry.js";

const EXISTING = "11111111-1111-4111-8111-111111111111";
const CANDIDATE = "22222222-2222-4222-8222-222222222222";
const CREATED = "33333333-3333-4333-8333-333333333333";

const here = path.dirname(fileURLToPath(import.meta.url));
const entitySrc = readFileSync(
  path.join(here, "../executors/entity.ts"),
  "utf8"
);
const helperSrc = readFileSync(
  path.join(here, "../executors/identity-resolution.ts"),
  "utf8"
);
const proposalsSrc = readFileSync(
  path.join(here, "../../proposals.ts"),
  "utf8"
);
const applySrc = readFileSync(path.join(here, "../apply-approval.ts"), "utf8");
const hubSrc = readFileSync(
  path.join(here, "../../hub-protocol/rest/proposals.ts"),
  "utf8"
);

const deps = {
  reportProposalOutcome: vi.fn(),
  emitProposalReviewed: vi.fn(),
  stampProjectMembership: vi.fn(async () => {}),
} as unknown as ProposalExecutorArgs["deps"];

function proposalData(data: Record<string, unknown>) {
  return { requestId: "r-1", data };
}

function run(
  data: Record<string, unknown>,
  input: ProposalExecutorArgs["input"] = { proposalId: "p-1" }
) {
  const exec = proposalExecRegistry.resolveExact("entity/create");
  if (!exec) throw new Error("entity/create executor is not registered");
  return exec.execute({
    proposal: {
      id: "p-1",
      targetType: "entity",
      targetId: "p-1",
      proposalType: "create",
      workspaceId: null,
      sessionId: null,
      projectId: null,
      agentUserId: null,
      sourceMessageId: null,
      data: proposalData(data),
    },
    payload: proposalData(data) as never,
    userId: "approver-1",
    input,
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps,
  });
}

const baseData = {
  profileSlug: "note",
  title: "Ada",
  description: "from capture",
  content: "body",
  properties: { name: "Beatrice", city: "Paris" },
};

beforeAll(() => {
  registerEntityExecutors();
});

beforeEach(() => {
  h.create.mockReset();
  h.update.mockReset();
  h.get.mockReset();
  h.attachFacet.mockReset();
  h.updates.length = 0;
  h.create.mockResolvedValue({ id: CREATED });
  h.update.mockResolvedValue({});
  h.get.mockResolvedValue({
    entity: {
      id: EXISTING,
      title: "Ada",
      description: "kept desc",
      properties: { name: "Ada", city: null },
    },
  });
});

describe("identityResolution schema", () => {
  it("keeps existingEntityId optional and rejects a non-uuid", () => {
    expect(identityResolutionInput.parse({ verb: "separate" })).toEqual({
      verb: "separate",
    });
    expect(
      identityResolutionInput.parse({ verb: "fill_empty" }).existingEntityId
    ).toBeUndefined();
    expect(() =>
      identityResolutionInput.parse({
        verb: "keep_existing",
        existingEntityId: "not-a-uuid",
      })
    ).toThrow();
  });
});

describe("planIdentityFields", () => {
  const existing: IdentityEntitySnapshot = {
    id: EXISTING,
    title: "Ada",
    description: "kept desc",
    content: null,
    documentId: null,
    properties: { name: "Ada", city: null, note: "   " },
  };

  it("fill_empty fills an empty key and reports the conflicting non-empty key", () => {
    const plan = planIdentityFields("fill_empty", existing, {
      title: "Ada",
      description: "incoming desc",
      content: "body",
      properties: { name: "Beatrice", city: "Paris", note: "hello" },
    });
    expect(plan.filled).toEqual(
      expect.arrayContaining(["content", "city", "note"])
    );
    expect(plan.filled).not.toContain("name");
    expect(plan.filled).not.toContain("description");
    expect(plan.conflicts).toEqual([
      { key: "description", kept: "kept desc", incoming: "incoming desc" },
      { key: "name", kept: "Ada", incoming: "Beatrice" },
    ]);
    expect(plan.properties).toEqual({
      city: "Paris",
      note: "hello",
      content: "body",
    });
    expect(plan.title).toBeUndefined();
    expect(plan.description).toBeUndefined();
  });

  it("use_capture overwrites a non-empty property and does not blank an empty proposed field", () => {
    const plan = planIdentityFields("use_capture", existing, {
      title: "Bea",
      description: "   ",
      content: "",
      properties: { name: "Beatrice", city: "", note: "   " },
    });
    expect(plan.title).toBe("Bea");
    expect(plan.description).toBeUndefined();
    expect(plan.properties).toEqual({ name: "Beatrice" });
    expect(plan.filled).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("treats a linked document as non-empty content and does not clear documentId", () => {
    const withDoc: IdentityEntitySnapshot = {
      ...existing,
      documentId: "44444444-4444-4444-8444-444444444444",
    };
    const fill = planIdentityFields("fill_empty", withDoc, {
      content: "replacement",
    });
    expect(fill.properties?.content).toBeUndefined();
    expect(fill.conflicts).toEqual([
      {
        key: "content",
        kept: withDoc.documentId,
        incoming: "replacement",
      },
    ]);
    const overwrite = planIdentityFields("use_capture", withDoc, {
      content: "replacement",
    });
    expect(overwrite.properties).toEqual({ content: "replacement" });
    expect(overwrite).not.toHaveProperty("documentId");
  });
});

describe("applyIdentityResolution", () => {
  it("requires existingEntityId for every verb except separate", async () => {
    await expect(
      applyIdentityResolution({
        resolution: { verb: "fill_empty" },
        proposed: {},
        load: async () => null,
        update: async () => ({}),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keep_existing does not update and does not leak a hidden id", async () => {
    const update = vi.fn();
    const kept = await applyIdentityResolution({
      resolution: { verb: "keep_existing", existingEntityId: EXISTING },
      proposed: { title: "ignored", properties: { name: "x" } },
      load: async () => ({
        id: EXISTING,
        title: "Ada",
        description: null,
        content: null,
        documentId: null,
        properties: {},
      }),
      update,
    });
    expect(update).not.toHaveBeenCalled();
    expect(kept).toEqual({
      forceCreate: false,
      receipt: { verb: "keep_existing", entityId: EXISTING },
    });

    const hidden = EXISTING;
    await expect(
      applyIdentityResolution({
        resolution: { verb: "keep_existing", existingEntityId: hidden },
        proposed: {},
        load: async () => {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Entity not found: ${hidden}`,
          });
        },
        update,
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Entity not found",
    });
  });

  it("separate is the only forceCreate and does not load", async () => {
    const load = vi.fn();
    const decision = await applyIdentityResolution({
      resolution: { verb: "separate", existingEntityId: EXISTING },
      proposed: { title: "Ada" },
      load,
      update: async () => ({}),
    });
    expect(decision).toEqual({ forceCreate: true });
    expect(load).not.toHaveBeenCalled();
  });
});

describe("entity/create executor", () => {
  it("throws the weak-dedup cause when no resolution is passed", async () => {
    h.create.mockRejectedValue(
      new TRPCError({
        code: "CONFLICT",
        message: "An entity named Ada already exists.",
        cause: buildWeakDedupCause([
          { id: CANDIDATE, title: "Ada", type: "note" },
        ]),
      })
    );
    await expect(run(baseData)).rejects.toMatchObject({
      code: "CONFLICT",
      cause: {
        code: "ENTITY_WEAK_DEDUP",
        candidates: [{ id: CANDIDATE, title: "Ada", type: "note" }],
      },
    });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0]?.[0].forceCreate).toBeUndefined();
    expect(h.updates).toHaveLength(0);
  });

  it("separate calls create with forceCreate true", async () => {
    const result = await run(baseData, {
      proposalId: "p-1",
      identityResolution: { verb: "separate" },
    });
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ forceCreate: true, title: "Ada" })
    );
    expect(result.identity).toEqual({ verb: "separate", entityId: CREATED });
    expect(h.get).not.toHaveBeenCalled();
  });

  it("keep_existing does not call create", async () => {
    const result = await run(baseData, {
      proposalId: "p-1",
      identityResolution: {
        verb: "keep_existing",
        existingEntityId: EXISTING,
      },
    });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(result.identity).toEqual({
      verb: "keep_existing",
      entityId: EXISTING,
    });
    const stamped = h.updates[0] as {
      data?: { materialized?: { entityIds?: string[] } };
    };
    expect(stamped.data?.materialized?.entityIds).toBeUndefined();
  });

  it("keep_existing hides an invisible entity id", async () => {
    h.get.mockRejectedValue(
      new TRPCError({
        code: "NOT_FOUND",
        message: `Entity not found: ${EXISTING}`,
      })
    );
    await expect(
      run(baseData, {
        proposalId: "p-1",
        identityResolution: {
          verb: "keep_existing",
          existingEntityId: EXISTING,
        },
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Entity not found",
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("fill_empty uses the helper: fills an empty key and returns the conflict", async () => {
    const entity = {
      id: EXISTING,
      title: "Ada",
      description: "kept desc",
      properties: { name: "Ada", city: null, note: "   " },
    };
    h.get.mockResolvedValue({ entity });
    const proposed = {
      title: "Ada",
      description: "incoming desc",
      content: "body",
      properties: { name: "Beatrice", city: "Paris", note: "hello" },
    };
    const result = await run(
      { profileSlug: "note", ...proposed },
      {
        proposalId: "p-1",
        identityResolution: {
          verb: "fill_empty",
          existingEntityId: EXISTING,
        },
      }
    );
    const plan = planIdentityFields(
      "fill_empty",
      snapshotFromApiEntity(entity),
      proposed
    );
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: EXISTING,
        source: "system",
        properties: plan.properties,
      })
    );
    expect(h.update.mock.calls[0]?.[0].description).toBeUndefined();
    expect(result.identity).toEqual({
      verb: "fill_empty",
      entityId: EXISTING,
      filled: plan.filled,
      conflicts: plan.conflicts,
    });
    expect(result.identity?.conflicts).toEqual(
      expect.arrayContaining([
        { key: "name", kept: "Ada", incoming: "Beatrice" },
      ])
    );
  });

  it("use_capture overwrites a non-empty property and does not blank an empty field", async () => {
    h.get.mockResolvedValue({
      entity: {
        id: EXISTING,
        title: "Ada",
        description: "old",
        properties: { name: "Ada", keep: "yes" },
      },
    });
    const result = await run(
      {
        profileSlug: "note",
        title: "Bea",
        description: "   ",
        content: "",
        properties: { name: "Beatrice", keep: "" },
      },
      {
        proposalId: "p-1",
        identityResolution: {
          verb: "use_capture",
          existingEntityId: EXISTING,
        },
      }
    );
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith({
      id: EXISTING,
      source: "system",
      title: "Bea",
      properties: { name: "Beatrice" },
    });
    expect(result.identity).toEqual({
      verb: "use_capture",
      entityId: EXISTING,
    });
  });
});

describe("composite materialize uses the same helper per ref", () => {
  const relationCaller = { create: vi.fn(async () => null) };

  it("does not apply one resolution to every op, and names opRef on the unresolved weak gate", async () => {
    const creates: Array<Record<string, unknown>> = [];
    await expect(
      materializeCompositeGraph(
        [
          {
            op: "create_entity",
            ref: "a",
            profileSlug: "note",
            title: "A",
          },
          {
            op: "create_entity",
            ref: "b",
            profileSlug: "note",
            title: "B",
          },
        ],
        {
          create: async (input) => {
            creates.push(input);
            if (input.title === "B") {
              throw new TRPCError({
                code: "CONFLICT",
                message: "An entity named B already exists.",
                cause: buildWeakDedupCause([
                  { id: CANDIDATE, title: "B", type: "note" },
                ]),
              });
            }
            return { id: CREATED };
          },
        },
        relationCaller,
        undefined,
        {
          identityResolutionByRef: { a: { verb: "separate" } },
        }
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: {
        code: "ENTITY_WEAK_DEDUP",
        opRef: "b",
        candidates: [expect.objectContaining({ id: CANDIDATE })],
      },
    });
    expect(creates).toHaveLength(2);
    expect(creates[0]?.forceCreate).toBe(true);
    expect(creates[1]?.forceCreate).toBeUndefined();
  });

  it("fill_empty on one ref updates that row and leaves the other create untouched", async () => {
    const creates: Array<Record<string, unknown>> = [];
    const updates: unknown[] = [];
    const result = await materializeCompositeGraph(
      [
        {
          op: "create_entity",
          ref: "a",
          profileSlug: "note",
          title: "From capture",
          properties: { city: "Paris", name: "Beatrice" },
        },
        {
          op: "create_entity",
          ref: "b",
          profileSlug: "note",
          title: "B",
        },
      ],
      {
        create: async (input) => {
          creates.push(input);
          return { id: CREATED };
        },
        get: async () => ({
          entity: {
            id: EXISTING,
            title: "",
            description: null,
            properties: { name: "Ada" },
          },
        }),
        update: async (patch) => {
          updates.push(patch);
          return {};
        },
      },
      relationCaller,
      undefined,
      {
        identityResolutionByRef: {
          a: { verb: "fill_empty", existingEntityId: EXISTING },
        },
      }
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]?.title).toBe("B");
    expect(creates[0]?.forceCreate).toBeUndefined();
    expect(updates).toEqual([
      expect.objectContaining({
        id: EXISTING,
        source: "system",
        title: "From capture",
        properties: { city: "Paris" },
      }),
    ]);
    expect(result.entities[0]?.identity).toMatchObject({
      verb: "fill_empty",
      entityId: EXISTING,
      ref: "a",
    });
    expect(result.entities[0]?.identity?.conflicts).toEqual([
      { key: "name", kept: "Ada", incoming: "Beatrice" },
    ]);
    expect(result.entities[0]?.linked).toBe(true);
    expect(result.entities[1]?.identity).toBeUndefined();
    expect(result.entities[1]?.entityId).toBe(CREATED);
  });

  it("honors entityRef so a filtered index is not guessed as the disposition key", async () => {
    const creates: Array<Record<string, unknown>> = [];
    await materializeCompositeGraph(
      [
        {
          op: "create_entity",
          profileSlug: "note",
          title: "Only",
        },
      ],
      {
        create: async (input) => {
          creates.push(input);
          return { id: CREATED };
        },
      },
      relationCaller,
      undefined,
      {
        identityResolutionByRef: {
          $op1: { verb: "separate" },
        },
        entityRef: () => "$op1",
      }
    );
    expect(creates[0]?.forceCreate).toBe(true);
  });
});

describe("source seams", () => {
  const createSrc = entitySrc.slice(
    entitySrc.indexOf('key: "entity/create"'),
    entitySrc.indexOf("entity / renderer.set")
  );

  it("the entity/create executor calls the helper and does not inline a second union", () => {
    expect(createSrc).toContain("applyIdentityResolution(");
    expect(createSrc).not.toContain("buildPropertyUnion");
    expect(createSrc).not.toContain("winnerValue");
    expect(createSrc).not.toMatch(/mergeEntities\s*\(/);
    expect(createSrc).toContain(
      "decision?.forceCreate ? { forceCreate: true }"
    );
    expect(helperSrc).not.toMatch(/mergeEntities\s*\(/);
  });

  it("approve uses the shared schema, not a second verb object", () => {
    expect(proposalsSrc).toContain(
      "identityResolution: identityResolutionInput.optional()"
    );
    expect(proposalsSrc).toContain(
      "identityResolutionByRef: identityResolutionByRefInput.optional()"
    );
    expect(proposalsSrc).toContain(
      "resolutions: identityResolutionByRefInput.optional()"
    );
  });

  it("batchApprove forwards resolutions[id] as identityResolution", () => {
    const start = proposalsSrc.indexOf("batchApprove: protectedProcedure");
    const end = proposalsSrc.indexOf("batchReject: protectedProcedure", start);
    const block = proposalsSrc.slice(start, end);
    expect(block).toContain(
      "const resolution = input.resolutions?.[proposalId]"
    );
    expect(block).toContain("identityResolution: resolution");
    expect(block).toContain("...weakDedupFailureFields(error)");
    expect(block).toContain(
      "resolutions: identityResolutionByRefInput.optional()"
    );
    expect(block).not.toContain("identityResolutionByRef:");
  });

  it("composite approve passes per-ref resolutions and does not copy one object onto every op", () => {
    expect(applySrc).toContain(
      "identityResolutionByRef: input.identityResolutionByRef"
    );
    expect(applySrc).toContain("entityRefByIndex");
    expect(applySrc).not.toContain(
      "identityResolution: input.identityResolution"
    );
  });

  it("hub REST passes identityResolution after rejecting an agent key", () => {
    const start = hubSrc.indexOf('app.post("/proposals/:id/approve"');
    const end = hubSrc.indexOf('app.post("/proposals/:id/reject"', start);
    const block = hubSrc.slice(start, end);
    expect(block.indexOf('rejectAgentReviewer(c, "approve")')).toBeGreaterThan(
      -1
    );
    expect(block.indexOf('rejectAgentReviewer(c, "approve")')).toBeLessThan(
      block.indexOf("readJsonBody")
    );
    expect(block).toContain("identityResolutionInput.safeParse");
    expect(block).toContain("identityResolution");
    expect(block).toMatch(/caller\.approve\(\{[\s\S]*identityResolution/);
  });
});
