import { describe, it, expect, beforeEach, vi } from "vitest";
import { type EventRepository } from "../event-repository.js";
import { EntityRepository } from "../entity-repository.js";
import { ProfileResolutionService } from "../../services/profile-resolution-service.js";
import { PropertyIndexService } from "../../services/property-index-service.js";

const mockDb = {
  query: {
    entities: {
      findFirst: vi.fn(),
    },
  },
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
} as any;

describe("EntityRepository", () => {
  let entityRepo: EntityRepository;
  let mockEventRepo: EventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventRepo = {
      append: vi.fn(),
    } as any;

    // create()/update() resolve the profile and its effective properties
    // (ProfileResolutionService) and fire-and-forget index the properties
    // (PropertyIndexService) — both hit tables the mock db above doesn't
    // model (profiles, profile_workspace_access, property_defs, ...).
    // Stub them at the service boundary so the repository's own logic
    // (insert/update/delete + event emission) is what's under test here.
    vi.spyOn(
      ProfileResolutionService.prototype,
      "resolveProfile"
    ).mockResolvedValue({ id: "profile-1", slug: "note" } as any);
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEffectiveProperties"
    ).mockResolvedValue([]);
    vi.spyOn(
      PropertyIndexService.prototype,
      "indexEntityProperties"
    ).mockResolvedValue(undefined as any);
    vi.spyOn(PropertyIndexService.prototype, "reindexEntity").mockResolvedValue(
      undefined as any
    );

    mockDb.query.entities.findFirst = vi.fn();

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ id: "entity-1", title: "Test Entity" }]),
      }),
    });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue([{ id: "entity-1", title: "Updated Entity" }]),
        }),
      }),
    });

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "entity-1" }]),
      }),
    });

    entityRepo = new EntityRepository(mockDb, mockEventRepo);
  });

  describe("create", () => {
    it("should create entity and emit completed event", async () => {
      const result = await entityRepo.create(
        {
          title: "Test Entity",
          profileSlug: "note",
          workspaceId: "workspace-1",
          userId: "user-1",
        },
        "user-1"
      );

      expect(result.title).toBe("Test Entity");
      expect(mockDb.insert).toHaveBeenCalled();
      // Event `type` is `${subjectType}.${action}.${phase}` with subjectType
      // = "entity" (singular, as configured in EntityRepository's
      // `super(db, eventRepo, { subjectType: "entity", pluralName: "entities" })`
      // — `pluralName` is metadata only; BaseRepository.emitCompleted never
      // reads it).
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "entity.create.completed",
          subjectId: "entity-1",
          data: expect.objectContaining({
            title: "Test Entity",
            id: "entity-1",
          }),
        })
      );
    });

    // P1 guardrail (e): a project is a first-class `projects` TABLE row, never
    // an entity. The generic entity-create door must reject profileSlug
    // "project" (the pre-0151 ghost-project fossil door) BEFORE any insert.
    it("rejects a create resolving to the 'project' profile with the project-door guidance", async () => {
      vi.spyOn(
        ProfileResolutionService.prototype,
        "resolveProfile"
      ).mockResolvedValue({ id: "profile-project", slug: "project" } as any);

      await expect(
        entityRepo.create(
          {
            title: "Some Initiative",
            profileSlug: "project",
            workspaceId: "workspace-1",
            userId: "user-1",
          },
          "user-1"
        )
      ).rejects.toThrow(/Projects are not entities/);

      // Guard fires before the insert — no ghost row is written.
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("should update entity and emit completed event", async () => {
      mockDb.query.entities.findFirst.mockResolvedValue({
        id: "entity-1",
        workspaceId: "workspace-1",
        profileId: "profile-1",
        properties: {},
      });

      const updated = await entityRepo.update(
        "entity-1",
        {
          title: "Updated Entity",
        },
        "user-1"
      );

      expect(updated.title).toBe("Updated Entity");
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "entity.update.completed",
          subjectId: "entity-1",
          data: expect.objectContaining({
            title: "Updated Entity",
            id: "entity-1",
          }),
        })
      );
    });
  });

  describe("delete", () => {
    it("should delete entity and emit completed event", async () => {
      mockDb.query.entities.findFirst.mockResolvedValue({
        id: "entity-1",
        documentId: null,
      });

      await entityRepo.delete("entity-1", "user-1");

      expect(mockDb.delete).toHaveBeenCalled();
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "entity.delete.completed",
          subjectId: "entity-1",
          data: expect.objectContaining({
            id: "entity-1",
          }),
        })
      );
    });

    // Regression lock: the realtime bridge (`domain-event-bridge.ts`) drops
    // workspace-scoped `.completed` events that carry no `workspaceId` in
    // their data. The pre-delete row has it — the emit call must forward it
    // (and `type`) rather than the bare `{ id }` it used to send.
    it("carries workspaceId and type from the pre-delete snapshot so the realtime bridge doesn't drop it", async () => {
      mockDb.query.entities.findFirst.mockResolvedValue({
        id: "entity-1",
        documentId: null,
        workspaceId: "workspace-1",
        type: "note",
      });

      await entityRepo.delete("entity-1", "user-1");

      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "entity.delete.completed",
          subjectId: "entity-1",
          data: expect.objectContaining({
            id: "entity-1",
            workspaceId: "workspace-1",
          }),
        })
      );
    });
  });
});
