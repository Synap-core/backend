/**
 * Hub `getDocument` (REST GET /documents/:id, MCP `synap_get_document`, the IS
 * `get_document`) for a document whose stored bytes are not text.
 *
 * 3 Nov 2026: reading stored videos (46-126 MB) froze the founder's pod. The
 * person read `documents.get` now leaves such bytes in storage and says so
 * (`contentOmitted`); this pins that the agent read carries that on, names
 * the Hub file door through a file entity the caller can read, and never
 * runs the markdown checks on the empty body.
 *
 * Driven through the real hub router; the person read, the caller context and
 * the file-entity lookup are stubbed (they have their own suites).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
  lookups: [] as Array<{ userId: string; doc: { id: string } }>,
  holder: "77777777-7777-4777-8777-777777777777" as string | null,
  diagnosticsRuns: 0,
}));

vi.mock("../../middleware/api-key-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../middleware/api-key-auth.js")>();
  const { t } =
    await vi.importActual<typeof import("../../trpc.js")>("../../trpc.js");
  return { ...actual, scopedProcedure: () => t.procedure };
});

vi.mock("../documents.js", () => ({
  documentsRouter: { createCaller: () => ({ get: async () => h.result }) },
}));

vi.mock("./utils.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHubProtocolCallerContext: async () => ({}),
}));

vi.mock("../../utils/stored-file-access.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readableFileEntityIdForDocument: async (
    userId: string,
    doc: { id: string }
  ) => {
    h.lookups.push({ userId, doc });
    return h.holder;
  },
}));

vi.mock(
  "../../services/document-patch/read-document.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../services/document-patch/read-document.js")
      >();
    return {
      ...actual,
      currentDiagnostics: async () => {
        h.diagnosticsRuns += 1;
        return { items: [] };
      },
    };
  }
);

import { documentsRouter as hubDocumentsRouter } from "./documents.js";

const USER = "11111111-1111-4111-8111-111111111111";
const DOC = "66666666-6666-4666-8666-666666666666";

const row = (type: string, mimeType: string | null) => ({
  id: DOC,
  userId: USER,
  title: "free-take-v1-draft.mp4",
  type,
  mimeType,
  language: null,
  workspaceId: null,
  metadata: {},
  contentRevision: 2,
  currentVersion: 2,
  scope: null,
  refreshAutomationId: null,
  updatedAt: "2026-10-31T00:00:00.000Z",
  createdAt: "2026-10-31T00:00:00.000Z",
});

const read = () =>
  hubDocumentsRouter
    .createCaller({ userId: USER, scopes: ["hub-protocol.read"] } as never)
    .getDocument({ documentId: DOC, userId: USER });

beforeEach(() => {
  h.lookups = [];
  h.diagnosticsRuns = 0;
  h.holder = "77777777-7777-4777-8777-777777777777";
});

describe("hub getDocument — a body left in storage", () => {
  it("says it was omitted and names the Hub file door of a readable file entity", async () => {
    h.result = {
      document: row("file", "video/mp4"),
      content: "",
      contentOmitted: "binary",
      fileUrlPath: `/api/files/documents/${DOC}/url`,
    };
    const { document } = await read();
    expect(document.content).toBe("");
    expect(document).toMatchObject({
      contentOmitted: "binary",
      fileUrlPath: "/api/hub/files/77777777-7777-4777-8777-777777777777/url",
      sections: [],
      diagnostics: null,
    });
    expect(h.lookups).toEqual([
      { userId: USER, doc: expect.objectContaining({ id: DOC }) },
    ]);
    expect(h.diagnosticsRuns).toBe(0);
  });

  it("no file entity the caller can read: the omission is still said, the door is null", async () => {
    h.holder = null;
    h.result = {
      document: row("file", "audio/wav"),
      content: "",
      contentOmitted: "binary",
    };
    const { document } = await read();
    expect(document).toMatchObject({
      contentOmitted: "binary",
      fileUrlPath: null,
    });
  });

  it("a markdown document reads as before: no omission, no lookup", async () => {
    h.result = { document: row("markdown", null), content: "# Plan" };
    const { document } = await read();
    expect(document.content).toBe("# Plan");
    expect(document).not.toHaveProperty("contentOmitted");
    expect(h.lookups).toEqual([]);
    expect(h.diagnosticsRuns).toBe(1);
  });
});
