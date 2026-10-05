/**
 * The Kratos `/upload` door must refuse a session that cannot WRITE the target
 * workspace (it used to write into any workspaceId, then let viewers write and
 * refused owners with no member row). Drives the REAL route through Hono and the
 * REAL `assertWorkspaceWrite` floor; only the DB boundary and auth are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** The caller's member-row role, or null = no member row. */
  role: null as string | null,
  /** workspaces.owner_id of the target workspace. */
  ownerId: "someone-else",
  getMembership: vi.fn(),
  findWorkspace: vi.fn(),
  materialize: vi.fn(),
}));

vi.mock("@synap/storage", () => ({
  StorageUploadUnavailableError: class extends Error {},
  storage: { upload: vi.fn(), delete: vi.fn() },
}));
vi.mock("@synap/database", () => ({
  db: { query: { workspaces: { findFirst: h.findWorkspace } } },
  getWorkspaceMembership: h.getMembership,
  workspaces: { id: "id" },
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
  h.role = null;
  h.ownerId = "someone-else";
  h.getMembership.mockImplementation(async () =>
    h.role ? { role: h.role } : null
  );
  h.findWorkspace.mockImplementation(async () => ({ ownerId: h.ownerId }));
});

describe("POST /upload workspace write gate", () => {
  it("403s a non-member and writes nothing", async () => {
    const res = await upload();
    expect(res.status).toBe(403);
    expect(h.getMembership).toHaveBeenCalledTimes(1);
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it("403s a VIEWER — read access is not write access", async () => {
    h.role = "viewer";
    const res = await upload();
    expect(res.status).toBe(403);
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it("lets an editor past the gate (does not 403)", async () => {
    h.role = "editor";
    const res = await upload();
    expect(res.status).not.toBe(403);
    expect(h.getMembership).toHaveBeenCalledTimes(1);
  });

  it("lets the workspace OWNER past the gate even with no member row", async () => {
    h.ownerId = "user-1";
    const res = await upload();
    expect(res.status).not.toBe(403);
    expect(h.findWorkspace).toHaveBeenCalledTimes(1);
  });
});
