import { describe, it, expect, beforeEach, vi } from "vitest";
import { type EventRepository } from "../event-repository.js";
import { TagRepository } from "../tag-repository.js";

// Mock the DB and EventRepository
const mockDb = {
  query: {
    tags: {
      findFirst: vi.fn(),
    },
  },
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
} as any;

describe("TagRepository", () => {
  let tagRepo: TagRepository;
  let mockEventRepo: EventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventRepo = {
      append: vi.fn(),
    } as any;

    // Setup chainable mocks
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ id: "tag-1", name: "Test", color: "#blue" }]),
      }),
    });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue([
              { id: "tag-1", name: "Updated", color: "#red" },
            ]),
        }),
      }),
    });

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "tag-1" }]),
      }),
    });

    tagRepo = new TagRepository(mockDb, mockEventRepo);
  });

  describe("create", () => {
    it("should create tag and emit completed event", async () => {
      mockDb.query.tags.findFirst.mockResolvedValue(null); // No duplicate

      const tag = await tagRepo.create(
        {
          name: "Test",
          color: "#blue",
          userId: "user-1",
        },
        "user-1"
      );

      expect(tag.name).toBe("Test");
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "tags.create.completed",
          subjectId: "tag-1",
        })
      );
    });

    it("should throw if tag already exists", async () => {
      mockDb.query.tags.findFirst.mockResolvedValue({ id: "existing" });

      await expect(
        tagRepo.create(
          {
            name: "Test",
            color: "#blue",
            userId: "user-1",
          },
          "user-1"
        )
      ).rejects.toThrow(/Tag with name "Test" already exists/);
    });
  });

  describe("update", () => {
    it("should update tag and emit completed event", async () => {
      const updated = await tagRepo.update(
        "tag-1",
        {
          name: "Updated",
          color: "#red",
        },
        "user-1"
      );

      expect(updated.name).toBe("Updated");
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "tags.update.completed",
          subjectId: "tag-1",
        })
      );
    });
  });

  describe("delete", () => {
    it("should delete tag and emit completed event", async () => {
      await tagRepo.delete("tag-1", "user-1");

      expect(mockDb.delete).toHaveBeenCalled();
      expect(mockEventRepo.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "tags.delete.completed",
          subjectId: "tag-1",
        })
      );
    });
  });
});
