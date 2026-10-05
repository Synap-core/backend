/**
 * Both Kratos upload lanes file the new entity into the project it was made
 * under (BRIEF-lens-model: an asset uploaded under a project's brand must not
 * land unfiled and vanish from that view). Drives the REAL routes through Hono
 * — buffered `POST /upload` and presigned `POST /uploads/finalize` — through
 * the REAL shared parser and entity half; asserts the projectId REACHES the
 * materializer's project-link option (whose `linkEntityToProject` is the one
 * belongs_to_project door, covered by its own tests).
 *
 * What this CANNOT see: the relation row itself (the materializer is mocked
 * at the DB boundary), and the Hub `/files` doors (they parse but do not file
 * a project — out of scope).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  materialize: vi.fn(),
  setBody: vi.fn(),
  storeFromPresigned: vi.fn(),
}));

const WS = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";

vi.mock("@synap/storage", () => ({
  StorageUploadUnavailableError: class extends Error {},
  storage: {
    upload: vi.fn(),
    delete: vi.fn(),
    getSignedUrl: vi.fn(async () => "u"),
  },
}));
vi.mock("@synap/database", () => {
  const chain = () => {
    const o: Record<string, unknown> = {};
    o.from = () => o;
    o.where = () => o;
    o.limit = async () => [{ id: "doc-1", storageKey: "k" }];
    return o;
  };
  return {
    db: {
      select: () => chain(),
      // The owner fallback of the write gate: the caller owns the space.
      query: { workspaces: { findFirst: async () => ({ ownerId: "user-1" }) } },
    },
    getWorkspaceMembership: async () => null,
    workspaces: { id: "id" },
    eq: vi.fn(),
    and: vi.fn(),
    entities: {},
    documents: { id: "id" },
    workspaceMembers: { workspaceId: "w", userId: "u" },
    eventRepository: {},
    EntityBodyService: class {
      setBody = h.setBody;
      deleteBody = vi.fn();
    },
    materializeEntity: h.materialize,
    resolveImportEntityPlacement: vi.fn(async () => WS),
  };
});
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
vi.mock("../file-upload-presign.js", () => ({
  requestPresignedUpload: vi.fn(),
  parsePresignedUploadKey: () => ({ workspaceId: WS }),
  storeDocumentFromPresignedUpload: h.storeFromPresigned,
}));

import { fileUploadApp } from "../file-upload.js";

function buffered(projectId?: string) {
  const form = new FormData();
  form.set("workspaceId", WS);
  form.set("profileSlug", "brand-asset");
  if (projectId !== undefined) form.set("projectId", projectId);
  form.set("file", new File(["png"], "logo.png", { type: "image/png" }));
  return fileUploadApp.request("/upload", { method: "POST", body: form });
}

function finalize(projectId?: string) {
  return fileUploadApp.request("/uploads/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      uploadToken: "tok",
      profileSlug: "brand-asset",
      ...(projectId !== undefined ? { projectId } : {}),
    }),
  });
}

/** The project the materializer was asked to file the entity into. */
const filedProject = () => h.materialize.mock.calls.at(-1)?.[1]?.projectId;

beforeEach(() => {
  vi.clearAllMocks();
  h.materialize.mockResolvedValue({ entity: { id: "ent-1" }, reused: false });
  h.setBody.mockResolvedValue({
    documentId: "doc-1",
    storageKey: "k",
    storageUrl: "u",
    size: 3,
  });
  h.storeFromPresigned.mockResolvedValue({
    ok: true,
    resumed: false,
    workspaceId: WS,
    mimeType: "video/mp4",
    filename: "launch.mp4",
    stored: {
      documentId: "doc-2",
      storageKey: "k2",
      storageUrl: "u2",
      size: 400,
      document: { id: "doc-2", storageKey: "k2" },
    },
  });
});

describe("upload lanes × project", () => {
  it("buffered /upload files the entity into the given project", async () => {
    const res = await buffered(P);
    expect(res.status).toBe(200);
    expect(h.materialize).toHaveBeenCalledTimes(1);
    expect(filedProject()).toBe(P);
  });

  it("presigned /uploads/finalize files the entity into the given project", async () => {
    const res = await finalize(P);
    expect(res.status).toBe(200);
    expect(h.materialize).toHaveBeenCalledTimes(1);
    expect(filedProject()).toBe(P);
  });

  it("no project ⇒ filed nowhere (both lanes)", async () => {
    expect((await buffered()).status).toBe(200);
    expect(filedProject()).toBeNull();
    expect((await finalize()).status).toBe(200);
    expect(filedProject()).toBeNull();
  });

  it("a malformed projectId is a 400 and writes nothing (both lanes)", async () => {
    expect((await buffered("not-a-uuid")).status).toBe(400);
    expect((await finalize("not-a-uuid")).status).toBe(400);
    expect(h.materialize).not.toHaveBeenCalled();
    expect(h.setBody).not.toHaveBeenCalled();
    expect(h.storeFromPresigned).not.toHaveBeenCalled();
  });
});
