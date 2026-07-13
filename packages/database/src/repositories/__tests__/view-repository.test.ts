import { describe, it, expect, beforeEach, vi } from "vitest";
import { type EventRepository } from "../event-repository.js";
import { ViewRepository } from "../view-repository.js";

const mockDb = {
  query: {
    views: {
      findFirst: vi.fn(),
    },
  },
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
} as any;

describe("ViewRepository", () => {
  let viewRepo: ViewRepository;
  let mockEventRepo: EventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventRepo = {
      append: vi.fn(),
    } as any;

    // View repository logic often maps config -> metadata or similar.
    // We assume standard insert/update mocking for now.
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ id: "view-1", name: "Test View" }]),
      }),
    });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue([{ id: "view-1", name: "Updated View" }]),
        }),
      }),
    });

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "view-1" }]),
      }),
    });

    viewRepo = new ViewRepository(mockDb, mockEventRepo);
  });

  describe("create", () => {
    it("should create view and emit completed event", async () => {
      // "kanban" isn't a canvas (whiteboard/mindmap) or composite (bento)
      // type, so create() categorizes it as "structured" and requires
      // scopeProfileIds — see ViewRepository.create's category check.
      const view = await viewRepo.create(
        {
          name: "Test View",
          type: "kanban",
          workspaceId: "ws-1",
          config: {},
          scopeProfileIds: ["profile-1"],
          userId: "user-1",
        },
        "user-1"
      );

      expect(view.name).toBe("Test View");
      expect(mockDb.insert).toHaveBeenCalled();
      // Event `type` is `${subjectType}.${action}.${phase}` with subjectType
      // = "view" (singular, as configured in ViewRepository's
      // `super(db, eventRepo, { subjectType: "view" })`).
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "view.create.completed",
          subjectId: "view-1",
        })
      );
    });
  });

  describe("update", () => {
    it("should update view and emit completed event", async () => {
      const updated = await viewRepo.update(
        "view-1",
        {
          name: "Updated View",
        },
        "user-1"
      );

      expect(updated.name).toBe("Updated View");
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "view.update.completed",
        })
      );
    });

    it("persists a renderer type change", async () => {
      await viewRepo.update("view-1", { type: "masonry" }, "user-1");

      const updateChain = mockDb.update.mock.results[0]?.value as {
        set: ReturnType<typeof vi.fn>;
      };
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ type: "masonry" })
      );
    });
  });

  describe("delete", () => {
    it("should delete view and emit completed event", async () => {
      await viewRepo.delete("view-1", "user-1");
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "view.delete.completed",
        })
      );
    });
  });
});
