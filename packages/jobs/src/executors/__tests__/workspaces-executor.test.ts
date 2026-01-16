import { describe, it, expect, vi, beforeEach } from "vitest";
import { workspacesHandler } from "../workspaces-executor.js";

// Mock dependencies
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock("@synap/database", () => {
  return {
    getDb: vi.fn(),
    EventRepository: vi.fn(),
    WorkspaceRepository: vi.fn().mockImplementation(() => ({
      create: mockCreate,
      update: mockUpdate,
      delete: mockDelete,
    })),
  };
});

describe("WorkspacesExecutor", () => {
  let mockStep: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStep = {
      run: vi.fn((_name, fn) => fn()),
    };
  });

  it("should handle create action", async () => {
    const event = {
      name: "workspaces.create.validated",
      data: {
        name: "Test WS",
        slug: "test-ws",
      },
      user: { userId: "user-1" },
    };

    const result = await workspacesHandler({ event, step: mockStep } as any);

    expect(mockStep.run).toHaveBeenCalledWith(
      "create-workspace",
      expect.any(Function)
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Test WS",
        ownerId: "user-1",
      }),
      "user-1"
    );
    expect(result).toEqual({ success: true, action: "create" });
  });

  it("should handle update action", async () => {
    const event = {
      name: "workspaces.update.validated",
      data: { id: "ws-1", name: "Updated" },
      user: { userId: "user-1" },
    };

    await workspacesHandler({ event, step: mockStep } as any);

    expect(mockStep.run).toHaveBeenCalledWith(
      "update-workspace",
      expect.any(Function)
    );
    expect(mockUpdate).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ name: "Updated" }),
      "user-1"
    );
  });

  it("should handle delete action", async () => {
    const event = {
      name: "workspaces.delete.validated",
      data: { id: "ws-1" },
      user: { userId: "user-1" },
    };

    await workspacesHandler({ event, step: mockStep } as any);

    expect(mockStep.run).toHaveBeenCalledWith(
      "delete-workspace",
      expect.any(Function)
    );
    expect(mockDelete).toHaveBeenCalledWith("ws-1", "user-1");
  });
});
