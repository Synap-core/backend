/**
 * The Kratos `/upload` door must refuse a session that is not a member of the
 * target workspace (it used to write into any workspaceId). Drives the REAL
 * route through Hono; only the DB boundary and auth are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  member: false,
  findFirst: vi.fn(),
  materialize: vi.fn(),
}));

vi.mock("@synap/storage", () => ({
  StorageUploadUnavailableError: class extends Error {},
  storage: { upload: vi.fn(), delete: vi.fn() },
}));
vi.mock("@synap/database", () => ({
  db: { query: { workspaceMembers: { findFirst: h.findFirst } } },
  eq: vi.fn(),
  and: vi.fn(),
  entities: {},
  documents: {},
  workspaceMembers: { workspaceId: "w", userId: "u" },
  eventRepository: {},
  EntityBodyService: class {},
  materializeEntity: h.materialize,
  resolveImportEntityPlacement: vi.fn(),
}));
vi.mock("@synap/database/schema", () => ({ channelContextItems: {} }));
vi.mock("@synap/auth", () => ({
  authMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set("userId", "user-1");
    await next();
  },
}));
vi.mock("../../access/guest-containment.js", () => ({
  refuseGuestSession: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { fileUploadApp } from "../file-upload.js";

const WS = "11111111-1111-4111-8111-111111111111";

function upload() {
  const form = new FormData();
  form.set("workspaceId", WS);
  form.set("file", new File(["hello"], "a.txt", { type: "text/plain" }));
  return fileUploadApp.request("/upload", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.findFirst.mockImplementation(async () =>
    h.member ? { id: "m" } : undefined
  );
});

describe("POST /upload workspace membership", () => {
  it("403s a non-member and writes nothing", async () => {
    h.member = false;
    const res = await upload();
    expect(res.status).toBe(403);
    expect(h.findFirst).toHaveBeenCalledTimes(1);
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it("lets a member past the gate (does not 403)", async () => {
    h.member = true;
    const res = await upload();
    expect(res.status).not.toBe(403);
    expect(h.findFirst).toHaveBeenCalledTimes(1);
  });
});
